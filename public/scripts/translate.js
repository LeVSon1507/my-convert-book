function getRuntimeConfig() {
  return globalThis.TRANSLATOR_CONFIG || {};
}

let selectedFile = null;
let fileContent = "";
let translatedChunks = [];
let totalChunks = 0;
let completedChunks = 0;
let isStopped = false;
let startTime = null;
let originalFileName = "";
let isTranslationRunning = false;
let isAnalysisRunning = false;
let isWritingRunning = false;
let wakeLockSentinel = null;
let cacheHits = 0;
let cacheMisses = 0;
let lastResultText = "";
let isPreviewExpanded = false;
let isWritingOutputCollapsed = true;
let currentFileHash = "";
let openRouterPricingMap = null;
let openRouterPricingLoadedAt = 0;
let huggingFaceModelsLoadedAt = 0;
let huggingFaceModels = null;
let ollamaModelsLoadedAt = 0;
let ollamaModels = null;
let isProviderTabsCollapsed = false;
let usageStats = { promptTokens: 0, completionTokens: 0, totalCost: 0 };
let pendingResumeCheckpoint = null;
let activeAppMode = "translate";
const TRANSLATION_CHECKPOINT_PREFIX = "translation_checkpoint_v1:";
const TRANSLATION_HISTORY_KEY = "translation_history_v1";
let currentFirebaseUser = null;
let cloudHistory = [];

function hasActiveLongTask() {
  return isTranslationRunning || isAnalysisRunning || isWritingRunning;
}

function getActiveProvider() {
  return (
    document.querySelector("#providerTabs .tab.active")?.dataset?.provider ||
    "openrouter"
  );
}

function switchAppMode(mode) {
  activeAppMode = mode || "translate";
  document.querySelectorAll("#modeTabs .tab").forEach(function (tab) {
    tab.classList.toggle("active", tab.dataset.mode === activeAppMode);
  });
  document.querySelectorAll("[data-mode-section]").forEach(function (section) {
    section.style.display =
      section.dataset.modeSection === activeAppMode ? "block" : "none";
  });
  if (activeAppMode === "history") renderTranslationHistory();
}

function setProviderTabsCollapsed(collapsed) {
  isProviderTabsCollapsed = Boolean(collapsed);
  const tabs = document.getElementById("providerTabs");
  const btn = document.getElementById("providerTabsToggleBtn");
  if (!tabs || !btn) return;
  tabs.classList.toggle("provider-tabs-collapsed", isProviderTabsCollapsed);
  btn.textContent = isProviderTabsCollapsed
    ? "Chọn provider khác"
    : "Thu gọn tab";
}

function toggleProviderTabsCollapse() {
  setProviderTabsCollapsed(!isProviderTabsCollapsed);
}
globalThis.toggleProviderTabsCollapse = toggleProviderTabsCollapse;

function parseGlossaryInput(rawGlossaryText) {
  const lines = String(rawGlossaryText || "").split("\n");
  const pairs = [];
  lines.forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const arrow = trimmed.includes("=>")
      ? "=>"
      : trimmed.includes("->")
        ? "->"
        : null;
    if (!arrow) return;
    const parts = trimmed.split(arrow);
    if (parts.length < 2) return;
    const source = parts[0].trim();
    const target = parts.slice(1).join(arrow).trim();
    if (source && target) pairs.push({ source, target });
  });
  return pairs;
}

function buildGlossaryInstruction(glossaryPairs) {
  if (!glossaryPairs || glossaryPairs.length === 0) return "";
  const rows = glossaryPairs
    .map(function (pair) {
      return `- ${pair.source} => ${pair.target}`;
    })
    .join("\n");
  return `\n\nBắt buộc dùng glossary sau khi dịch tên riêng/địa danh/thuật ngữ:\n${rows}\n- Ưu tiên tuyệt đối các mapping trên.\n- Giữ nhất quán giữa mọi đoạn.`;
}

function resetUsageStats() {
  usageStats = { promptTokens: 0, completionTokens: 0, totalCost: 0 };
}

function recordUsageFromResponse(responseData) {
  const usage = responseData?.usage;
  if (!usage || typeof usage !== "object") return;

  const promptTokens = Number(usage.prompt_tokens || 0);
  const completionTokens = Number(usage.completion_tokens || 0);
  const cost = Number(usage.cost || 0);

  if (Number.isFinite(promptTokens) && promptTokens > 0) {
    usageStats.promptTokens += promptTokens;
  }
  if (Number.isFinite(completionTokens) && completionTokens > 0) {
    usageStats.completionTokens += completionTokens;
  }
  if (Number.isFinite(cost) && cost > 0) {
    usageStats.totalCost += cost;
  }
}

async function requestWakeLock(contextLabel) {
  if (!("wakeLock" in navigator)) return;
  if (!hasActiveLongTask()) return;
  if (wakeLockSentinel) return;

  try {
    wakeLockSentinel = await navigator.wakeLock.request("screen");
    wakeLockSentinel.addEventListener("release", function () {
      wakeLockSentinel = null;
      if (hasActiveLongTask()) {
        addLog(
          "⚠️ Wake Lock bị nhả (có thể do hệ thống), app sẽ cố xin lại khi quay lại foreground.",
          "warning",
        );
      }
    });
    addLog(
      `🔒 Bật giữ màn hình sáng (${contextLabel}) để giảm lỗi khi chạy nền trên mobile.`,
      "info",
    );
  } catch (wakeLockError) {
    addLog(`⚠️ Không bật được Wake Lock: ${wakeLockError.message}`, "warning");
  }
}

async function releaseWakeLockIfIdle() {
  if (hasActiveLongTask()) return;
  if (!wakeLockSentinel) return;

  try {
    await wakeLockSentinel.release();
  } catch {
    // Ignore release errors
  } finally {
    wakeLockSentinel = null;
  }
}

let hasBootstrappedApp = false;
function applyAdminConfig() {
  if (hasBootstrappedApp) return;
  hasBootstrappedApp = true;
  const config = getRuntimeConfig();
  const provider = config?.defaultProvider || "openrouter";
  switchProvider(provider);
  setProviderTabsCollapsed(true);
  const apiKey = config?.keys?.[provider] || "";
  if (apiKey) document.getElementById("apiKey").value = apiKey;
  if (config?.defaultModel) {
    const select = document.getElementById("modelSelect");
    const hasOption = Array.from(select.options).some(function (opt) {
      return opt.value === config.defaultModel;
    });
    if (hasOption) {
      select.value = config.defaultModel;
      onModelSelectChange(config.defaultModel);
    }
  }
  if (typeof updateWritingCostEstimation === "function") {
    updateWritingCostEstimation();
  }
  applySpeedPreset(DEFAULT_SPEED_PRESET, { silent: true, animate: false });
  switchAppMode("translate");
  renderTranslationHistory();
  if (typeof initFirebase === "function") {
    initFirebase();
  }
}
globalThis.bootApp = applyAdminConfig;
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", applyAdminConfig, {
    once: true,
  });
}
document.addEventListener(
  "visibilitychange",
  function handleVisibilityChange() {
    if (!hasActiveLongTask()) return;

    if (document.hidden) {
      addLog(
        "⚠️ App đang chạy nền. Trên mobile (đặc biệt iOS), hệ điều hành có thể tạm dừng network và làm request fail.",
        "warning",
      );
      return;
    }

    requestWakeLock("tab-visible-again");
  },
);
window.addEventListener("focus", function () {
  if (hasActiveLongTask()) {
    requestWakeLock("window-focus");
  }
});

const OPENROUTER_MODEL_GROUPS = {
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
      { id: "__custom__", label: "✏️ Nhập model ID..." },
    ],
  },
  grok_budget: {
    defaultModel: "x-ai/grok-4.1-fast",
    models: [
      { id: "x-ai/grok-4.1-fast", label: "Grok 4.1 Fast — Recommended" },
      { id: "x-ai/grok-4-fast", label: "Grok 4 Fast — cheap multimodal" },
      { id: "x-ai/grok-3-mini", label: "Grok 3 Mini — cheapest reasoning" },
      { id: "x-ai/grok-4.20", label: "Grok 4.20 — better quality" },
      { id: "__custom__", label: "✏️ Nhập model ID..." },
    ],
  },
};

