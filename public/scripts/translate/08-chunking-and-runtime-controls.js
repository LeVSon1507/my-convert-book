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

function persistCurrentTranslationCheckpoint(force) {
  if (!currentFileHash || !translatedChunks || translatedChunks.length === 0)
    return;
  const now = Date.now();
  const doneCount = translatedChunks.filter(Boolean).length;
  const shouldForce = Boolean(force);
  const tooSoon = now - lastLocalCheckpointSavedAt < 2500;
  const noSignificantProgress = doneCount - lastLocalCheckpointDoneCount < 3;
  if (!shouldForce && tooSoon && noSignificantProgress) return;

  lastLocalCheckpointSavedAt = now;
  lastLocalCheckpointDoneCount = doneCount;

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
      chunkStates: chunkStates,
      chapterMap: chapterMap,
      currentSummary: currentSummary,
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
      chunkStates: chunkStates,
      chapterMap: chapterMap,
      currentSummary: currentSummary,
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
  var chunks = [];
  var currentPos = 0;
  var minSplit = Math.floor(chunkSize * 0.5);
  while (currentPos < text.length) {
    var endPos = currentPos + chunkSize;
    if (endPos >= text.length) {
      chunks.push(text.slice(currentPos));
      break;
    }
    var searchWindow = text.slice(currentPos + minSplit, endPos + 1);
    if (!searchWindow) {
      chunks.push(text.slice(currentPos, endPos));
      currentPos = endPos;
      continue;
    }
    // Priority 1: paragraph break (\n\n)
    var paraBreak = searchWindow.lastIndexOf("\n\n");
    if (paraBreak >= 0) {
      endPos = currentPos + minSplit + paraBreak + 2;
    } else {
      // Priority 2: Chinese/Vietnamese sentence-ending punctuation
      var cjkBreak = -1;
      var cjkPuncts = ["\u3002", "\uFF01", "\uFF1F", "\u2026"];
      for (var p = 0; p < cjkPuncts.length; p++) {
        var idx = searchWindow.lastIndexOf(cjkPuncts[p]);
        if (idx > cjkBreak) cjkBreak = idx;
      }
      if (cjkBreak >= 0) {
        endPos = currentPos + minSplit + cjkBreak + 1;
      } else {
        // Priority 3: English sentence-ending punctuation followed by space/newline
        var enBreak = -1;
        var enPuncts = [". ", "! ", "? "];
        for (var q = 0; q < enPuncts.length; q++) {
          var idx2 = searchWindow.lastIndexOf(enPuncts[q]);
          if (idx2 > enBreak) enBreak = idx2;
        }
        if (enBreak >= 0) {
          endPos = currentPos + minSplit + enBreak + 2;
        } else {
          // Priority 4: newline
          var nlBreak = searchWindow.lastIndexOf("\n");
          if (nlBreak >= 0) {
            endPos = currentPos + minSplit + nlBreak + 1;
          }
        }
      }
    }
    // Guard: don't produce tiny fragments or overshoot
    if (endPos <= currentPos + 80) endPos = currentPos + chunkSize;
    if (endPos > text.length) endPos = text.length;
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
  if (provider === "openrouter") {
    return 150000;
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
