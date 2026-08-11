import {
  GEMINI_SAFETY_SETTINGS,
  ProviderId,
  extractAssistantText,
  getModelPricing,
  getRequestTimeoutMs,
} from "@/lib/providers";
import { getMaxTokensForTranslation } from "@/lib/cost";
import {
  buildTranslationUserPrompt,
  hasSevereRepetition,
  hasSevereSourceEcho,
  hasTruncatedOutput,
  postProcessTranslationOutput,
  splitChunkForContextRetry,
} from "@/lib/quality";

/**
 * Provider-agnostic "translate one chunk, with retries" core. Extracted from
 * translationStore.ts so backend translation jobs (src/app/api/translate/jobs/.../tick)
 * and the client-only path (Ollama, or anonymous/guest users) share the exact same
 * retry/quality/context-split logic instead of two copies drifting apart.
 *
 * Deliberately does NOT own the outer concurrency scheduler or checkpoint
 * persistence — those differ in shape between an in-browser array + Zustand `set()`
 * and a Firestore chunk-per-document job, so each caller keeps its own loop and
 * calls translateChunkWithRetry() per chunk.
 */

export type EngineParams = {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
  systemPrompt: string;
  glossaryInstruction: string;
};

export type UsageDelta = {
  promptTokens: number;
  completionTokens: number;
  cost: number;
};

export type CallApiFn = (
  provider: string,
  baseUrl: string,
  apiKey: string,
  payload: object,
  signal: AbortSignal,
) => Promise<Response>;

type ChatCompletionResponse = {
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    cost?: unknown;
  };
  usageMetadata?: {
    promptTokenCount?: unknown;
    candidatesTokenCount?: unknown;
  };
  message?: {
    content?: unknown;
  };
  choices?: unknown;
  output_text?: unknown;
};

type AttemptErrorResolution =
  | { action: "retry" }
  | { action: "split"; text: string };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildChatPayload(
  chunk: string,
  strictRetryMode: boolean,
  params: EngineParams,
): object {
  const { provider, model, temperature, systemPrompt, glossaryInstruction } =
    params;
  const messages = [
    { role: "system", content: `${systemPrompt}${glossaryInstruction}` },
    {
      role: "user",
      content: buildTranslationUserPrompt(chunk, strictRetryMode, true, {
        glossaryInstruction,
      }),
    },
  ];
  // Without an explicit max_tokens, nothing tells the model it's allowed to
  // write a long, single-shot response — some models (observed with Grok)
  // self-truncate a long translation and announce they'll "continue in the
  // next part" as if this were a multi-turn chat, even though there is no
  // next turn. Sized generously off the chunk itself so it's a safety net,
  // not a real constraint on a normal-length translation.
  const maxTokens = getMaxTokensForTranslation(chunk);

  if (provider === "ollama") {
    return {
      model,
      stream: false,
      keep_alive: "30m",
      options: {
        temperature,
        top_p: 0.9,
        repeat_penalty: strictRetryMode ? 1.18 : 1.12,
        num_predict: maxTokens,
      },
      messages,
    };
  }

  if (provider === "gemini") {
    return {
      model,
      contents: [{ role: "user", parts: [{ text: messages[1].content }] }],
      systemInstruction: { parts: [{ text: messages[0].content }] },
      safetySettings: GEMINI_SAFETY_SETTINGS,
      generationConfig: { temperature, maxOutputTokens: maxTokens },
    };
  }

  return {
    model,
    temperature,
    max_tokens: maxTokens,
    frequency_penalty: strictRetryMode ? 0.4 : 0.2,
    presence_penalty: 0,
    messages,
  };
}