const PROVIDER_CONFIGS = {
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
    defaultModel: "mistralai/mistral-small-3.2-24b-instruct",
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
      { id: "x-ai/grok-4.1-fast", label: "Grok 4.1 Fast — Recommended" },
      { id: "x-ai/grok-4-fast", label: "Grok 4 Fast — cheap multimodal" },
      { id: "x-ai/grok-3-mini", label: "Grok 3 Mini — cheapest reasoning" },
      { id: "x-ai/grok-4.20", label: "Grok 4.20 — better quality" },
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
    defaultModel: "Qwen/Qwen2.5-7B-Instruct",
    hint: "Nhập Hugging Face token dạng hf_... App sẽ tự nạp model khả dụng theo key này.",
    models: [
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

// Model context length limits (in characters, approximate)
const MODEL_CONTEXT_LIMITS = {
  // Grok
  "grok-3-mini": 128000,
  "grok-3-mini-fast": 128000,
  "grok-3": 128000,
  "grok-3-fast": 128000,
  // OpenAI
  "gpt-4o-mini": 128000,
  "gpt-4o": 128000,
  "o4-mini": 200000,
  "o3-mini": 200000,
  "gpt-4-turbo": 128000,
  // Gemini
  "gemini-2.5-pro-preview-03-25": 1000000,
  "gemini-2.0-flash": 1000000,
  "gemini-2.0-flash-lite": 1000000,
  "gemini-1.5-pro": 2000000,
  // OpenRouter Mistral + Grok curated
  "mistralai/mistral-small-3.2-24b-instruct": 128000,
  "mistralai/mistral-nemo": 128000,
  "mistralai/mistral-large-3-2512": 262000,
  "mistralai/mistral-small-creative": 128000,
  "x-ai/grok-4.1-fast": 2000000,
  "x-ai/grok-4-fast": 2000000,
  "x-ai/grok-4.20": 1000000,
  // Hugging Face dynamic model list (fallback context limits)
  "Qwen/Qwen2.5-7B-Instruct": 128000,
  "meta-llama/Llama-3.1-8B-Instruct": 128000,
  "google/gemma-4-31B-it": 128000,
  "Qwen/Qwen3.6-35B-A3B": 128000,
  "deepseek-ai/DeepSeek-V4-Flash": 128000,
  // Ollama local defaults
  "dolphin-mistral:latest": 32768,
  "gemma3:4b": 32768,
};

// Token pricing (USD per 1M tokens) - approximate rates
const MODEL_PRICING = {
  // Grok (via xAI direct)
  "grok-3-mini": { input: 0.3, output: 0.5 },
  "grok-3-mini-fast": { input: 0.3, output: 0.5 },
  "grok-3": { input: 5.0, output: 15.0 },
  "grok-3-fast": { input: 5.0, output: 15.0 },
  // OpenAI
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  // Gemini
  "gemini-2.5-pro-preview-03-25": { input: 1.25, output: 5.0 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  "gemini-2.0-flash-lite": { input: 0.05, output: 0.2 },
  "gemini-1.5-pro": { input: 1.25, output: 5.0 },
  // OpenRouter Mistral + Grok curated
  "mistralai/mistral-small-3.2-24b-instruct": { input: 0.075, output: 0.2 },
  "mistralai/mistral-nemo": { input: 0.02, output: 0.04 },
  "mistralai/mistral-large-3-2512": { input: 0.5, output: 1.5 },
  "mistralai/mistral-small-creative": { input: 0.1, output: 0.3 },
  "x-ai/grok-4.20": { input: 1.25, output: 2.5 },
  // Fallback values; app will auto-refresh live OpenRouter pricing when available.
  "x-ai/grok-4.1-fast": { input: 0.2, output: 0.5 },
  "x-ai/grok-4-fast": { input: 0.2, output: 0.5 },
  // Hugging Face routing varies by provider/hardware; conservative placeholders.
  "Qwen/Qwen2.5-7B-Instruct": { input: 0.1, output: 0.3 },
  "meta-llama/Llama-3.1-8B-Instruct": { input: 0.12, output: 0.35 },
  "google/gemma-4-31B-it": { input: 0.2, output: 0.6 },
  "Qwen/Qwen3.6-35B-A3B": { input: 0.25, output: 0.7 },
  "deepseek-ai/DeepSeek-V4-Flash": { input: 0.25, output: 0.7 },
  // Ollama runs local, cost is effectively infra/local compute.
  "dolphin-mistral:latest": { input: 0, output: 0 },
  "gemma3:4b": { input: 0, output: 0 },
};

async function ensureOpenRouterPricingLoaded() {
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
    const payload = await response.json();
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const map = {};

    data.forEach(function (modelInfo) {
      const id = modelInfo?.id;
      const promptPerToken = Number(modelInfo?.pricing?.prompt);
      const completionPerToken = Number(modelInfo?.pricing?.completion);
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

function getOptimalChunkSize(model) {
  const limit = MODEL_CONTEXT_LIMITS[model] || 32000;
  // Reserve generous room for prompt + output, use ~15% context for one chunk
  const optimal = Math.floor(limit * 0.15);
  // Allow larger chunks to reduce request count and repeated prompt tokens
  return Math.max(2000, Math.min(optimal, 12000));
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

function normalizeTranslatedText(text) {
  if (!text) return "";
  let output = text.trim();
  // Some providers still wrap in markdown fences; strip for cleaner export.
  output = output
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/, "");
  return output.trim();
}

// Caching system using localStorage
const CACHE_PREFIX = "translator_cache_";
const CACHE_VERSION = "1";
const STORY_ANALYSIS_CACHE_PREFIX = "story_analysis_cache_v1:";

function getCacheKey(chunkHash, model, provider) {
  return `${CACHE_PREFIX}${CACHE_VERSION}:${provider}:${model}:${chunkHash}`;
}

async function getCachedTranslation(
  chunkHash,
  model,
  provider,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
) {
  try {
    const key = getCacheKey(chunkHash, model, provider);
    const cached = localStorage.getItem(key);
    if (!cached) return null;

    const { translation, timestamp } = JSON.parse(cached);
    if (Date.now() - timestamp > maxAgeMs) {
      localStorage.removeItem(key);
      return null;
    }
    return translation;
  } catch (e) {
    console.warn("Cache read error:", e);
    return null;
  }
}

async function setCacheTranslation(chunkHash, model, provider, translation) {
  try {
    const key = getCacheKey(chunkHash, model, provider);
    const entry = {
      translation,
      timestamp: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch (e) {
    // Storage quota exceeded or disabled
    console.warn("Cache write error:", e);
  }
}

function getStoryAnalysisCacheKey(fileHash) {
  if (!fileHash) return "";
  return `${STORY_ANALYSIS_CACHE_PREFIX}${fileHash}`;
}

function getCachedStoryAnalysis(fileHash, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  try {
    const key = getStoryAnalysisCacheKey(fileHash);
    if (!key) return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed?.analysis || !parsed?.timestamp) return null;
    if (Date.now() - parsed.timestamp > maxAgeMs) {
      localStorage.removeItem(key);
      return null;
    }

    return String(parsed.analysis);
  } catch {
    return null;
  }
}

function setCachedStoryAnalysis(fileHash, analysis) {
  try {
    const key = getStoryAnalysisCacheKey(fileHash);
    if (!key || !analysis) return;
    localStorage.setItem(
      key,
      JSON.stringify({
        analysis,
        timestamp: Date.now(),
      }),
    );
  } catch {
    // Ignore localStorage quota errors.
  }
}

function estimateTokenCount(chars) {
  // Approximate: Vietnamese ~2.5 chars per token, English ~4 chars per token
  // Mixed text: use 3 as average
  return Math.ceil(chars / 3);
}

function estimateCost(chars, model, isInput = true) {
  const pricing = getModelPricing(model);
  const tokens = estimateTokenCount(chars);
  const rate = isInput ? pricing.input : pricing.output;
  return (tokens / 1000000) * rate;
}

function getTranslationScopePercent() {
  const raw = Number.parseInt(
    document.getElementById("translationScope")?.value,
    10,
  );
  if (!Number.isFinite(raw)) return 100;
  return Math.max(1, Math.min(100, raw));
}

function applyTranslationScope(chunks) {
  const scope = getTranslationScopePercent();
  if (scope >= 100) return chunks;
  const scopedCount = Math.max(1, Math.ceil(chunks.length * (scope / 100)));
  return chunks.slice(0, scopedCount);
}

function updateCostEstimation() {
  const fileInfoEl = document.getElementById("fileInfo");
  const costCard = document.getElementById("costEstimationCard");
  const costContent = document.getElementById("costEstimationContent");

  if (!fileContent || !fileInfoEl.classList.contains("visible")) {
    costCard.style.display = "none";
    return;
  }

  const model = getSelectedModel();
  const provider = getActiveProvider();
  const chunkSize =
    Number.parseInt(document.getElementById("chunkSize").value, 10) || 6000;
  const fullChunks = splitIntoChunks(fileContent, chunkSize);
  const chunks = applyTranslationScope(fullChunks);
  const totalChunks = chunks.length;
  const scopePercent = getTranslationScopePercent();
  const systemPrompt = document.getElementById("systemPrompt").value.trim();
  const glossaryPairs = parseGlossaryInput(
    document.getElementById("glossaryInput")?.value || "",
  );
  const glossaryInstruction = buildGlossaryInstruction(glossaryPairs);

  const promptOverheadChars =
    (systemPrompt + glossaryInstruction).length +
    "Dịch sang tiếng Việt, giữ nguyên format xuống dòng. Chỉ trả về bản dịch:\n\n"
      .length;
  const retryBufferFactor = 1.08;
  const outputExpansionFactor = 1.1;

  let estimatedInputChars = 0;
  let estimatedOutputChars = 0;

  chunks.forEach(function (chunk) {
    estimatedInputChars += chunk.length + promptOverheadChars;
    estimatedOutputChars += Math.ceil(chunk.length * outputExpansionFactor);
  });

  estimatedInputChars = Math.ceil(estimatedInputChars * retryBufferFactor);
  estimatedOutputChars = Math.ceil(estimatedOutputChars * retryBufferFactor);

  const totalInputTokens = estimateTokenCount(estimatedInputChars);
  const totalOutputTokens = estimateTokenCount(estimatedOutputChars);

  const inputCost = estimateCost(estimatedInputChars, model, true);
  const outputCost = estimateCost(estimatedOutputChars, model, false);
  const totalCost = inputCost + outputCost;

  const pricing = getModelPricing(model);
  const hasLowPricing = pricing.input < 0.5 && pricing.output < 1.0;
  const hasActualUsage =
    usageStats.promptTokens > 0 ||
    usageStats.completionTokens > 0 ||
    usageStats.totalCost > 0;
  const actualCost =
    usageStats.totalCost > 0
      ? usageStats.totalCost
      : estimateCost(usageStats.promptTokens * 3, model, true) +
        estimateCost(usageStats.completionTokens * 3, model, false);

  costContent.innerHTML = `
        <div class="cost-item">
          <span class="cost-label">📄 Tổng ký tự</span>
          <span class="cost-value">${fileContent.length.toLocaleString("vi-VN")}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">🎯 Phạm vi dịch</span>
          <span class="cost-value">${scopePercent}% ${scopePercent < 100 ? `(~${chunks.join("").length.toLocaleString("vi-VN")} ký tự)` : ""}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">🔢 Số đoạn dự kiến</span>
          <span class="cost-value">${totalChunks}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">📥 Token đầu vào (ước)</span>
          <span class="cost-value">${totalInputTokens.toLocaleString("vi-VN")}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">📤 Token đầu ra (ước)</span>
          <span class="cost-value">${totalOutputTokens.toLocaleString("vi-VN")}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">💰 Chi phí ước tính</span>
          <span class="cost-value highlight">$${totalCost.toFixed(4)} USD</span>
        </div>
        ${
          hasActualUsage
            ? `
        <div class="cost-item">
          <span class="cost-label">🧾 Token thực tế (đã chạy)</span>
          <span class="cost-value">${Math.round(usageStats.promptTokens).toLocaleString("vi-VN")} in · ${Math.round(usageStats.completionTokens).toLocaleString("vi-VN")} out</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">💳 Chi phí thực tế (đã chạy)</span>
          <span class="cost-value highlight">$${actualCost.toFixed(4)} USD</span>
        </div>
        `
            : ""
        }
        ${hasLowPricing ? `<div class="cost-note">✅ Model này có mức giá thấp, phù hợp dịch lớn</div>` : ""}
      `;

  costCard.style.display = "block";
}

function updateWritingCostEstimation() {
  const estimateEl = document.getElementById("writingCostEstimate");
  if (!estimateEl) return;

  if (!fileContent) {
    estimateEl.innerHTML = "⏳ Tải file để xem ước tính token viết tiếp.";
    return;
  }

  const model = getSelectedModel();
  const provider = getActiveProvider();
  const chunkCount =
    Number.parseInt(document.getElementById("writingChunkCount")?.value, 10) ||
    1;
  const safeChunkCount = Math.max(1, Math.min(100, chunkCount));
  const plotDirection =
    document.getElementById("plotDirection")?.value?.trim() || "";
  const isAnalysisEnabled = Boolean(
    document.getElementById("enableAnalysis")?.checked,
  );
  const budgets = getWritingContextBudgets(model);
  const { styleSample, lastChapter } = extractWritingContext(
    fileContent,
    budgets,
  );

  const estimatedAnalysisChars = isAnalysisEnabled
    ? cachedStoryAnalysis
      ? cachedStoryAnalysis.length
      : 4000
    : 0;
  const baseSystemPrompt = buildContinueWritingSystemPrompt(styleSample, null);
  const syntheticSystemPrompt =
    baseSystemPrompt +
    (estimatedAnalysisChars > 0
      ? `\n${"x".repeat(Math.min(estimatedAnalysisChars, 12000))}`
      : "");
  const firstUserPrompt = buildContinueWritingUserPrompt(
    lastChapter,
    plotDirection,
    "",
    0,
  );

  const inputPerChunk = estimateTokenCount(
    syntheticSystemPrompt.length + firstUserPrompt.length,
  );
  const tailCarryPerChunk = estimateTokenCount(budgets.previousTailLength);
  const estimatedTotalInput =
    inputPerChunk * safeChunkCount +
    Math.max(0, safeChunkCount - 1) * tailCarryPerChunk;

  const maxTokensPerChunk = getMaxTokensForWriting(
    syntheticSystemPrompt,
    firstUserPrompt,
  );
  const estimatedTotalOutput = maxTokensPerChunk * safeChunkCount;

  let analysisInputTokens = 0;
  let analysisOutputTokens = 0;
  if (isAnalysisEnabled && !cachedStoryAnalysis) {
    const analysisWindowChars = Math.min(fileContent.length, 60000);
    const analysisChunkCount = Math.ceil(analysisWindowChars / 6000);
    analysisInputTokens = estimateTokenCount(
      analysisWindowChars +
        analysisChunkCount * 900 +
        Math.floor(analysisWindowChars * 0.3),
    );
    analysisOutputTokens = Math.ceil(analysisInputTokens * 0.2);
  }

  const totalInputTokens = estimatedTotalInput + analysisInputTokens;
  const totalOutputTokens = estimatedTotalOutput + analysisOutputTokens;
  const totalInputChars = totalInputTokens * 3;
  const totalOutputChars = totalOutputTokens * 3;
  const inputCost = estimateCost(totalInputChars, model, true);
  const outputCost = estimateCost(totalOutputChars, model, false);
  const totalCost = inputCost + outputCost;
  const providerLabel = provider === "openrouter" ? "OpenRouter" : provider;
  const analysisLabel = isAnalysisEnabled
    ? cachedStoryAnalysis
      ? "bật (dùng cache)"
      : "bật (ước tính có gọi phân tích)"
    : "tắt";

  estimateEl.innerHTML = `
        💡 Viết tiếp (${safeChunkCount} đoạn) · model ${model}<br>
        Ước tính token: vào ~${totalInputTokens.toLocaleString("vi-VN")} · ra ~${totalOutputTokens.toLocaleString("vi-VN")} · trần mỗi đoạn ~${maxTokensPerChunk.toLocaleString("vi-VN")}<br>
        Ước tính chi phí: <strong>~$${totalCost.toFixed(4)}</strong> (in $${inputCost.toFixed(4)} + out $${outputCost.toFixed(4)}) · provider ${providerLabel} · phân tích ${analysisLabel}
      `;
}

function buildModelDropdown(provider) {
  const select = document.getElementById("modelSelect");
  const config = PROVIDER_CONFIGS[provider];
  let models = config.models;

  if (provider === "openrouter") {
    const groupSelect = document.getElementById("openrouterModelGroup");
    const groupKey = groupSelect?.value || "mistral_translation";
    models = OPENROUTER_MODEL_GROUPS[groupKey]?.models || config.models;
  }

  select.innerHTML = "";
  models.forEach(function (modelInfo) {
    const option = document.createElement("option");
    option.value = modelInfo.id;
    option.textContent = modelInfo.label;
    select.appendChild(option);
  });
  if (provider === "openrouter") {
    const groupSelect = document.getElementById("openrouterModelGroup");
    const groupKey = groupSelect?.value || "mistral_translation";
    const defaultGroupModel =
      OPENROUTER_MODEL_GROUPS[groupKey]?.defaultModel || config.defaultModel;
    select.value = defaultGroupModel;
  } else {
    select.value = config.defaultModel;
  }
  onModelSelectChange(select.value);
}

function onOpenRouterGroupChange() {
  const activeProvider = getActiveProvider();
  if (activeProvider === "openrouter") {
    buildModelDropdown("openrouter");
    ensureOpenRouterPricingLoaded().then(function () {
      if (fileContent) {
        updateCostEstimation();
        updateWritingCostEstimation();
      }
    });
  }
}

function onModelSelectChange(selectedValue) {
  const isCustom = selectedValue === "__custom__";
  document.getElementById("customModelGroup").style.display = isCustom
    ? "block"
    : "none";
  if (!isCustom) {
    document.getElementById("modelName").value = selectedValue;
  }
  // Update cost estimation when model changes
  if (fileContent) {
    updateCostEstimation();
    updateWritingCostEstimation();
  }
}

function getSelectedModel() {
  const selectValue = document.getElementById("modelSelect").value;
  if (selectValue === "__custom__") {
    return document.getElementById("modelName").value.trim();
  }
  return selectValue;
}

function updateApiKeyUiForProvider(provider) {
  const keyGroup = document.getElementById("apiKeyGroup");
  const keyInput = document.getElementById("apiKey");
  if (!keyGroup || !keyInput) return;

  const isOllama = provider === "ollama";
  keyGroup.style.display = isOllama ? "none" : "block";
  keyInput.placeholder = isOllama
    ? "Ollama local không cần API key"
    : "Nhập API key của bạn...";
}

function syncConcurrentInputLimitForProvider(provider) {
  const input = document.getElementById("concurrentRequests");
  if (!input) return;

  const maxForProvider = provider === "ollama" ? 200 : 50;
  input.max = String(maxForProvider);

  const current = Number.parseInt(input.value, 10);
  if (!Number.isFinite(current)) {
    input.value = provider === "ollama" ? "20" : "10";
    return;
  }
  if (current > maxForProvider) {
    input.value = String(maxForProvider);
  }
}

function switchProvider(provider) {
  const config = PROVIDER_CONFIGS[provider];
  const openrouterSubGroupEl = document.getElementById("openrouterSubGroup");
  document.getElementById("baseUrl").value = config.baseUrl;
  document.getElementById("modelHint").textContent = config.hint;
  openrouterSubGroupEl.style.display =
    provider === "openrouter" ? "block" : "none";
  buildModelDropdown(provider);
  loadSavedApiKey(provider);
  updateApiKeyUiForProvider(provider);
  syncConcurrentInputLimitForProvider(provider);

  if (provider === "openrouter") {
    ensureOpenRouterPricingLoaded().then(function () {
      if (fileContent) {
        updateCostEstimation();
        updateWritingCostEstimation();
      }
    });
  }
  if (provider === "huggingface") {
    ensureHuggingFaceModelsLoaded().then(function () {
      buildModelDropdown("huggingface");
      if (fileContent) {
        updateCostEstimation();
        updateWritingCostEstimation();
      }
    });
  }
  if (provider === "ollama") {
    ensureOllamaModelsLoaded().then(function () {
      buildModelDropdown("ollama");
      if (fileContent) {
        updateCostEstimation();
        updateWritingCostEstimation();
      }
    });
  }

  document.querySelectorAll("#providerTabs .tab").forEach(function (tab) {
    tab.classList.toggle("active", tab.dataset.provider === provider);
  });

  // Update cost estimation when provider changes
  if (fileContent) {
    updateCostEstimation();
    updateWritingCostEstimation();
  }
}

function toggleApiKeyVisibility() {
  const apiKeyInput = document.getElementById("apiKey");
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  document.getElementById("toggleApiKeyBtn").textContent = isPassword
    ? "🙈"
    : "👁";
}

function saveApiKey() {
  const provider = getActiveProvider();
  if (provider === "ollama") return;
  const apiKey = document.getElementById("apiKey").value.trim();
  if (!apiKey) return;
  localStorage.setItem("translator_api_key_" + provider, apiKey);
  const hint = document.getElementById("keySavedHint");
  hint.textContent = "✅ Đã lưu key cho " + provider + " vào browser.";
  hint.style.display = "block";
  if (provider === "huggingface") {
    ensureHuggingFaceModelsLoaded(true).then(function () {
      buildModelDropdown("huggingface");
    });
  }
}

async function saveApiKeyToAccount() {
  const provider = getActiveProvider();
  const apiKey = document.getElementById("apiKey").value.trim();
  if (!apiKey) return;
  const hint = document.getElementById("keySavedHint");
  if (!currentFirebaseUser || typeof cloudSaveApiKey !== "function") {
    hint.textContent = "⚠️ Cần đăng nhập account để lưu key lên cloud.";
    hint.style.display = "block";
    return;
  }
  const ok = await cloudSaveApiKey(provider, apiKey);
  hint.textContent = ok
    ? "☁️ Đã lưu key cho " + provider + " vào account."
    : "❌ Không lưu được key lên account.";
  hint.style.display = "block";
}

function clearApiKey() {
  const provider = getActiveProvider();
  if (provider === "ollama") return;
  localStorage.removeItem("translator_api_key_" + provider);
  document.getElementById("apiKey").value = "";
  const hint = document.getElementById("keySavedHint");
  hint.textContent = "🗑 Đã xóa key.";
  hint.style.display = "block";
  if (provider === "huggingface") {
    huggingFaceModels = getHuggingFaceFallbackModels();
    huggingFaceModelsLoadedAt = 0;
    PROVIDER_CONFIGS.huggingface.models = huggingFaceModels.concat([
      { id: "__custom__", label: "✏️ Nhập model ID..." },
    ]);
    PROVIDER_CONFIGS.huggingface.defaultModel = huggingFaceModels[0].id;
    buildModelDropdown("huggingface");
  }
  setTimeout(function () {
    hint.style.display = "none";
  }, 2000);
}

function loadSavedApiKey(provider) {
  if (provider === "ollama") {
    document.getElementById("apiKey").value = "";
    document.getElementById("keySavedHint").style.display = "none";
    return;
  }
  const configKey = getRuntimeConfig()?.keys?.[provider] || "";
  const savedKey = localStorage.getItem("translator_api_key_" + provider);
  const keyToUse = savedKey || configKey;
  const hint = document.getElementById("keySavedHint");
  if (keyToUse) {
    document.getElementById("apiKey").value = keyToUse;
    hint.textContent = savedKey
      ? "💾 Đã load key đã lưu cho " + provider
      : "🔑 Key từ cấu hình runtime";
    hint.style.display = "block";
  } else {
    document.getElementById("apiKey").value = "";
    hint.style.display = "none";
  }
  if (provider === "huggingface" && keyToUse) {
    ensureHuggingFaceModelsLoaded().then(function () {
      buildModelDropdown("huggingface");
    });
  }

  if (
    !savedKey &&
    currentFirebaseUser &&
    typeof cloudLoadApiKey === "function"
  ) {
    cloudLoadApiKey(provider).then(function (cloudKey) {
      if (!cloudKey) return;
      if (provider !== getActiveProvider()) return;
      const currentValue = document.getElementById("apiKey").value.trim();
      if (currentValue) return;
      document.getElementById("apiKey").value = cloudKey;
      hint.textContent = "☁️ Đã load key cloud cho " + provider + ".";
      hint.style.display = "block";
      if (provider === "huggingface") {
        ensureHuggingFaceModelsLoaded(true).then(function () {
          buildModelDropdown("huggingface");
        });
      }
    });
  }
}

function getTranslationCheckpointKey(
  fileHash,
  provider,
  model,
  chunkSize,
  scopePercent,
) {
  if (!fileHash || !provider || !model || !chunkSize) return "";
  return `${TRANSLATION_CHECKPOINT_PREFIX}${fileHash}:${provider}:${model}:${chunkSize}:${scopePercent || 100}`;
}

function getTranslationCheckpoint(
  fileHash,
  provider,
  model,
  chunkSize,
  scopePercent,
) {
  try {
    const key = getTranslationCheckpointKey(
      fileHash,
      provider,
      model,
      chunkSize,
      scopePercent,
    );
    if (!key) return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function setTranslationCheckpoint(
  fileHash,
  provider,
  model,
  chunkSize,
  scopePercent,
  payload,
) {
  try {
    const key = getTranslationCheckpointKey(
      fileHash,
      provider,
      model,
      chunkSize,
      scopePercent,
    );
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // ignore quota
  }
}

function clearTranslationCheckpoint(
  fileHash,
  provider,
  model,
  chunkSize,
  scopePercent,
) {
  try {
    const key = getTranslationCheckpointKey(
      fileHash,
      provider,
      model,
      chunkSize,
      scopePercent,
    );
    if (!key) return;
    localStorage.removeItem(key);
  } catch {
    // noop
  }
}

function getTranslationHistoryId(
  fileHash,
  provider,
  model,
  chunkSize,
  scopePercent,
) {
  if (!fileHash || !provider || !model || !chunkSize) return "";
  return `${fileHash}:${provider}:${model}:${chunkSize}:${scopePercent || 100}`;
}

function pushTranslationHistory(record) {
  try {
    const raw = localStorage.getItem(TRANSLATION_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed : [];
    const historyId = record?.historyId || "";
    if (historyId) {
      const existingIndex = list.findIndex(function (item) {
        return item?.historyId === historyId;
      });
      if (existingIndex >= 0) {
        list[existingIndex] = Object.assign({}, list[existingIndex], record);
        const updated = list.splice(existingIndex, 1)[0];
        list.unshift(updated);
      } else {
        list.unshift(record);
      }
    } else {
      list.unshift(record);
    }
    localStorage.setItem(
      TRANSLATION_HISTORY_KEY,
      JSON.stringify(list.slice(0, 40)),
    );
    if (activeAppMode === "history") {
      renderTranslationHistory();
    }
  } catch {
    // noop
  }
}

function findLocalHistoryItem(historyId) {
  try {
    const raw = localStorage.getItem(TRANSLATION_HISTORY_KEY);
    const list = Array.isArray(JSON.parse(raw || "[]"))
      ? JSON.parse(raw || "[]")
      : [];
    return (
      list.find(function (item) {
        return item?.historyId === historyId;
      }) || null
    );
  } catch {
    return null;
  }
}

function updateLocalProgressHistoryEntry(status) {
  if (!currentFileHash || !translatedChunks || translatedChunks.length === 0)
    return;
  const modelName = getSelectedModel();
  const provider = getActiveProvider();
  const chunkSize =
    Number.parseInt(document.getElementById("chunkSize").value, 10) || 6000;
  const scopePercent = getTranslationScopePercent();
  const checkpointKey = getTranslationCheckpointKey(
    currentFileHash,
    provider,
    modelName,
    chunkSize,
    scopePercent,
  );
  const historyId = getTranslationHistoryId(
    currentFileHash,
    provider,
    modelName,
    chunkSize,
    scopePercent,
  );
  const doneCount = translatedChunks.filter(Boolean).length;
  const normalizedStatus = status || "in_progress";
  pushTranslationHistory({
    historyId: historyId,
    checkpointKey: normalizedStatus === "completed" ? "" : checkpointKey,
    fileHash: currentFileHash,
    fileName: originalFileName || "unknown",
    provider: provider,
    model: modelName,
    chunkSize: chunkSize,
    scopePercent: scopePercent,
    totalChunks: totalChunks,
    completedChunks: doneCount,
    status: normalizedStatus,
    completedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

function renderTranslationHistory() {
  const listEl = document.getElementById("historyList");
  if (!listEl) return;
  let localList = [];
  try {
    const raw = localStorage.getItem(TRANSLATION_HISTORY_KEY);
    localList = Array.isArray(JSON.parse(raw || "[]"))
      ? JSON.parse(raw || "[]")
      : [];
  } catch {
    localList = [];
  }

  let html = "";

  if (currentFirebaseUser) {
    if (cloudHistory.length > 0) {
      html +=
        '<div class="history-section-label">☁️ Cloud — đồng bộ mọi thiết bị (' +
        cloudHistory.length +
        ")</div>" +
        cloudHistory
          .map(function (item) {
            const timeSource = item.updatedAt || item.completedAt;
            const when = timeSource?.seconds
              ? new Date(timeSource.seconds * 1000).toLocaleString("vi-VN")
              : "—";
            const chars = item.charCount
              ? item.charCount.toLocaleString("vi-VN") + " ký tự"
              : "";
            const cost = item.cost ? " · $" + item.cost.toFixed(4) : "";
            const progressText =
              Number(item.completedChunks) > 0 && Number(item.totalChunks) > 0
                ? ` · ${item.completedChunks}/${item.totalChunks} đoạn`
                : "";
            const isInProgress =
              item.status === "in_progress" ||
              (Number(item.completedChunks) > 0 &&
                Number(item.completedChunks) < Number(item.totalChunks || 0));
            const fn = hEsc(item.fileName || "unknown.txt");
            const id = item.id;
            return (
              '<div class="history-item">' +
              '<div class="history-item-info">' +
              '<div class="history-item-name" title="' +
              fn +
              '">' +
              fn +
              "</div>" +
              '<div class="history-item-meta">' +
              when +
              (item.model ? " · " + hEsc(item.model) : "") +
              progressText +
              "</div>" +
              (chars
                ? '<div class="history-item-meta">' + chars + cost + "</div>"
                : "") +
              "</div>" +
              '<div class="history-item-actions">' +
              '<button id="hist-dl-' +
              id +
              '" class="btn btn-secondary btn-sm" onclick="downloadCloudFile(\'' +
              id +
              "','" +
              fn +
              "')\">⬇️ Tải về</button>" +
              (isInProgress
                ? '<button class="btn btn-secondary btn-sm" onclick="resumeCloudHistoryItem(\'' +
                  id +
                  "')\">▶ Tiếp tục</button>"
                : "") +
              '<button class="btn btn-danger btn-sm" onclick="deleteCloudFile(\'' +
              id +
              "')\">🗑</button>" +
              "</div>" +
              "</div>"
            );
          })
          .join("");
    } else {
      html +=
        '<div class="history-empty">☁️ Chưa có bản dịch nào trên cloud.<br><small>Bản dịch sẽ tự động lưu sau khi hoàn thành.</small></div>';
    }
  }

  if (localList.length > 0) {
    html +=
      '<div class="history-section-label">💾 Chỉ trên thiết bị này</div>' +
      localList
        .map(function (item) {
          const when = new Date(item.completedAt).toLocaleString("vi-VN");
          const done = Number(item.completedChunks || 0);
          const total = Number(item.totalChunks || 0);
          const progressText =
            total > 0
              ? done > 0
                ? `${done}/${total} đoạn`
                : `${total} đoạn`
              : "—";
          const statusText =
            item.status === "in_progress" ? "⏸ Dở dang" : "✅ Hoàn tất";
          const canResume =
            item.status === "in_progress" &&
            item.checkpointKey &&
            done > 0 &&
            done < total;
          const canDownloadPartial =
            item.status === "in_progress" && item.checkpointKey && done > 0;
          const safeName = hEsc(item.fileName || "unknown");
          const hid = encodeURIComponent(item.historyId || "");
          return (
            '<div class="history-item">' +
            '<div class="history-item-info">' +
            '<div class="history-item-name">' +
            safeName +
            "</div>" +
            '<div class="history-item-meta">' +
            when +
            (item.model ? " · " + hEsc(item.model) : "") +
            "</div>" +
            '<div class="history-item-meta">' +
            progressText +
            " · " +
            statusText +
            "</div>" +
            "</div>" +
            '<div class="history-item-actions">' +
            (canDownloadPartial
              ? '<button class="btn btn-secondary btn-sm" onclick="downloadLocalHistoryPartial(\'' +
                hid +
                "')\">⬇️ Tải về</button>"
              : "") +
            (canResume
              ? '<button class="btn btn-secondary btn-sm" onclick="resumeLocalHistoryItem(\'' +
                hid +
                "')\">▶ Tiếp tục</button>"
              : "") +
            "</div>" +
            "</div>"
          );
        })
        .join("");
  }

  if (!html) {
    html =
      '<div class="history-empty">Chưa có lịch sử dịch.<br><small>Dịch xong 1 đoạn là tiến độ sẽ xuất hiện tại đây.</small></div>';
  }
  listEl.innerHTML = html;
}

async function resumeCloudHistoryItem(docId) {
  if (!currentFirebaseUser || typeof cloudLoadResumeCheckpoint !== "function")
    return;
  try {
    const checkpoint = await cloudLoadResumeCheckpoint(docId);
    if (!checkpoint || !Array.isArray(checkpoint.translatedChunks)) {
      showError("Không tìm thấy checkpoint để tiếp tục.");
      return;
    }
    pendingResumeCheckpoint = checkpoint;
    switchAppMode("translate");
    const done = checkpoint.translatedChunks.filter(Boolean).length;
    const total = checkpoint.translatedChunks.length;
    const resumePromptEl = document.getElementById("resumePrompt");
    const promptTextEl = document.getElementById("resumePromptText");
    if (promptTextEl)
      promptTextEl.textContent = `Checkpoint cloud: đã dịch ${done}/${total} đoạn. Tiếp tục?`;
    if (resumePromptEl) resumePromptEl.style.display = "flex";
  } catch (e) {
    showError("Không thể tải checkpoint cloud: " + (e?.message || e));
  }
}

function downloadLocalHistoryPartial(historyId) {
  const item = findLocalHistoryItem(decodeURIComponent(historyId || ""));
  if (!item || !item.checkpointKey) return;
  try {
    const raw = localStorage.getItem(item.checkpointKey);
    if (!raw) return showError("Không còn dữ liệu checkpoint local để tải.");
    const parsed = JSON.parse(raw);
    const chunks = Array.isArray(parsed?.translatedChunks)
      ? parsed.translatedChunks.filter(Boolean)
      : [];
    if (!chunks.length)
      return showError("Checkpoint local chưa có nội dung dịch.");
    const baseName = (item.fileName || "translated_partial").replace(
      /\.[^.]+$/,
      "",
    );
    exportAs(
      chunks,
      `${baseName}_partial_${chunks.length}chunks_vietnamese`,
      "txt",
    );
  } catch (e) {
    showError("Không thể tải bản dịch local: " + (e?.message || e));
  }
}

function resumeLocalHistoryItem(historyId) {
  const item = findLocalHistoryItem(decodeURIComponent(historyId || ""));
  if (!item || !item.checkpointKey) return;
  try {
    const raw = localStorage.getItem(item.checkpointKey);
    if (!raw) return showError("Không còn checkpoint local để tiếp tục.");
    const parsed = JSON.parse(raw);
    const chunks = Array.isArray(parsed?.translatedChunks)
      ? parsed.translatedChunks
      : [];
    if (!chunks.length) return showError("Checkpoint local trống.");
    pendingResumeCheckpoint = {
      translatedChunks: chunks,
      totalChunks: Number(parsed?.totalChunks) || chunks.length,
    };
    switchAppMode("translate");
    const done = chunks.filter(Boolean).length;
    const total = chunks.length;
    const resumePromptEl = document.getElementById("resumePrompt");
    const promptTextEl = document.getElementById("resumePromptText");
    if (promptTextEl)
      promptTextEl.textContent = `Checkpoint local: đã dịch ${done}/${total} đoạn. Tiếp tục?`;
    if (resumePromptEl) resumePromptEl.style.display = "flex";
  } catch (e) {
    showError("Không thể đọc checkpoint local: " + (e?.message || e));
  }
}

function handleFileSelect(inputEl) {
  const file = inputEl.files[0];
  if (!file) return;
  loadFile(file);
}

function loadFile(file) {
  selectedFile = file;
  originalFileName = file.name;
  cachedStoryAnalysis = null;
  currentFileHash = "";
  resetUsageStats();
  const cacheHint = document.getElementById("analysisCacheHint");
  if (cacheHint) cacheHint.style.display = "none";

  const reader = new FileReader();
  reader.onload = async function (event) {
    fileContent = event.target.result;

    const sizeMB = (file.size / 1024 / 1024).toFixed(2);
    const charCount = fileContent.length.toLocaleString("vi-VN");

    const dropZone = document.getElementById("dropZone");
    dropZone.classList.add("has-file");
    dropZone.querySelector(".drop-icon").textContent = "✅";
    dropZone.querySelector(".drop-title").textContent = file.name;
    dropZone.querySelector(".drop-subtitle").textContent =
      `${sizeMB} MB · ${charCount} ký tự`;

    const fileInfo = document.getElementById("fileInfo");
    fileInfo.innerHTML = `
          <strong>${file.name}</strong> — ${sizeMB} MB (${charCount} ký tự) · 
          Ước tính ~${estimateChunks(fileContent.length)} đoạn cần dịch
        `;
    fileInfo.classList.add("visible");

    // Update cost estimation
    updateCostEstimation();
    updateWritingCostEstimation();

    try {
      currentFileHash = await hashContent(fileContent);
    } catch {
      currentFileHash = "";
    }

    pendingResumeCheckpoint = null;
    const resumePromptEl = document.getElementById("resumePrompt");
    if (resumePromptEl) resumePromptEl.style.display = "none";

    const modelName = getSelectedModel();
    const provider = getActiveProvider();
    const chunkSize =
      Number.parseInt(document.getElementById("chunkSize").value, 10) || 6000;
    const fullChunks = splitIntoChunks(fileContent, chunkSize);
    const currentChunks = applyTranslationScope(fullChunks);
    const scopePercent = getTranslationScopePercent();
    const checkpoint = getTranslationCheckpoint(
      currentFileHash,
      provider,
      modelName,
      chunkSize,
      scopePercent,
    );
    const translatedList = Array.isArray(checkpoint?.translatedChunks)
      ? checkpoint.translatedChunks
      : [];
    const doneCount = translatedList.filter(Boolean).length;
    if (
      checkpoint &&
      translatedList.length === currentChunks.length &&
      doneCount > 0 &&
      doneCount < currentChunks.length
    ) {
      pendingResumeCheckpoint = checkpoint;
      const promptTextEl = document.getElementById("resumePromptText");
      if (promptTextEl) {
        promptTextEl.textContent = `File này đã dịch ${doneCount}/${currentChunks.length} đoạn, tiếp tục từ đoạn ${doneCount + 1}?`;
      }
      if (resumePromptEl) resumePromptEl.style.display = "flex";
    }

    if (
      !pendingResumeCheckpoint &&
      currentFirebaseUser &&
      typeof cloudFindResumeCandidate === "function" &&
      typeof cloudLoadResumeCheckpoint === "function"
    ) {
      try {
        const cloudMeta = await cloudFindResumeCandidate(
          currentFileHash,
          provider,
          modelName,
          chunkSize,
          scopePercent,
        );
        if (cloudMeta) {
          const cloudCheckpoint = await cloudLoadResumeCheckpoint(cloudMeta.id);
          const cloudList = Array.isArray(cloudCheckpoint?.translatedChunks)
            ? cloudCheckpoint.translatedChunks
            : [];
          const cloudDone = cloudList.filter(Boolean).length;
          if (
            cloudList.length === currentChunks.length &&
            cloudDone > 0 &&
            cloudDone < currentChunks.length
          ) {
            pendingResumeCheckpoint = cloudCheckpoint;
            const promptTextEl = document.getElementById("resumePromptText");
            if (promptTextEl) {
              promptTextEl.textContent = `Cloud checkpoint: đã dịch ${cloudDone}/${currentChunks.length} đoạn, tiếp tục từ đoạn ${cloudDone + 1}?`;
            }
            if (resumePromptEl) resumePromptEl.style.display = "flex";
          }
        }
      } catch {
        // ignore cloud resume lookup errors
      }
    }

    const persistedAnalysis = getCachedStoryAnalysis(currentFileHash);
    if (persistedAnalysis) {
      cachedStoryAnalysis = persistedAnalysis;
      if (cacheHint) {
        cacheHint.textContent = " ✅ Đã có bản phân tích cache (sẽ dùng lại)";
        cacheHint.style.display = "inline";
      }
    }

    updateWritingCostEstimation();
  };
  reader.readAsText(file, "UTF-8");
}

function estimateChunks(charCount) {
  const chunkSize =
    Number.parseInt(document.getElementById("chunkSize").value, 10) || 6000;
  return Math.ceil(charCount / chunkSize);
}

function acceptResumeFromCheckpoint() {
  if (!pendingResumeCheckpoint) return;
  const resumePromptEl = document.getElementById("resumePrompt");
  if (resumePromptEl) resumePromptEl.style.display = "none";
  addLog('🧩 Sẽ tiếp tục từ checkpoint đã lưu khi bấm "Bắt đầu dịch".', "info");
}

function ignoreResumeCheckpoint() {
  pendingResumeCheckpoint = null;
  const resumePromptEl = document.getElementById("resumePrompt");
  if (resumePromptEl) resumePromptEl.style.display = "none";
  addLog("↺ Bỏ qua checkpoint cũ, sẽ dịch lại từ đầu.", "info");
}

function persistCurrentTranslationCheckpoint() {
  if (!currentFileHash || !translatedChunks || translatedChunks.length === 0)
    return;
  const modelName = getSelectedModel();
  const provider = getActiveProvider();
  const chunkSize =
    Number.parseInt(document.getElementById("chunkSize").value, 10) || 6000;
  const scopePercent = getTranslationScopePercent();
  setTranslationCheckpoint(
    currentFileHash,
    provider,
    modelName,
    chunkSize,
    scopePercent,
    {
      translatedChunks: translatedChunks,
      updatedAt: Date.now(),
      fileName: originalFileName,
    },
  );
  updateLocalProgressHistoryEntry("in_progress");
  if (
    currentFirebaseUser &&
    typeof cloudSaveTranslationProgress === "function"
  ) {
    cloudSaveTranslationProgress({
      fileHash: currentFileHash,
      fileName: originalFileName,
      provider: provider,
      model: modelName,
      chunkSize: chunkSize,
      scopePercent: scopePercent,
      totalChunks: totalChunks,
      translatedChunks: translatedChunks,
      status: "in_progress",
    });
  }
}

const dropZone = document.getElementById("dropZone");

dropZone.addEventListener("dragover", function (event) {
  event.preventDefault();
  dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", function () {
  dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", function (event) {
  event.preventDefault();
  dropZone.classList.remove("drag-over");
  const file = event.dataTransfer.files[0];
  if (file) {
    loadFile(file);
  }
});

function splitIntoChunks(text, chunkSize) {
  const chunks = [];
  let currentPos = 0;

  while (currentPos < text.length) {
    let endPos = currentPos + chunkSize;

    if (endPos < text.length) {
      // Try to break at paragraph boundary
      const paragraphBreak = text.lastIndexOf("\n\n", endPos);
      if (paragraphBreak > currentPos + chunkSize * 0.5) {
        endPos = paragraphBreak + 2;
      } else {
        // Try to break at sentence boundary
        const sentenceBreak = text.lastIndexOf(". ", endPos);
        if (sentenceBreak > currentPos + chunkSize * 0.5) {
          endPos = sentenceBreak + 2;
        } else {
          // Break at newline
          const newlineBreak = text.lastIndexOf("\n", endPos);
          if (newlineBreak > currentPos + chunkSize * 0.5) {
            endPos = newlineBreak + 1;
          }
        }
      }
    }

    chunks.push(text.slice(currentPos, endPos));
    currentPos = endPos;
  }

  return chunks;
}

function getRuntimeConcurrentRequests() {
  const concurrentInput = document.getElementById("concurrentRequests");
  const provider = getActiveProvider();
  const maxForProvider = provider === "ollama" ? 200 : 50;
  concurrentInput.max = String(maxForProvider);
  const rawValue = Number.parseInt(concurrentInput.value, 10);
  const normalizedValue = Number.isFinite(rawValue)
    ? Math.max(1, Math.min(maxForProvider, rawValue))
    : 1;
  concurrentInput.value = String(normalizedValue);
  return normalizedValue;
}

function getRequestTimeoutMs(provider) {
  if (provider === "ollama") {
    return 180000;
  }
  return 90000;
}

function getOllamaEffectiveConcurrency(desiredConcurrency, completedCount) {
  if (desiredConcurrency <= 4) {
    return desiredConcurrency;
  }
  if (completedCount < 4) return Math.min(desiredConcurrency, 2);
  if (completedCount < 12) return Math.min(desiredConcurrency, 4);
  if (completedCount < 24) return Math.min(desiredConcurrency, 8);
  if (completedCount < 48) return Math.min(desiredConcurrency, 16);
  if (completedCount < 96) return Math.min(desiredConcurrency, 32);
  return desiredConcurrency;
}

function resetCacheStats() {
  cacheHits = 0;
  cacheMisses = 0;
  updateCacheStatsUI();
}

function updateCacheStatsUI() {
  const cacheStatEl = document.getElementById("cacheStat");
  if (cacheStatEl) {
    if (cacheHits > 0 || cacheMisses > 0) {
      cacheStatEl.textContent = `Cache: ${cacheHits} hit, ${cacheMisses} miss`;
      cacheStatEl.style.display = "inline";
    } else {
      cacheStatEl.style.display = "none";
    }
  }
}

async function translateChunkWithRetry(
  chunk,
  chunkIndex,
  maxRetries,
  chunkHash = null,
  glossaryInstruction = "",
) {
  const apiKey = document.getElementById("apiKey").value.trim();
  let modelName = getSelectedModel();
  const provider = getActiveProvider();
  const baseUrl = document
    .getElementById("baseUrl")
    .value.trim()
    .replace(/\/$/, "");
  const baseSystemPrompt = document.getElementById("systemPrompt").value.trim();
  const systemPrompt = `${baseSystemPrompt}${glossaryInstruction || ""}`;
  const temperature = Number.parseFloat(
    document.getElementById("temperature").value,
  );
  const requestTimeoutMs = getRequestTimeoutMs(provider);

  const url = `${baseUrl}/chat/completions`;
  let currentChunk = chunk;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      let response;
      const controller = new AbortController();
      let didTimeout = false;
      const timeoutId = setTimeout(function () {
        didTimeout = true;
        controller.abort();
      }, requestTimeoutMs);

      try {
        if (provider === "ollama") {
          response = await fetch(`${baseUrl}/api/chat`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            signal: controller.signal,
            body: JSON.stringify({
              model: modelName,
              stream: false,
              keep_alive: "30m",
              options: {
                temperature: temperature,
                num_predict: getMaxTokensForTranslation(currentChunk),
              },
              messages: [
                { role: "system", content: systemPrompt },
                {
                  role: "user",
                  content: `Dịch sang tiếng Việt, giữ nguyên format xuống dòng. Chỉ trả về bản dịch:\n\n${currentChunk}`,
                },
              ],
            }),
          });
        } else {
          response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            signal: controller.signal,
            body: JSON.stringify({
              model: modelName,
              temperature: temperature,
              max_tokens: getMaxTokensForTranslation(currentChunk),
              messages: [
                { role: "system", content: systemPrompt },
                {
                  role: "user",
                  content: `Dịch sang tiếng Việt, giữ nguyên format xuống dòng. Chỉ trả về bản dịch:\n\n${currentChunk}`,
                },
              ],
            }),
          });
        }
      } catch (requestError) {
        if (didTimeout) {
          const timeoutError = new Error(
            `Timeout sau ${(requestTimeoutMs / 1000).toFixed(0)}s`,
          );
          timeoutError.code = "request_timeout";
          throw timeoutError;
        }
        throw requestError;
      } finally {
        clearTimeout(timeoutId);
      }

      if (!response.ok) {
        const errorBody = await response.text();
        let parsed = null;
        try {
          parsed = JSON.parse(errorBody);
        } catch {
          parsed = null;
        }
        const code = parsed?.error?.code;

        if (code === "model_not_supported") {
          if (provider === "huggingface" && attempt < maxRetries) {
            const fallbackModel =
              await switchToSupportedHuggingFaceModel(modelName);
            if (fallbackModel) {
              modelName = fallbackModel;
              addLog(
                `♻️ Hugging Face: chuyển model fallback sang "${fallbackModel}" sau lỗi model_not_supported.`,
                "warning",
              );
              continue;
            }
          }

          const unsupportedError = new Error(
            `Model "${modelName}" không hỗ trợ chat/completions với provider Hugging Face hiện tại. Hãy dùng model từ dropdown tự nạp.`,
          );
          unsupportedError.status = response.status;
          unsupportedError.code = code;
          throw unsupportedError;
        }

        if (code === "model_not_found") {
          const notFoundError = new Error(
            `Model "${modelName}" không tồn tại hoặc không khả dụng với provider hiện tại.`,
          );
          notFoundError.status = response.status;
          notFoundError.code = code;
          throw notFoundError;
        }

        const error = new Error(`HTTP ${response.status}: ${errorBody}`);
        error.status = response.status;
        error.code = code;
        throw error;
      }

      const responseData = await response.json();
      recordUsageFromResponse(responseData);
      const translatedText =
        provider === "ollama"
          ? normalizeTranslatedText(responseData?.message?.content || "")
          : normalizeTranslatedText(extractAssistantText(responseData));

      if (!translatedText) {
        throw new Error("Phản hồi API không hợp lệ");
      }

      // Cache the successful translation
      if (chunkHash) {
        await setCacheTranslation(
          chunkHash,
          modelName,
          provider,
          translatedText,
        );
      }

      return translatedText;
    } catch (translationError) {
      const isRateLimit = translationError.status === 429;
      const isContextError =
        translationError.status === 400 &&
        (translationError.message.includes("context") ||
          translationError.message.includes("too long") ||
          translationError.message.includes("maximum"));

      if (isRateLimit && attempt < maxRetries) {
        // Exponential backoff with jitter
        const baseDelay = Math.min(5000 * Math.pow(2, attempt), 30000);
        const jitter = Math.random() * 1000;
        addLog(
          `  ⚠ Đoạn ${chunkIndex + 1}: Rate limit, thử lại sau ${(baseDelay / 1000).toFixed(1)}s...`,
          "warning",
        );
        await sleep(baseDelay + jitter);
        continue;
      }

      if (
        isContextError &&
        currentChunk.length > 1000 &&
        attempt < maxRetries
      ) {
        // Trim chunk by 20% and retry
        const originalLength = currentChunk.length;
        currentChunk = currentChunk.slice(
          0,
          Math.floor(currentChunk.length * 0.8),
        );
        addLog(
          `  ⚠ Đoạn ${chunkIndex + 1}: Context quá dài (${originalLength}→${currentChunk.length}), thử lại...`,
          "warning",
        );
        continue;
      }

      if (translationError.code === "request_timeout" && attempt < maxRetries) {
        const timeoutRetryDelay = Math.min(2000 * attempt, 8000);
        addLog(
          `  ⚠ Đoạn ${chunkIndex + 1}: timeout, thử lại sau ${(
            timeoutRetryDelay / 1000
          ).toFixed(1)}s...`,
          "warning",
        );
        await sleep(timeoutRetryDelay);
        continue;
      }

      if (attempt === maxRetries) {
        throw translationError;
      }

      const retryDelay = attempt * 2000;
      addLog(
        `  ⚠ Đoạn ${chunkIndex + 1}: Thử lại (${attempt}/${maxRetries}) sau ${retryDelay}ms — ${translationError.message}`,
        "warning",
      );
      await sleep(retryDelay);
    }
  }
}

async function processChunksWithConcurrency(chunks, options) {
  const opts = options || {};
  const initialResults = Array.isArray(opts.initialResults)
    ? opts.initialResults
    : [];
  const glossaryInstruction = opts.glossaryInstruction || "";
  const results = new Array(chunks.length).fill(null);
  initialResults.forEach(function (val, idx) {
    if (idx < results.length && typeof val === "string" && val.trim())
      results[idx] = val;
  });
  let nextChunkIndex = results.findIndex(function (item) {
    return !item;
  });
  if (nextChunkIndex < 0) nextChunkIndex = chunks.length;
  let activeRequests = 0;
  let scheduleTimer = null;
  const provider = getActiveProvider();
  const model = getSelectedModel();

  // Reset cache stats for this translation run
  resetCacheStats();

  return new Promise(function (resolve) {
    function queueSchedule(delayMs) {
      if (scheduleTimer !== null) return;
      scheduleTimer = setTimeout(function () {
        scheduleTimer = null;
        schedule();
      }, delayMs);
    }

    function maybeResolve() {
      if (
        (isStopped || nextChunkIndex >= chunks.length) &&
        activeRequests === 0
      ) {
        resolve(results);
        return true;
      }
      return false;
    }

    async function launchChunk(currentIndex) {
      const chunk = chunks[currentIndex];
      activeRequests++;

      try {
        if (shouldSkipTranslation(chunk)) {
          results[currentIndex] = chunk;
          translatedChunks[currentIndex] = chunk;
          completedChunks++;
          updateProgress();
          addLog(`↷ Bỏ qua đoạn ${currentIndex + 1} (không cần dịch)`, "info");
          return;
        }

        // Check cache first
        const chunkHash = await hashContent(chunk);
        const cached = await getCachedTranslation(chunkHash, model, provider);

        if (cached) {
          cacheHits++;
          results[currentIndex] = cached;
          translatedChunks[currentIndex] = cached;
          completedChunks++;
          updateProgress();
          updateCacheStatsUI();
          persistCurrentTranslationCheckpoint();
          addLog(`✓ [CACHE] Đoạn ${currentIndex + 1}`, "success");
        } else {
          cacheMisses++;
          addLog(
            `▶ Đang dịch đoạn ${currentIndex + 1}/${chunks.length}...`,
            "info",
          );
          const translatedText = await translateChunkWithRetry(
            chunk,
            currentIndex,
            3,
            chunkHash,
            glossaryInstruction,
          );
          results[currentIndex] = translatedText;
          translatedChunks[currentIndex] = translatedText;
          completedChunks++;
          updateProgress();
          updateCacheStatsUI();
          persistCurrentTranslationCheckpoint();
          addLog(`✓ Hoàn thành đoạn ${currentIndex + 1}`, "success");
        }
        const delayMs =
          Number.parseInt(
            document.getElementById("delayBetweenChunks").value,
            10,
          ) || 0;
        if (delayMs > 0 && !isStopped) {
          await sleep(delayMs);
        }
      } catch (chunkError) {
        results[currentIndex] =
          `[LỖI DỊCH ĐOẠN ${currentIndex + 1}: ${chunkError.message}]\n\n${chunk}`;
        translatedChunks[currentIndex] = results[currentIndex];
        completedChunks++;
        updateProgress();
        persistCurrentTranslationCheckpoint();
        addLog(
          `✗ Lỗi đoạn ${currentIndex + 1}: ${chunkError.message}`,
          "error",
        );
      } finally {
        activeRequests--;
        schedule();
      }
    }

    function schedule() {
      if (maybeResolve()) return;

      const desiredConcurrency = getRuntimeConcurrentRequests();
      const effectiveConcurrency =
        provider === "ollama"
          ? getOllamaEffectiveConcurrency(desiredConcurrency, completedChunks)
          : desiredConcurrency;
      while (
        !isStopped &&
        activeRequests < effectiveConcurrency &&
        nextChunkIndex < chunks.length
      ) {
        while (nextChunkIndex < chunks.length && results[nextChunkIndex]) {
          nextChunkIndex++;
        }
        if (nextChunkIndex >= chunks.length) break;
        launchChunk(nextChunkIndex);
        nextChunkIndex++;
      }

      if (maybeResolve()) return;

      if (
        !isStopped &&
        nextChunkIndex < chunks.length &&
        activeRequests < effectiveConcurrency
      ) {
        queueSchedule(120);
      }
    }

    schedule();
  });
}

async function retryFailedChunks(maxRetryRounds) {
  const FAILED_MARKER = "[LỖI DỊCH ĐOẠN";

  for (let round = 1; round <= maxRetryRounds; round++) {
    if (isStopped) break;

    const failedIndices = [];
    translatedChunks.forEach(function findFailed(chunkText, chunkIndex) {
      if (chunkText && chunkText.startsWith(FAILED_MARKER)) {
        failedIndices.push(chunkIndex);
      }
    });

    if (failedIndices.length === 0) break;

    addLog(
      `\n🔄 Retry vòng ${round}/${maxRetryRounds}: ${failedIndices.length} đoạn lỗi`,
      "accent",
    );
    document.getElementById("progressLabel").textContent =
      `🔄 Retry vòng ${round} — ${failedIndices.length} đoạn lỗi...`;

    const roundDelay = round * 3000;
    addLog(`  ⏳ Đợi ${roundDelay / 1000}s trước khi retry...`, "info");
    await sleep(roundDelay);

    for (const failedIndex of failedIndices) {
      if (isStopped) break;

      const failedContent = translatedChunks[failedIndex];
      const originalTextStart = failedContent.indexOf("\n\n");
      if (originalTextStart === -1) continue;
      const originalChunkText = failedContent.slice(originalTextStart + 2);
      if (!originalChunkText.trim()) continue;

      addLog(`  ▶ Retry đoạn ${failedIndex + 1}...`, "info");

      try {
        const glossaryPairs = parseGlossaryInput(
          document.getElementById("glossaryInput")?.value || "",
        );
        const glossaryInstruction = buildGlossaryInstruction(glossaryPairs);
        const retranslated = await translateChunkWithRetry(
          originalChunkText,
          failedIndex,
          2,
          null,
          glossaryInstruction,
        );
        translatedChunks[failedIndex] = retranslated;
        addLog(`  ✓ Đoạn ${failedIndex + 1} đã sửa!`, "success");
      } catch (retryError) {
        addLog(
          `  ✗ Đoạn ${failedIndex + 1} vẫn lỗi: ${retryError.message}`,
          "error",
        );
      }

      await sleep(1500);
    }
  }

  const remainingErrors = translatedChunks.filter(
    function checkStillFailed(chunkText) {
      return chunkText && chunkText.startsWith(FAILED_MARKER);
    },
  ).length;

  return remainingErrors;
}

function updateProgress() {
  const percentage =
    totalChunks > 0 ? Math.round((completedChunks / totalChunks) * 100) : 0;

  document.getElementById("progressBarFill").style.width = `${percentage}%`;
  document.getElementById("progressPercent").textContent = `${percentage}%`;
  document.getElementById("statDone").textContent = completedChunks;
  document.getElementById("statTotal").textContent = totalChunks;

  const doneCount = translatedChunks.filter(Boolean).length;
  const partialBtn = document.getElementById("downloadPartialBtn");
  document.getElementById("downloadPartialCount").textContent = doneCount;
  if (doneCount > 0) {
    partialBtn.disabled = false;
  }

  if (startTime && completedChunks > 0) {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = completedChunks / elapsed;
    const remaining = (totalChunks - completedChunks) / rate;
    document.getElementById("statEta").textContent = formatTime(remaining);
    document.getElementById("statSpeed").textContent =
      `${rate.toFixed(2)} đoạn/s`;
  } else {
    document.getElementById("statSpeed").textContent = "--";
  }

  document.title = `[${percentage}%] Đang dịch... — Trình Dịch Truyện AI`;
}

function formatTime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600)
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function addLog(message, type) {
  const logContainer = document.getElementById("logContainer");
  const timestamp = new Date().toLocaleTimeString("vi-VN");
  const entry = document.createElement("div");
  entry.className = `log-entry ${type || "info"}`;
  entry.textContent = `[${timestamp}] ${message}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

async function startTranslation() {
  const apiKey = document.getElementById("apiKey").value.trim();
  const modelName = getSelectedModel();
  const baseUrl = document.getElementById("baseUrl").value.trim();
  const provider = getActiveProvider();
  const chunkSize = Number.parseInt(
    document.getElementById("chunkSize").value,
    10,
  );
  const scopePercent = getTranslationScopePercent();
  const concurrentRequests = getRuntimeConcurrentRequests();

  if (provider !== "ollama" && !apiKey)
    return showError("Vui lòng nhập API key.");
  if (!modelName) return showError("Vui lòng chọn hoặc nhập tên model.");
  if (!baseUrl) return showError("Vui lòng nhập Base URL.");
  if (!fileContent) return showError("Vui lòng chọn file cần dịch.");

  hideError();
  isStopped = false;
  isTranslationRunning = true;
  resetUsageStats();
  requestWakeLock("start-translation");
  startTime = Date.now();
  completedChunks = 0;
  translatedChunks = [];

  // Reset and show cache stats
  resetCacheStats();
  updateCacheStatsUI();
  document.getElementById("cacheStatsContainer").style.display = "block";

  // Update cost estimation with current settings
  updateCostEstimation();

  const fullChunks = splitIntoChunks(fileContent, chunkSize);
  const chunks = applyTranslationScope(fullChunks);
  totalChunks = chunks.length;
  const glossaryPairs = parseGlossaryInput(
    document.getElementById("glossaryInput")?.value || "",
  );
  const glossaryInstruction = buildGlossaryInstruction(glossaryPairs);

  let initialResults = new Array(totalChunks).fill(null);
  if (
    pendingResumeCheckpoint &&
    Array.isArray(pendingResumeCheckpoint.translatedChunks) &&
    pendingResumeCheckpoint.translatedChunks.length === totalChunks
  ) {
    initialResults = pendingResumeCheckpoint.translatedChunks.slice();
    completedChunks = initialResults.filter(Boolean).length;
    translatedChunks = initialResults.slice();
    addLog(
      `🧩 Resume checkpoint (${scopePercent}%): tiếp tục từ đoạn ${completedChunks + 1}/${totalChunks}`,
      "accent",
    );
  } else {
    clearTranslationCheckpoint(
      currentFileHash,
      getActiveProvider(),
      modelName,
      chunkSize,
      scopePercent,
    );
  }

  document.getElementById("progressSection").classList.add("visible");
  document.getElementById("resultSection").classList.remove("visible");
  document.getElementById("startBtn").disabled = true;
  document.getElementById("stopBtn").style.display = "flex";
  document.getElementById("progressLabel").textContent = "Đang dịch...";
  document.getElementById("logContainer").innerHTML = "";
  document
    .getElementById("progressSection")
    .scrollIntoView({ behavior: "smooth", block: "start" });

  addLog(
    `Bắt đầu dịch ${scopePercent}%: ${totalChunks} đoạn · ${concurrentRequests} luồng song song`,
    "accent",
  );
  addLog(`Model: ${modelName} @ ${baseUrl}`, "info");

  updateProgress();

  const runTranslation = async function () {
    try {
      translatedChunks = await processChunksWithConcurrency(chunks, {
        initialResults: initialResults,
        glossaryInstruction: glossaryInstruction,
      });

      if (isStopped) {
        document.getElementById("progressLabel").textContent = "⏹ Đã dừng";
        addLog("Đã dừng bởi người dùng.", "warning");
        setTranslationCheckpoint(
          currentFileHash,
          getActiveProvider(),
          modelName,
          chunkSize,
          scopePercent,
          {
            translatedChunks: translatedChunks,
            updatedAt: Date.now(),
            fileName: originalFileName,
          },
        );
        updateLocalProgressHistoryEntry("in_progress");
        if (
          currentFirebaseUser &&
          typeof cloudSaveTranslationProgress === "function"
        ) {
          cloudSaveTranslationProgress({
            fileHash: currentFileHash,
            fileName: originalFileName,
            provider: getActiveProvider(),
            model: modelName,
            chunkSize: chunkSize,
            scopePercent: scopePercent,
            totalChunks: totalChunks,
            translatedChunks: translatedChunks,
            status: "in_progress",
            force: true,
          });
        }
      } else {
        // Phase 2: Auto-retry failed chunks
        const remainingErrors = await retryFailedChunks(3);

        if (remainingErrors > 0) {
          document.getElementById("progressLabel").textContent =
            `⚠️ Dịch xong — còn ${remainingErrors} đoạn lỗi`;
          addLog(
            `⚠️ Hoàn thành với ${remainingErrors} đoạn vẫn lỗi sau retry. Tổng thời gian: ${formatTime((Date.now() - startTime) / 1000)}`,
            "warning",
          );
        } else {
          document.getElementById("progressLabel").textContent =
            "✅ Dịch hoàn tất!";
          addLog(
            `🎉 Hoàn thành! Tổng thời gian: ${formatTime((Date.now() - startTime) / 1000)}`,
            "success",
          );
        }
        clearTranslationCheckpoint(
          currentFileHash,
          getActiveProvider(),
          modelName,
          chunkSize,
          scopePercent,
        );
        updateLocalProgressHistoryEntry("completed");
        const _finalText = translatedChunks.join("\n\n");
        if (
          currentFirebaseUser &&
          typeof cloudSaveTranslationProgress === "function"
        ) {
          cloudSaveTranslationProgress({
            fileHash: currentFileHash,
            fileName: originalFileName,
            provider: getActiveProvider(),
            model: modelName,
            chunkSize: chunkSize,
            scopePercent: scopePercent,
            totalChunks: totalChunks,
            translatedChunks: translatedChunks,
            status: "completed",
            force: true,
          });
        }
        cloudSaveTranslation(_finalText);
        showResult(_finalText);
      }
    } catch (fatalError) {
      addLog(`Lỗi nghiêm trọng: ${fatalError.message}`, "error");
      showError(`Lỗi dịch: ${fatalError.message}`);
    } finally {
      isTranslationRunning = false;
      releaseWakeLockIfIdle();
      updateCostEstimation();
      document.getElementById("startBtn").disabled = false;
      document.getElementById("stopBtn").style.display = "none";
      document.title = "Trình Dịch Truyện AI";
      pendingResumeCheckpoint = null;
      const resumePromptEl = document.getElementById("resumePrompt");
      if (resumePromptEl) resumePromptEl.style.display = "none";
    }
  };

  // Web Lock giữ tab hoạt động khi chạy nền
  if (navigator.locks) {
    navigator.locks.request("translation_active", runTranslation);
  } else {
    runTranslation();
  }
}

const SPEED_PRESETS = {
  turbo: { concurrent: 20, delay: 0, chunkSize: 8000, temperature: 0.3 },
  balanced: { concurrent: 10, delay: 100, chunkSize: 6000, temperature: 0.3 },
  safe: { concurrent: 4, delay: 600, chunkSize: 5000, temperature: 0.2 },
  economy: { concurrent: 2, delay: 1200, chunkSize: 6000, temperature: 0.2 },
};
const DEFAULT_SPEED_PRESET = "balanced";

function markActiveSpeedPreset(preset, animate) {
  const buttons = document.querySelectorAll(
    ".speed-preset-btn[data-speed-preset]",
  );
  buttons.forEach(function (button) {
    const isActive = button.dataset.speedPreset === preset;
    button.classList.toggle("active", isActive);
    if (isActive && animate) {
      button.classList.remove("is-applying");
      requestAnimationFrame(function () {
        button.classList.add("is-applying");
        setTimeout(function () {
          button.classList.remove("is-applying");
        }, 460);
      });
    } else {
      button.classList.remove("is-applying");
    }
  });
}

function clearSpeedPresetHighlight() {
  const buttons = document.querySelectorAll(
    ".speed-preset-btn[data-speed-preset]",
  );
  buttons.forEach(function (button) {
    button.classList.remove("active", "is-applying");
  });
}

function applySpeedPreset(preset, options) {
  const opts = options || {};
  const silent = Boolean(opts.silent);
  const animate = opts.animate !== false;
  const settings = SPEED_PRESETS[preset];
  if (!settings) return;
  document.getElementById("concurrentRequests").value = settings.concurrent;
  document.getElementById("delayBetweenChunks").value = settings.delay;
  document.getElementById("temperature").value = settings.temperature;
  document.getElementById("tempDisplay").textContent = settings.temperature;
  document.getElementById("tempValue").textContent = settings.temperature;
  markActiveSpeedPreset(preset, animate);
  if (!isStopped && completedChunks === 0) {
    // Auto-adjust chunk size based on model if economy preset
    if (preset === "economy") {
      const model = getSelectedModel();
      const optimalSize = getOptimalChunkSize(model);
      document.getElementById("chunkSize").value = Math.min(optimalSize, 8000);
    } else {
      document.getElementById("chunkSize").value = settings.chunkSize;
    }
  }
  if (!silent) {
    addLog(
      `⚡ Preset "${preset}": ${settings.concurrent} song song · ${settings.delay}ms delay · temp ${settings.temperature}${completedChunks === 0 ? ` · chunk ${document.getElementById("chunkSize").value}` : " (chunk size giữ nguyên vì đang dịch)"}`,
      "accent",
    );
  }
}

function stopTranslation() {
  isStopped = true;
  addLog("Đang dừng... (hoàn thành các yêu cầu đang chạy)", "warning");
}

function showResult(translatedText) {
  lastResultText = translatedText || "";
  isPreviewExpanded = false;
  const charCount = translatedText.length.toLocaleString("vi-VN");
  const elapsed = formatTime((Date.now() - startTime) / 1000);

  document.getElementById("resultSummary").textContent =
    `Dịch hoàn tất ${totalChunks} đoạn trong ${elapsed} · ${charCount} ký tự`;

  renderResultPreview();
  updateCostEstimation();

  document.getElementById("resultSection").classList.add("visible");
  document
    .getElementById("resultSection")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderResultPreview() {
  const previewEl = document.getElementById("resultPreview");
  const toggleBtn = document.getElementById("togglePreviewBtn");
  if (!previewEl || !toggleBtn) return;

  const hasLongText = lastResultText.length > 500;
  const displayText =
    isPreviewExpanded || !hasLongText
      ? lastResultText
      : lastResultText.slice(0, 500) + "\n\n[...]";

  previewEl.textContent = displayText;
  previewEl.classList.toggle("full", isPreviewExpanded);
  toggleBtn.style.display = hasLongText ? "inline-flex" : "none";
  toggleBtn.textContent = isPreviewExpanded
    ? "Thu gọn xem trước"
    : "Mở rộng xem trước";
}

function toggleFullPreview() {
  isPreviewExpanded = !isPreviewExpanded;
  renderResultPreview();
}

function downloadPartial() {
  const doneChunks = translatedChunks.filter(Boolean);
  if (doneChunks.length === 0) return;
  const format =
    document.querySelector('input[name="partialFormat"]:checked')?.value ||
    "txt";
  const baseName = originalFileName.replace(/\.[^.]+$/, "");
  exportAs(
    doneChunks,
    `${baseName}_partial_${doneChunks.length}chunks_vietnamese`,
    format,
  ).then(function (fileName) {
    addLog(`⬇ Tải tiến độ: ${fileName}`, "success");
  });
}

function downloadResult() {
  const format =
    document.querySelector('input[name="exportFormat"]:checked')?.value ||
    "txt";
  const baseName = originalFileName.replace(/\.[^.]+$/, "");
  exportAs(translatedChunks, `${baseName}_vietnamese`, format).then(
    function (fileName) {
      addLog(`⬇ Đã tải file: ${fileName}`, "success");
    },
  );
}

async function exportAs(chunks, baseName, format) {
  const fullText = chunks.join("\n\n");
  const title = baseName.replace(/_vietnamese$/, "").replaceAll("_", " ");

  if (format === "docx") {
    return exportAsDocx(chunks, baseName, title);
  }
  if (format === "epub") {
    return exportAsEpub(chunks, baseName, title);
  }
  return exportAsTxt(fullText, baseName);
}

function exportAsTxt(text, baseName) {
  const fileName = `${baseName}.txt`;
  triggerDownload(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
    fileName,
  );
  return Promise.resolve(fileName);
}

async function exportAsDocx(chunks, baseName, title) {
  const fileName = `${baseName}.docx`;
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;

  const paragraphs = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
  ];

  chunks.forEach(function (chunkText, chunkIndex) {
    if (!chunkText) return;
    chunkText.split("\n").forEach(function (line) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({ text: line, size: 24, font: "Times New Roman" }),
          ],
          spacing: { after: line.trim() === "" ? 0 : 120 },
        }),
      );
    });
    if (chunkIndex < chunks.length - 1) {
      paragraphs.push(new Paragraph({ text: "" }));
    }
  });

  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs }],
  });
  const buffer = await Packer.toBlob(doc);
  triggerDownload(buffer, fileName);
  return fileName;
}

async function exportAsEpub(chunks, baseName, title) {
  const fileName = `${baseName}.epub`;
  const zip = new JSZip();

  const chapterHtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="vi">
<head><meta charset="UTF-8"/><title>${title}</title>
<style>body{font-family:serif;font-size:1em;line-height:1.8;margin:5%;} h1{font-size:1.4em;margin-bottom:1em;} p{margin:0 0 0.8em;text-indent:1.5em;}</style>
</head><body>
<h1>${title}</h1>
${chunks
  .filter(Boolean)
  .map(function (chunk) {
    return chunk
      .split("\n")
      .filter(function (line) {
        return line.trim();
      })
      .map(function (line) {
        return `<p>${line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>`;
      })
      .join("\n");
  })
  .join("\n")}
</body></html>`;

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
  <dc:title>${title}</dc:title><dc:language>vi</dc:language>
  <dc:identifier id="uid">${baseName}-${Date.now()}</dc:identifier>
</metadata>
<manifest>
  <item id="ch1" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="ch1"/></spine>
</package>`;

  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${baseName}"/></head>
<docTitle><text>${title}</text></docTitle>
<navMap><navPoint id="np1" playOrder="1"><navLabel><text>${title}</text></navLabel>
<content src="chapter.xhtml"/></navPoint></navMap>
</ncx>`;

  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file("OEBPS/content.opf", opf);
  zip.file("OEBPS/toc.ncx", ncx);
  zip.file("OEBPS/chapter.xhtml", chapterHtml);

  const epubBlob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
  });
  triggerDownload(epubBlob, fileName);
  return fileName;
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

async function copyResult() {
  const translatedText = translatedChunks.join("\n\n");
  try {
    await navigator.clipboard.writeText(translatedText);
    addLog("📋 Đã sao chép vào clipboard", "success");
  } catch {
    addLog("Không thể sao chép (hãy thử tải file)", "warning");
  }
}

function resetAll() {
  selectedFile = null;
  fileContent = "";
  translatedChunks = [];
  originalFileName = "";
  cachedStoryAnalysis = null;
  pendingResumeCheckpoint = null;

  document.getElementById("fileInput").value = "";
  const dropZone = document.getElementById("dropZone");
  dropZone.classList.remove("has-file");
  dropZone.querySelector(".drop-icon").textContent = "📄";
  dropZone.querySelector(".drop-title").textContent = "Kéo thả file vào đây";
  dropZone.querySelector(".drop-subtitle").textContent =
    "hoặc click để chọn file · Hỗ trợ .txt, .md, .text";

  document.getElementById("fileInfo").classList.remove("visible");
  document.getElementById("costEstimationCard").style.display = "none";
  document.getElementById("cacheStatsContainer").style.display = "none";
  const resumePromptEl = document.getElementById("resumePrompt");
  if (resumePromptEl) resumePromptEl.style.display = "none";
  document.getElementById("progressSection").classList.remove("visible");
  document.getElementById("resultSection").classList.remove("visible");
  document.getElementById("progressBarFill").style.width = "0%";
  document.getElementById("logContainer").innerHTML = "";
  const partialBtn = document.getElementById("downloadPartialBtn");
  partialBtn.disabled = true;
  document.getElementById("downloadPartialCount").textContent = "0";
  hideError();
}

function sleep(ms) {
  return new Promise(function (resolve) {
    return setTimeout(resolve, ms);
  });
}

function showError(message) {
  const alertEl = document.getElementById("alertError");
  document.getElementById("alertErrorMsg").textContent = message;
  alertEl.classList.add("visible");
  alertEl.scrollIntoView({ behavior: "smooth", block: "center" });
}

function hideError() {
  document.getElementById("alertError").classList.remove("visible");
}

document.getElementById("temperature").addEventListener("input", function () {
  document.getElementById("tempValue").textContent = this.value;
  document.getElementById("tempDisplay").textContent = this.value;
  clearSpeedPresetHighlight();
});

let lastKnownConcurrency = getRuntimeConcurrentRequests();
function onConcurrentRequestsChanged() {
  const currentConcurrency = getRuntimeConcurrentRequests();
  if (currentConcurrency === lastKnownConcurrency) return;

  lastKnownConcurrency = currentConcurrency;
  clearSpeedPresetHighlight();

  if (isTranslationRunning) {
    addLog(
      `⚙️ Áp dụng ngay: ${currentConcurrency} request song song (request đang chạy sẽ hoàn tất trước).`,
      "accent",
    );
  }

  if (isAnalysisRunning && !isWritingStopped) {
    const outputEl = document.getElementById("writingOutput");
    if (outputEl) {
      outputEl.textContent += `⚙️ Cập nhật song song: ${currentConcurrency} request\n`;
      outputEl.scrollTop = outputEl.scrollHeight;
    }
  }
}
document
  .getElementById("concurrentRequests")
  .addEventListener("input", onConcurrentRequestsChanged);
document
  .getElementById("concurrentRequests")
  .addEventListener("change", onConcurrentRequestsChanged);
document
  .getElementById("delayBetweenChunks")
  .addEventListener("input", clearSpeedPresetHighlight);
document.getElementById("modelName").addEventListener("input", function () {
  if (fileContent) {
    updateCostEstimation();
    updateWritingCostEstimation();
  }
});
document
  .getElementById("translationScope")
  .addEventListener("change", function () {
    if (fileContent) updateCostEstimation();
  });
document.getElementById("glossaryInput").addEventListener("input", function () {
  if (fileContent) updateCostEstimation();
});
document.getElementById("baseUrl").addEventListener("change", function () {
  if (getActiveProvider() === "ollama") {
    ensureOllamaModelsLoaded(true).then(function () {
      buildModelDropdown("ollama");
    });
  }
});
