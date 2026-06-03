async function copyResult() {
  const translatedText = buildFinalTextFromChunks(translatedChunks);
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
let customModelSaveTimer = null;
let promptSaveTimer = null;
function scheduleSaveCustomModelToAccount() {
  if (customModelSaveTimer) {
    clearTimeout(customModelSaveTimer);
  }
  customModelSaveTimer = setTimeout(function () {
    customModelSaveTimer = null;
    const modelSelect = document.getElementById("modelSelect");
    const modelNameInput = document.getElementById("modelName");
    if (!modelSelect || modelSelect.value !== "__custom__" || !modelNameInput)
      return;
    const modelId = modelNameInput.value.trim();
    if (!modelId || typeof rememberCustomModelForAccount !== "function") return;
    rememberCustomModelForAccount(getActiveProvider(), modelId);
  }, 500);
}
document
  .getElementById("modelName")
  .addEventListener("blur", scheduleSaveCustomModelToAccount);
document
  .getElementById("modelName")
  .addEventListener("change", scheduleSaveCustomModelToAccount);
function scheduleSavePromptsToAccount() {
  if (promptSaveTimer) {
    clearTimeout(promptSaveTimer);
  }
  promptSaveTimer = setTimeout(function () {
    promptSaveTimer = null;
    if (typeof savePromptsToAccount !== "function" || !currentFirebaseUser)
      return;
    savePromptsToAccount();
  }, 900);
}
document
  .getElementById("systemPrompt")
  .addEventListener("blur", scheduleSavePromptsToAccount);
document
  .getElementById("glossaryInput")
  .addEventListener("blur", scheduleSavePromptsToAccount);
const plotDirectionInputEl = document.getElementById("plotDirection");
if (plotDirectionInputEl) {
  plotDirectionInputEl.addEventListener("blur", scheduleSavePromptsToAccount);
}
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

function dismissOnboarding() {
  const el = document.getElementById("onboardingSteps");
  if (el) el.style.display = "none";
  try {
    localStorage.setItem("onboarding_dismissed", "1");
  } catch {
    /* noop */
  }
}
globalThis.dismissOnboarding = dismissOnboarding;

(function initOnboardingVisibility() {
  try {
    if (localStorage.getItem("onboarding_dismissed") === "1") {
      const el = document.getElementById("onboardingSteps");
      if (el) el.style.display = "none";
    }
  } catch {
    /* noop */
  }
})();

async function loadSampleStory() {
  try {
    const resp = await fetch("/sample/sample-story.txt");
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const text = await resp.text();
    loadFile(new File([text], "sample-story.txt", { type: "text/plain" }));
  } catch (e) {
    showError("Không thể tải truyện mẫu: " + e.message);
  }
}
globalThis.loadSampleStory = loadSampleStory;

// Show chapter detection result hint when file loads
(function wireChapterDetectionHint() {
  const origLoadFile = globalThis.loadFile;
  if (typeof origLoadFile !== "function") return;
  // Hint will be updated via the detection result in 10-translation-runner
  // just wire the checkbox to update cost estimation
  const chapterCb = document.getElementById("enableChapterSplit");
  if (chapterCb) {
    chapterCb.addEventListener("change", function () {
      if (fileContent) updateCostEstimation();
    });
  }
  const autoCb = document.getElementById("enableAutoGlossary");
  if (autoCb) {
    autoCb.addEventListener("change", function () {
      if (fileContent) updateCostEstimation();
    });
  }
})();