async function requestChunkTranslation(
  payload: object,
  requestTimeoutMs: number,
  params: EngineParams,
  callApi: CallApiFn,
): Promise<Response> {
  const controller = new AbortController();
  let didTimeout = false;
  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, requestTimeoutMs);

  try {
    return await callApi(
      params.provider,
      params.baseUrl,
      params.apiKey,
      payload,
      controller.signal,
    );
  } catch (requestError) {
    if (didTimeout) {
      throw new Error(`Timeout sau ${(requestTimeoutMs / 1000).toFixed(0)}s`);
    }
    throw requestError;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readChatCompletionResponse(
  response: Response,
): Promise<ChatCompletionResponse> {
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorBody}`);
  }

  return (await response.json()) as ChatCompletionResponse;
}

/**
 * `usage.cost` only appears when the request opts into OpenRouter's
 * "usage: {include: true}" extension — we don't send that, and no other
 * provider's standard /chat/completions response includes cost at all. So
 * this field is never actually populated by any provider we call; compute
 * cost from the real token counts against our pricing table instead of
 * trusting a field that's silently always zero.
 */
function extractUsageDelta(
  responseData: ChatCompletionResponse,
  model: string,
): UsageDelta | null {
  const usage = responseData.usage;
  const usageMetadata = responseData.usageMetadata;
  if (!usage && !usageMetadata) return null;

  const promptTokens =
    Number(usage?.prompt_tokens ?? usageMetadata?.promptTokenCount) || 0;
  const completionTokens =
    Number(usage?.completion_tokens ?? usageMetadata?.candidatesTokenCount) ||
    0;
  if (promptTokens <= 0 && completionTokens <= 0) return null;

  const pricing = getModelPricing(model);
  const computedCost =
    (promptTokens / 1_000_000) * pricing.input +
    (completionTokens / 1_000_000) * pricing.output;
  const cost = Number(usage?.cost) || computedCost;

  return {
    promptTokens: Math.max(promptTokens, 0),
    completionTokens: Math.max(completionTokens, 0),
    cost: Math.max(cost, 0),
  };
}

function extractRawTranslationOutput(
  responseData: ChatCompletionResponse,
  provider: ProviderId,
): string {
  return provider === "ollama" &&
    typeof responseData.message?.content === "string"
    ? responseData.message.content
    : extractAssistantText(responseData);
}

async function translateChunkOnce(
  chunk: string,
  strictRetryMode: boolean,
  requestTimeoutMs: number,
  params: EngineParams,
  callApi: CallApiFn,
  onUsage?: (delta: UsageDelta) => void,
): Promise<string> {
  const payload = buildChatPayload(chunk, strictRetryMode, params);
  const response = await requestChunkTranslation(
    payload,
    requestTimeoutMs,
    params,
    callApi,
  );
  const responseData = await readChatCompletionResponse(response);

  const usageDelta = extractUsageDelta(responseData, params.model);
  if (usageDelta) onUsage?.(usageDelta);

  const translatedText = postProcessTranslationOutput(
    extractRawTranslationOutput(responseData, params.provider),
    chunk,
    strictRetryMode,
    true,
  );
  if (!translatedText) throw new Error("Phản hồi API không hợp lệ");

  return translatedText;
}

function getQualityRetryDelayMs(
  translatedText: string,
  sourceChunk: string,
  attempt: number,
  maxRetries: number,
): number | null {
  if (attempt >= maxRetries) return null;
  if (hasSevereSourceEcho(translatedText, sourceChunk)) return 600 * attempt;
  if (hasSevereRepetition(translatedText)) return 500 * attempt;
  if (hasTruncatedOutput(translatedText, sourceChunk)) return 500 * attempt;
  return null;
}

function isContextLengthError(
  status: number | undefined,
  message: string,
): boolean {
  return Boolean(
    status === 400 &&
    (message.includes("context") ||
      message.includes("too long") ||
      message.includes("maximum")),
  );
}

async function splitAndTranslateChunk(
  chunk: string,
  params: EngineParams,
  callApi: CallApiFn,
  onUsage?: (delta: UsageDelta) => void,
): Promise<string | null> {
  if (chunk.length <= 1000) return null;

  const splitPair = splitChunkForContextRetry(chunk);
  if (!splitPair) return null;

  const [left, right] = await Promise.all([
    translateChunkWithRetry(splitPair[0], 2, params, callApi, onUsage),
    translateChunkWithRetry(splitPair[1], 2, params, callApi, onUsage),
  ]);
  return [left, right].filter(Boolean).join("\n");
}

async function resolveTranslationAttemptError(
  translationError: unknown,
  attempt: number,
  maxRetries: number,
  chunk: string,
  params: EngineParams,
  callApi: CallApiFn,
  onUsage?: (delta: UsageDelta) => void,
): Promise<AttemptErrorResolution> {
  const status = getErrorStatus(translationError);
  const message = getErrorMessage(translationError);

  if (status === 429 && attempt < maxRetries) {
    await sleep(Math.min(5000 * 2 ** attempt, 30000) + Math.random() * 1000);
    return { action: "retry" };
  }

  if (isContextLengthError(status, message) && attempt < maxRetries) {
    const splitText = await splitAndTranslateChunk(
      chunk,
      params,
      callApi,
      onUsage,
    );
    if (splitText) return { action: "split", text: splitText };
  }

  if (attempt === maxRetries) throw translationError;

  await sleep(attempt * 2000);
  return { action: "retry" };
}

/**
 * Translates one source chunk end-to-end: builds the provider payload, calls the
 * API, retries on rate limits/quality issues/context-length errors (splitting the
 * chunk in half as a last resort), and returns the final translated text. Throws
 * only once every retry avenue is exhausted.
 */
export async function translateChunkWithRetry(
  chunk: string,
  maxRetries: number,
  params: EngineParams,
  callApi: CallApiFn,
  onUsage?: (delta: UsageDelta) => void,
): Promise<string> {
  const requestTimeoutMs = getRequestTimeoutMs(params.provider);
  let strictRetryMode = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const translatedText = await translateChunkOnce(
        chunk,
        strictRetryMode,
        requestTimeoutMs,
        params,
        callApi,
        onUsage,
      );
      const qualityRetryDelayMs = getQualityRetryDelayMs(
        translatedText,
        chunk,
        attempt,
        maxRetries,
      );
      if (qualityRetryDelayMs !== null) {
        strictRetryMode = true;
        await sleep(qualityRetryDelayMs);
        continue;
      }

      return translatedText;
    } catch (translationError) {
      const resolution = await resolveTranslationAttemptError(
        translationError,
        attempt,
        maxRetries,
        chunk,
        params,
        callApi,
        onUsage,
      );
      if (resolution.action === "split") return resolution.text;
    }
  }

  throw new Error("Không thể dịch đoạn này");
}
