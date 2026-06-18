export type ChatProvider = "grok" | "openai" | "gemini" | "openrouter" | "ollama" | "huggingface";

async function callChatApiDirect(
  provider: string,
  baseUrl: string,
  apiKey: string,
  payload: object,
  signal: AbortSignal,
): Promise<Response> {
  const isOllama = provider === "ollama";
  const targetUrl = isOllama ? `${baseUrl}/api/chat` : `${baseUrl}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!isOllama) headers.Authorization = `Bearer ${apiKey}`;

  return fetch(targetUrl, { method: "POST", headers, signal, body: JSON.stringify(payload) });
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
