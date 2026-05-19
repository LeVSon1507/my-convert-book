function formatHuggingFaceModelLabel(modelId) {
  if (!modelId) return "";
  const tail = String(modelId).split("/").pop() || String(modelId);
  return tail.replace(/[-_]+/g, " ").replace(/\b\w/g, function (c) {
    return c.toUpperCase();
  });
}

function isPreferredHuggingFaceModelId(modelId) {
  const id = String(modelId || "").toLowerCase();
  return (
    id.includes("dolphin") ||
    id.includes("uncensor") ||
    id.includes("uncensored")
  );
}

function getHuggingFaceFallbackModels() {
  return [
    {
      id: "Qwen/Qwen2.5-7B-Instruct",
      label: "Qwen 2.5 7B Instruct — fallback",
    },
    {
      id: "meta-llama/Llama-3.1-8B-Instruct",
      label: "Llama 3.1 8B Instruct — fallback",
    },
    { id: "google/gemma-4-31B-it", label: "Gemma 4 31B IT — fallback" },
  ];
}

async function ensureHuggingFaceModelsLoaded(force) {
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const shouldForce = Boolean(force);
  const now = Date.now();
  const activeProvider = getActiveProvider();
  const apiKey = document.getElementById("apiKey")?.value?.trim() || "";

  if (!apiKey) return PROVIDER_CONFIGS.huggingface.models;
  if (
    !shouldForce &&
    activeProvider === "huggingface" &&
    huggingFaceModels &&
    huggingFaceModels.length > 0 &&
    now - huggingFaceModelsLoadedAt < CACHE_TTL_MS
  ) {
    return huggingFaceModels;
  }

  try {
    const response = await fetch("https://router.huggingface.co/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) return PROVIDER_CONFIGS.huggingface.models;

    const payload = await response.json();
    const rawList = Array.isArray(payload?.data) ? payload.data : [];

    const normalized = rawList
      .map(function (item) {
        const id = String(item?.id || "").trim();
        if (!id) return null;
        const providerCount = Array.isArray(item?.providers)
          ? item.providers.length
          : 0;
        const preferred = isPreferredHuggingFaceModelId(id);
        return {
          id: id,
          label: `${formatHuggingFaceModelLabel(id)}${preferred ? " ⭐ uncensor" : ""}${providerCount ? ` · ${providerCount} provider` : ""}`,
          providerCount: providerCount,
          preferred: preferred,
        };
      })
      .filter(Boolean)
      .sort(function (a, b) {
        if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
        if (b.providerCount !== a.providerCount)
          return b.providerCount - a.providerCount;
        return a.id.localeCompare(b.id);
      })
      .slice(0, 200)
      .map(function (item) {
        return { id: item.id, label: item.label };
      });

    if (normalized.length > 0) {
      huggingFaceModels = normalized;
      huggingFaceModelsLoadedAt = now;
      PROVIDER_CONFIGS.huggingface.models = huggingFaceModels.concat([
        { id: "__custom__", label: "✏️ Nhập model ID..." },
      ]);
      const currentDefault = PROVIDER_CONFIGS.huggingface.defaultModel;
      const preferredDefault = huggingFaceModels.find(function (m) {
        return isPreferredHuggingFaceModelId(m.id);
      });
      const safeDefault = preferredDefault
        ? preferredDefault.id
        : huggingFaceModels[0].id;
      if (
        !currentDefault ||
        !huggingFaceModels.some(function (m) {
          return m.id === currentDefault;
        })
      ) {
        PROVIDER_CONFIGS.huggingface.defaultModel = safeDefault;
      } else if (
        preferredDefault &&
        !isPreferredHuggingFaceModelId(currentDefault)
      ) {
        PROVIDER_CONFIGS.huggingface.defaultModel = safeDefault;
      }
    }
  } catch {
    // Keep fallback model list if network fails.
  }

  return PROVIDER_CONFIGS.huggingface.models;
}

async function switchToSupportedHuggingFaceModel(failedModel) {
  await ensureHuggingFaceModelsLoaded(true);
  const models = PROVIDER_CONFIGS.huggingface.models || [];
  const candidates = models.filter(function (item) {
    return item.id && item.id !== "__custom__" && item.id !== failedModel;
  });
  const candidate =
    candidates.find(function (item) {
      return isPreferredHuggingFaceModelId(item.id);
    }) || candidates[0];
  if (!candidate) return null;

  const select = document.getElementById("modelSelect");
  const exists = Array.from(select.options).some(function (opt) {
    return opt.value === candidate.id;
  });
  if (exists) {
    select.value = candidate.id;
    onModelSelectChange(candidate.id);
  } else {
    document.getElementById("modelName").value = candidate.id;
  }
  return candidate.id;
}

function getOllamaFallbackModels() {
  return [
    {
      id: "dolphin-mistral:latest",
      label: "dolphin-mistral:latest — ưu tiên uncensor",
    },
    { id: "gemma3:4b", label: "gemma3:4b — fallback" },
  ];
}

function isPreferredOllamaModelId(modelId) {
  const id = String(modelId || "").toLowerCase();
  return (
    id.includes("dolphin") ||
    id.includes("uncensor") ||
    id.includes("uncensored")
  );
}

async function ensureOllamaModelsLoaded(force) {
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const shouldForce = Boolean(force);
  const now = Date.now();
  const baseUrl = (
    document.getElementById("baseUrl")?.value ||
    PROVIDER_CONFIGS.ollama.baseUrl ||
    ""
  )
    .trim()
    .replace(/\/$/, "");

  if (!baseUrl) return PROVIDER_CONFIGS.ollama.models;
  if (
    !shouldForce &&
    ollamaModels &&
    ollamaModels.length > 0 &&
    now - ollamaModelsLoadedAt < CACHE_TTL_MS
  ) {
    return ollamaModels;
  }

  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return PROVIDER_CONFIGS.ollama.models;
    const payload = await response.json();
    const rawList = Array.isArray(payload?.data) ? payload.data : [];
    const normalized = rawList
      .map(function (item) {
        const id = String(item?.id || "").trim();
        if (!id) return null;
        return {
          id: id,
          label: `${id}${isPreferredOllamaModelId(id) ? " ⭐ uncensor" : ""}`,
          preferred: isPreferredOllamaModelId(id),
        };
      })
      .filter(Boolean)
      .sort(function (a, b) {
        if (a.preferred !== b.preferred) return a.preferred ? -1 : 1;
        return a.id.localeCompare(b.id);
      })
      .slice(0, 200)
      .map(function (item) {
        return { id: item.id, label: item.label };
      });

    if (normalized.length > 0) {
      ollamaModels = normalized;
      ollamaModelsLoadedAt = now;
      PROVIDER_CONFIGS.ollama.models = ollamaModels.concat([
        { id: "__custom__", label: "✏️ Nhập model ID..." },
      ]);
      const preferredDefault = ollamaModels.find(function (item) {
        return isPreferredOllamaModelId(item.id);
      });
      PROVIDER_CONFIGS.ollama.defaultModel = preferredDefault
        ? preferredDefault.id
        : ollamaModels[0].id;
    }
  } catch {
    // Keep fallback list when Ollama is offline/unreachable.
  }

  return PROVIDER_CONFIGS.ollama.models;
}

