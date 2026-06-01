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
  if (typeof rememberCustomModelForAccount === "function") {
    rememberCustomModelForAccount(provider, modelName);
  }
  if (typeof savePromptsToAccount === "function" && currentFirebaseUser) {
    savePromptsToAccount();
  }

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
        const _finalText = buildFinalTextFromChunks(translatedChunks);
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
