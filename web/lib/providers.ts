export type ModelOption = { id: string; label: string };

export type ProviderConfig = {
  baseUrl: string;
  defaultModel: string;
  hint: string;
  models: ModelOption[];
};

export type ProviderId =
  | "grok"
  | "openai"
  | "gemini"
  | "openrouter"
  | "ollama"
  | "huggingface";

export type ModelPricing = { input: number; output: number };

type OpenRouterModelInfo = {
  id?: unknown;
  pricing?: {
    prompt?: unknown;
    completion?: unknown;
  };
};

type OpenRouterModelsResponse = {
  data?: unknown;
};

type ChatContentPart = {
  text?: unknown;
};

type ChatResponseChoice = {
  message?: {
    content?: unknown;
  };
  text?: unknown;
};

type ChatResponseData = {
  choices?: unknown;
  output_text?: unknown;
};

function firstChoice(responseData: ChatResponseData): ChatResponseChoice | null {
  if (!Array.isArray(responseData.choices)) return null;
  const [choice] = responseData.choices;
  return choice && typeof choice === "object"
    ? (choice as ChatResponseChoice)
    : null;
}

export const OPENROUTER_MODEL_GROUPS: Record<
  string,
  { defaultModel: string; models: ModelOption[] }
> = {
  mistral_translation: {
    defaultModel: "mistralai/mistral-nemo",
    models: [
      {
        id: "mistralai/mistral-small-3.2-24b-instruct",
        label: "Mistral Small 3.2 24B — cân bằng (khuyên dùng)",
      },
      {
        id: "mistralai/mistral-nemo",
        label: "Mistral Nemo — rẻ nhất cho batch lớn",
      },
      {
        id: "mistralai/mistral-large-3-2512",
        label: "Mistral Large 3 — chất lượng cao hơn",
      },
      {
        id: "mistralai/mistral-small-creative",
        label: "Mistral Small Creative — truyện/roleplay",
      },
      {
        id: "thedrummer/cydonia-24b-v4.1",
        label: "Cydonia 24B v4.1 — hội thoại sáng tạo",
      },
      {
        id: "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
        label: "Dolphin Mistral 24B Venice (free)",
      },
      { id: "__custom__", label: "✏️ Nhập model ID..." },
    ],
  },
  grok_budget: {
    defaultModel: "x-ai/grok-4.3",
    models: [
      {
        id: "x-ai/grok-4.3",
        label: "Grok 4.3 — thay cho Grok 4.1/4 Fast (khuyên dùng)",
      },
      { id: "x-ai/grok-4.20", label: "Grok 4.20 — 2M context" },
      { id: "x-ai/grok-build-0.1", label: "Grok Build 0.1 — coding, rẻ hơn" },
      {
        id: "x-ai/grok-4.20-multi-agent",
        label: "Grok 4.20 Multi-Agent — nghiên cứu sâu",
      },
      {
        id: "thedrummer/cydonia-24b-v4.1",
        label: "Cydonia 24B v4.1 — hội thoại sáng tạo",
      },
      {
        id: "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
        label: "Dolphin Mistral 24B Venice (free)",
      },
      { id: "__custom__", label: "✏️ Nhập model ID..." },
    ],
  },
  other: {
    defaultModel: "deepseek/deepseek-v4-flash",
    models: [
      {
        id: "thedrummer/cydonia-24b-v4.1",
        label: "Cydonia 24B v4.1 — hội thoại sáng tạo",
      },
      {
        id: "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
        label: "Dolphin Mistral 24B Venice (free)",
      },
      { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "qwen/qwen3.6-flash", label: "Qwen 3.6 Flash" },
      { id: "__custom__", label: "✏️ Nhập model ID..." },
    ],
  },
};

