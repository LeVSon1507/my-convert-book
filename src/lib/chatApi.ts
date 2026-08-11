export type ChatProvider = "grok" | "openai" | "gemini" | "openrouter" | "ollama" | "huggingface";

// Gemini's native generateContent endpoint takes the model in the URL path, not the body.
function buildGeminiRequest(
  baseUrl: string,
  apiKey: string,
  payload: object,
): { url: string; headers: Record<string, string>; body: unknown } {
  const { model, ...body } = payload as Record<string, unknown> & { model?: string };
  return {
    url: `${baseUrl}/models/${encodeURIComponent(model ?? "")}:generateContent`,
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body,
  };
}

/**
 * Calls the provider's chat endpoint directly — no CORS proxy indirection.
 * Safe to use both from the browser (Ollama is always local so it never needs the
 * proxy) and from server routes (no CORS concept server-side, so this is *always*
 * what backend translation jobs use).
 */
export async function callChatApiDirect(
  provider: string,
  baseUrl: string,
  apiKey: string,
  payload: object,
  signal: AbortSignal,
): Promise<Response> {
  if (provider === "ollama") {
    return fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify(payload),
    });
  }

  if (provider === "gemini") {
    const { url, headers, body } = buildGeminiRequest(baseUrl, apiKey, payload);
    return fetch(url, { method: "POST", headers, signal, body: JSON.stringify(body) });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  return fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, signal, body: JSON.stringify(payload) });
}

async function callChatApiViaProxy(
  provider: string,
  baseUrl: string,
  apiKey: string,
  payload: object,
  signal: AbortSignal,
): Promise<Response> {
  return fetch("/api/proxy-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ provider, baseUrl, apiKey, payload }),
  });
}

/**
 * Tries a direct cross-origin call first (cheaper, no proxy hop) and falls back to the
 * same-origin /api/proxy-chat route if the browser blocks it (CORS/network). Ollama is
 * always called directly since it's a local, same-machine server.
 */
export async function requestChatCompletions(
  provider: string,
  baseUrl: string,
  apiKey: string,
  payload: object,
  signal: AbortSignal,
  forceProxy = false,
): Promise<Response> {
  if (provider === "ollama") {
    return callChatApiDirect(provider, baseUrl, apiKey, payload, signal);
  }

  if (forceProxy) {
    try {
      return await callChatApiViaProxy(provider, baseUrl, apiKey, payload, signal);
    } catch {
      return callChatApiDirect(provider, baseUrl, apiKey, payload, signal);
    }
  }

  try {
    return await callChatApiDirect(provider, baseUrl, apiKey, payload, signal);
  } catch {
    return callChatApiViaProxy(provider, baseUrl, apiKey, payload, signal);
  }
}
