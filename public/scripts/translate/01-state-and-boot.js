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
let lastLocalCheckpointSavedAt = 0;
let lastLocalCheckpointDoneCount = 0;
const TRANSLATION_CHECKPOINT_PREFIX = "translation_checkpoint_v1:";
const TRANSLATION_HISTORY_KEY = "translation_history_v1";
let currentFirebaseUser = null;
let cloudHistory = [];
let chunkStates = []; // ChunkState[] metadata parallel to translatedChunks
let currentSummary = ""; // rolling story summary injected into translation context
let chapterMap = []; // { chunkIndex, chapterIndex, chapterTitle }[]
let isSummaryUpdating = false; // guard: only one rolling summary update at a time

function resetTranslationPipelineState() {
  chunkStates = [];
  currentSummary = "";
  chapterMap = [];
  isSummaryUpdating = false;
}

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
  var rows = glossaryPairs
    .map(function (pair) {
      return "- " + pair.source + " => " + pair.target;
    })
    .join("\n");
  return "\n\nGLOSSARY B\u1eaeT BU\u1ed8C \u2014 d\u00f9ng \u0111\u00fang mapping sau, kh\u00f4ng \u0111\u01b0\u1ee3c t\u1ef1 \u00fd \u0111\u1ed5i t\u00ean ri\u00eang:\n" + rows + "\n- TUY\u1ec6T \u0110\u1ed0I d\u00f9ng \u0111\u00fang t\u00ean \u1edf tr\u00ean, gi\u1eef nguy\u00ean m\u1ecdi \u0111o\u1ea1n.";
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