export const PROVIDER_CONFIGS: Record<ProviderId, ProviderConfig> = {
  grok: {
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-3-mini",
    hint: "API key tại console.x.ai",
    models: [
      { id: "grok-3-mini", label: "Grok 3 Mini — nhanh, tiết kiệm" },
      { id: "grok-3-mini-fast", label: "Grok 3 Mini Fast — cực nhanh" },
      { id: "grok-3", label: "Grok 3 — ổn định cho tác vụ text" },
      { id: "grok-3-fast", label: "Grok 3 Fast — mạnh + nhanh" },
      { id: "__custom__", label: "✏️ Nhập model ID..." },
    ],
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    hint: "ChatGPT/OpenAI API key tại platform.openai.com/api-keys",
    models: [
      { id: "gpt-4o-mini", label: "GPT-4o Mini — nhanh, rẻ nhất" },
      { id: "gpt-4o", label: "GPT-4o — cân bằng tốc độ/chất lượng" },
      { id: "o4-mini", label: "o4 Mini — reasoning, tiết kiệm" },
      { id: "o3-mini", label: "o3 Mini — reasoning nhanh" },
      { id: "gpt-4-turbo", label: "GPT-4 Turbo — thế hệ trước" },
      { id: "__custom__", label: "✏️ Nhập model ID..." },
    ],
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-pro-preview-03-25",
    hint: "API key tại aistudio.google.com/app/apikey",
    models: [
      {
        id: "gemini-2.5-pro-preview-03-25",
        label: "Gemini 2.5 Pro — mạnh nhất Google",
      },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash — nhanh, miễn phí" },
      {
        id: "gemini-2.0-flash-lite",
        label: "Gemini 2.0 Flash Lite — cực nhanh",
      },
      { id: "gemini-1.5-pro", label: "Gemini 1.5 Pro — thế hệ trước" },
      { id: "__custom__", label: "✏️ Nhập model ID..." },
    ],
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "deepseek/deepseek-v4-flash",
    hint: "API key tại openrouter.ai/keys — dùng nhóm model Mistral/Grok rẻ",
    models: [
      {
        id: "mistralai/mistral-small-3.2-24b-instruct",
        label: "Mistral Small 3.2 24B — cân bằng (khuyên dùng)",
      },
      {
        id: "mistralai/mistral-nemo",
        label: "Mistral Nemo — rẻ nhất cho batch lớn",
      },
      {
        id: "mistralai/mistral-large-3-2512",
        label: "Mistral Large 3 — chất lượng cao hơn",
      },
      {
        id: "mistralai/mistral-small-creative",
        label: "Mistral Small Creative — truyện/roleplay",
      },
      { id: "x-ai/grok-4.3", label: "Grok 4.3 — thay cho Grok 4.1/4 Fast" },
      { id: "x-ai/grok-4.20", label: "Grok 4.20 — 2M context" },
      { id: "x-ai/grok-build-0.1", label: "Grok Build 0.1 — coding, rẻ hơn" },
      {
        id: "x-ai/grok-4.20-multi-agent",
        label: "Grok 4.20 Multi-Agent — nghiên cứu sâu",
      },
      { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro" },
      { id: "__custom__", label: "✏️ Nhập model ID..." },
    ],
  },
  ollama: {
    baseUrl: "http://localhost:11434",
    defaultModel: "dolphin-mistral:latest",
    hint: "Ollama local: không cần API key. Cho phép concurrency cao (tối đa 200 trong app), tự nạp model từ /v1/models, gọi chat qua /api/chat.",
    models: [
      {
        id: "dolphin-mistral:latest",
        label: "dolphin-mistral:latest — ưu tiên uncensor",
      },
      { id: "gemma3:4b", label: "gemma3:4b — fallback" },
      { id: "__custom__", label: "✏️ Nhập model ID..." },
    ],
  },
  huggingface: {
    baseUrl: "https://router.huggingface.co/v1",
    defaultModel: "Sao10K/L3-8B-Stheno-v3.2",
    hint: "Nhập Hugging Face token dạng hf_... App sẽ tự nạp model khả dụng theo key này.",
    models: [
      {
        id: "Sao10K/L3-8B-Stheno-v3.2",
        label: "Sao10K L3 8B Stheno v3.2 — default",
      },
      { id: "Sao10K/L3-70B-Euryale-v2.1", label: "Sao10K L3 70B Euryale v2.1" },
      { id: "Sao10K/L3-8B-Lunaris-v1", label: "Sao10K L3 8B Lunaris v1" },
      {
        id: "Qwen/Qwen2.5-7B-Instruct",
        label: "Qwen 2.5 7B Instruct — fallback",
      },
      {
        id: "meta-llama/Llama-3.1-8B-Instruct",
        label: "Llama 3.1 8B Instruct — fallback",
      },
      { id: "google/gemma-4-31B-it", label: "Gemma 4 31B IT — fallback" },
      { id: "__custom__", label: "✏️ Nhập model ID..." },
    ],
  },
};

export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "grok-3-mini": 128000,
  "grok-3-mini-fast": 128000,
  "grok-3": 128000,
  "grok-3-fast": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4o": 128000,
  "o4-mini": 200000,
  "o3-mini": 200000,
  "gpt-4-turbo": 128000,
  "gemini-2.5-pro-preview-03-25": 1000000,
  "gemini-2.0-flash": 1000000,
  "gemini-2.0-flash-lite": 1000000,
  "gemini-1.5-pro": 2000000,
  "mistralai/mistral-small-3.2-24b-instruct": 128000,
  "mistralai/mistral-nemo": 128000,
  "mistralai/mistral-large-3-2512": 262000,
  "mistralai/mistral-small-creative": 128000,
  "thedrummer/cydonia-24b-v4.1": 128000,
  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free": 128000,
  "deepseek/deepseek-v4-flash": 128000,
  "deepseek/deepseek-v4-pro": 128000,
  "qwen/qwen3.6-flash": 128000,
  "x-ai/grok-build-0.1": 256000,
  "x-ai/grok-4.3": 1000000,
  "x-ai/grok-4.20": 2000000,
  "x-ai/grok-4.20-multi-agent": 2000000,
  "Sao10K/L3-8B-Stheno-v3.2": 128000,
  "Sao10K/L3-70B-Euryale-v2.1": 128000,
  "Sao10K/L3-8B-Lunaris-v1": 128000,
  "Qwen/Qwen2.5-7B-Instruct": 128000,
  "meta-llama/Llama-3.1-8B-Instruct": 128000,
  "google/gemma-4-31B-it": 128000,
  "Qwen/Qwen3.6-35B-A3B": 128000,
  "deepseek-ai/DeepSeek-V4-Flash": 128000,
  "dolphin-mistral:latest": 32768,
  "gemma3:4b": 32768,
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "grok-3-mini": { input: 0.3, output: 0.5 },
  "grok-3-mini-fast": { input: 0.3, output: 0.5 },
  "grok-3": { input: 5, output: 15 },
  "grok-3-fast": { input: 5, output: 15 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gemini-2.5-pro-preview-03-25": { input: 1.25, output: 5 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.05, output: 0.2 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "mistralai/mistral-small-3.2-24b-instruct": { input: 0.075, output: 0.2 },
  "mistralai/mistral-nemo": { input: 0.02, output: 0.04 },
  "mistralai/mistral-large-3-2512": { input: 0.5, output: 1.5 },
  "mistralai/mistral-small-creative": { input: 0.1, output: 0.3 },
  "thedrummer/cydonia-24b-v4.1": { input: 0.5, output: 1 },
  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free": {
    input: 0,
    output: 0,
  },
  "deepseek/deepseek-v4-flash": { input: 0.25, output: 0.7 },
  "deepseek/deepseek-v4-pro": { input: 0.5, output: 1.5 },
  "qwen/qwen3.6-flash": { input: 0.2, output: 0.6 },
  "x-ai/grok-build-0.1": { input: 1, output: 2 },
  "x-ai/grok-4.3": { input: 1.25, output: 2.5 },
  "x-ai/grok-4.20": { input: 1.25, output: 2.5 },
  "x-ai/grok-4.20-multi-agent": { input: 2, output: 6 },
  "Sao10K/L3-8B-Stheno-v3.2": { input: 0.15, output: 0.45 },
  "Sao10K/L3-70B-Euryale-v2.1": { input: 0.25, output: 0.8 },
  "Sao10K/L3-8B-Lunaris-v1": { input: 0.15, output: 0.45 },
  "Qwen/Qwen2.5-7B-Instruct": { input: 0.1, output: 0.3 },
  "meta-llama/Llama-3.1-8B-Instruct": { input: 0.12, output: 0.35 },
  "google/gemma-4-31B-it": { input: 0.2, output: 0.6 },
  "Qwen/Qwen3.6-35B-A3B": { input: 0.25, output: 0.7 },
  "deepseek-ai/DeepSeek-V4-Flash": { input: 0.25, output: 0.7 },
  "dolphin-mistral:latest": { input: 0, output: 0 },
  "gemma3:4b": { input: 0, output: 0 },
};