globalThis.ensureOllamaModelsLoaded = ensureOllamaModelsLoaded;

globalThis.ensureHuggingFaceModelsLoaded = ensureHuggingFaceModelsLoaded;
globalThis.switchToSupportedHuggingFaceModel =
  switchToSupportedHuggingFaceModel;

async function callChatApiViaProxy(provider, baseUrl, apiKey, payload, signal) {
  const response = await fetch("/api/proxy-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: signal,
    body: JSON.stringify({
      provider: provider,
      baseUrl: baseUrl,
      apiKey: apiKey,
      payload: payload,
    }),
  });

  return response;
}

async function callChatApiDirect(provider, baseUrl, apiKey, payload, signal) {
  const isOllama = provider === "ollama";
  const targetUrl = isOllama
    ? `${baseUrl}/api/chat`
    : `${baseUrl}/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (!isOllama) headers.Authorization = `Bearer ${apiKey}`;

  return await fetch(targetUrl, {
    method: "POST",
    headers: headers,
    signal: signal,
    body: JSON.stringify(payload),
  });
}

async function requestChatCompletions(
  provider,
  baseUrl,
  apiKey,
  payload,
  signal,
) {
  if (provider === "ollama") {
    return callChatApiDirect(provider, baseUrl, apiKey, payload, signal);
  }

  const forceProxy = Boolean(getRuntimeConfig()?.useChatProxy);

  if (!forceProxy) {
    try {
      return await callChatApiDirect(
        provider,
        baseUrl,
        apiKey,
        payload,
        signal,
      );
    } catch (directError) {
      // If browser blocks direct cross-origin (CORS/network), try proxy fallback.
      return await callChatApiViaProxy(
        provider,
        baseUrl,
        apiKey,
        payload,
        signal,
      );
    }
  }

  try {
    return await callChatApiViaProxy(
      provider,
      baseUrl,
      apiKey,
      payload,
      signal,
    );
  } catch (proxyError) {
    // Fallback when proxy is unavailable.
    return await callChatApiDirect(provider, baseUrl, apiKey, payload, signal);
  }
}

function getOptimalChunkSize(model) {
  const limit = MODEL_CONTEXT_LIMITS[model] || 32000;
  // Reserve generous room for prompt + output, use ~15% context for one chunk
  const optimal = Math.floor(limit * 0.15);
  // Allow larger chunks to reduce request count and repeated prompt tokens
  return Math.max(3000, Math.min(optimal, 16000));
}

function getModelPricing(model) {
  if (openRouterPricingMap && openRouterPricingMap[model]) {
    return openRouterPricingMap[model];
  }
  return MODEL_PRICING[model] || { input: 0.1, output: 0.2 }; // conservative default
}

function normalizeChunkForCache(content) {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// Stable hash function for caching
async function hashContent(content) {
  const encoder = new TextEncoder();
  const data = encoder.encode(normalizeChunkForCache(content));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function shouldSkipTranslation(chunkText) {
  const text = (chunkText || "").trim();
  if (!text) return true;
  // Skip chunks that are mainly separators/punctuation/numbers
  const letters = text.match(/[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/g);
  return !letters || letters.length < 8;
}

function getMaxTokensForTranslation(chunkText) {
  const estimatedInputTokens = estimateTokenCount((chunkText || "").length);
  const softCap = Math.ceil(estimatedInputTokens * 1.35 + 120);
  return Math.min(12000, Math.max(300, softCap));
}

function getTailContext(text, maxChars) {
  if (!text) return "";
  if (text.length <= maxChars) return text;

  const sliceStart = text.length - maxChars;
  const boundary = text.indexOf("\n\n", sliceStart);
  if (boundary !== -1 && boundary < text.length - 200) {
    return text.slice(boundary + 2);
  }

  return text.slice(sliceStart);
}

function getMaxTokensForWriting(systemPrompt, userPrompt) {
  const modelName = getSelectedModel();
  const contextLimit = MODEL_CONTEXT_LIMITS[modelName] || 32000;
  const inputTokens = estimateTokenCount(
    (systemPrompt || "").length + (userPrompt || "").length,
  );
  const reservedTokens = Math.max(500, Math.floor(contextLimit * 0.12));
  const available = contextLimit - inputTokens - reservedTokens;
  const dynamicCap = Math.floor(available * 0.9);

  return Math.max(500, Math.min(3200, dynamicCap));
}

function extractAssistantText(responseData) {
  const directContent = responseData?.choices?.[0]?.message?.content;
  if (typeof directContent === "string" && directContent.trim())
    return directContent;
  if (Array.isArray(directContent)) {
    const joined = directContent
      .map(function (part) {
        return typeof part?.text === "string" ? part.text : "";
      })
      .join("")
      .trim();
    if (joined) return joined;
  }

  const altText = responseData?.choices?.[0]?.text;
  if (typeof altText === "string" && altText.trim()) return altText;

  const outputText = responseData?.output_text;
  if (typeof outputText === "string" && outputText.trim()) return outputText;

  return "";
}