let openRouterPricingMap: Record<string, ModelPricing> | null = null;
let openRouterPricingLoadedAt = 0;

export async function ensureOpenRouterPricingLoaded() {
  const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
  if (
    openRouterPricingMap &&
    Date.now() - openRouterPricingLoadedAt < CACHE_TTL_MS
  ) {
    return openRouterPricingMap;
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");
    if (!response.ok) return openRouterPricingMap;
    const payload = (await response.json()) as OpenRouterModelsResponse;
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const map: Record<string, ModelPricing> = {};

    data.forEach((item) => {
      if (!item || typeof item !== "object") return;
      const modelInfo = item as OpenRouterModelInfo;
      const id = typeof modelInfo.id === "string" ? modelInfo.id : "";
      const promptPerToken = Number(modelInfo.pricing?.prompt);
      const completionPerToken = Number(modelInfo.pricing?.completion);
      if (
        !id ||
        !Number.isFinite(promptPerToken) ||
        !Number.isFinite(completionPerToken)
      )
        return;

      map[id] = {
        input: promptPerToken * 1000000,
        output: completionPerToken * 1000000,
      };
    });

    if (Object.keys(map).length > 0) {
      openRouterPricingMap = map;
      openRouterPricingLoadedAt = Date.now();
    }
  } catch {
    // Keep fallback static pricing if network fails.
  }

  return openRouterPricingMap;
}

export function getModelPricing(model: string): ModelPricing {
  if (openRouterPricingMap) {
    return openRouterPricingMap[model] || MODEL_PRICING[model] || { input: 0.1, output: 0.2 };
  }
  return MODEL_PRICING[model] || { input: 0.1, output: 0.2 };
}

export function getOptimalChunkSize(model: string): number {
  const limit = MODEL_CONTEXT_LIMITS[model] || 32000;
  const optimal = Math.floor(limit * 0.15);
  return Math.max(3000, Math.min(optimal, 16000));
}

export function getRequestTimeoutMs(provider: string): number {
  if (provider === "ollama") return 180000;
  if (provider === "openrouter") return 150000;
  return 90000;
}

export function getOllamaEffectiveConcurrency(
  desiredConcurrency: number,
  completedCount: number,
): number {
  if (desiredConcurrency <= 4) return desiredConcurrency;
  if (completedCount < 4) return Math.min(desiredConcurrency, 2);
  if (completedCount < 12) return Math.min(desiredConcurrency, 4);
  if (completedCount < 24) return Math.min(desiredConcurrency, 8);
  if (completedCount < 48) return Math.min(desiredConcurrency, 16);
  if (completedCount < 96) return Math.min(desiredConcurrency, 32);
  return desiredConcurrency;
}

export function extractAssistantText(responseData: unknown): string {
  if (!responseData || typeof responseData !== "object") return "";
  const parsed = responseData as ChatResponseData;
  const choice = firstChoice(parsed);
  const directContent = choice?.message?.content;
  if (typeof directContent === "string" && directContent.trim())
    return directContent;
  if (Array.isArray(directContent)) {
    const joined = directContent
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const contentPart = part as ChatContentPart;
        return typeof contentPart.text === "string" ? contentPart.text : "";
      })
      .join("")
      .trim();
    if (joined) return joined;
  }

  const altText = choice?.text;
  if (typeof altText === "string" && altText.trim()) return altText;

  const outputText = parsed.output_text;
  if (typeof outputText === "string" && outputText.trim()) return outputText;

  return "";
}

function normalizeChunkForCache(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(normalizeChunkForCache(content));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function shouldSkipTranslation(chunkText: string): boolean {
  const text = (chunkText || "").trim();
  if (!text) return true;
  const letters = text.match(/[A-Za-zÀ-ɏḀ-ỿ一-鿿㐀-䶿぀-ヿ가-힯Ѐ-ӿ]/g);
  return !letters || letters.length < 8;
}

export function getTailContext(text: string, maxChars: number): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;

  const sliceStart = text.length - maxChars;
  const boundary = text.indexOf("\n\n", sliceStart);
  if (boundary !== -1 && boundary < text.length - 200) {
    return text.slice(boundary + 2);
  }

  return text.slice(sliceStart);
}
