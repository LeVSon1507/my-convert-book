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
          // Build best-effort context from previous completed result
          const prevResult =
            currentIndex > 0 ? results[currentIndex - 1] : null;
          const prevTranslatedTail =
            prevResult &&
            typeof prevResult === "string" &&
            !prevResult.startsWith("[LỖI")
              ? prevResult.slice(-250)
              : "";
          const maxRetries = isSpeedOptimizedMode() ? 2 : 3;
          const translatedText = await translateChunkWithRetry(
            chunk,
            currentIndex,
            maxRetries,
            chunkHash,
            glossaryInstruction,
            {
              prevTranslatedTail: prevTranslatedTail,
              summaryBefore: currentSummary,
            },
          );
          results[currentIndex] = translatedText;
          translatedChunks[currentIndex] = translatedText;
          completedChunks++;
          updateProgress();
          updateCacheStatsUI();
          persistCurrentTranslationCheckpoint();
          addLog(`✓ Hoàn thành đoạn ${currentIndex + 1}`, "success");
        }

        // Rolling summary: every 10 completed chunks, update story summary async
        if (completedChunks > 0 && completedChunks % 10 === 0 && !isStopped) {
          triggerRollingSummaryUpdate(results.slice());
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

async function triggerRollingSummaryUpdate(completedResults) {
  if (isSummaryUpdating || isStopped) return;

  // Take last 3 completed translated chunks as context
  var doneParts = completedResults.filter(function (r) {
    return r && typeof r === "string" && !r.startsWith("[LỖI");
  });
  if (doneParts.length === 0) return;
  var recentText = doneParts.slice(-3).join("\n\n").slice(0, 3000);

  isSummaryUpdating = true;
  try {
    var apiKey = document.getElementById("apiKey").value.trim();
    var modelName = getSelectedModel();
    var baseUrl = document
      .getElementById("baseUrl")
      .value.trim()
      .replace(/\/$/, "");
    var provider = getActiveProvider();
    var summaryUserMsg =
      "T\u00F3m t\u1EAFt 2-3 c\u00E2u s\u1EF1 ki\u1EC7n, nh\u00E2n v\u1EADt ch\u00EDnh:\n\n" + recentText;
    var summaryPayload =
      provider === "ollama"
        ? {
            model: modelName,
            stream: false,
            messages: [{ role: "user", content: summaryUserMsg }],
          }
        : {
            model: modelName,
            temperature: 0.2,
            max_tokens: 200,
            messages: [{ role: "user", content: summaryUserMsg }],
          };

    var controller = new AbortController();
    var tid = setTimeout(function () {
      controller.abort();
    }, 30000);
    try {
      var resp = await requestChatCompletions(
        provider,
        baseUrl,
        apiKey,
        summaryPayload,
        controller.signal,
      );
      if (resp.ok) {
        var data = await resp.json();
        var summary =
          provider === "ollama"
            ? (data && data.message && data.message.content) || ""
            : extractAssistantText(data);
        if (summary && summary.trim()) {
          currentSummary = summary.trim().slice(0, 500);
          addLog(
            '📝 Tóm tắt cốt truyện cập nhật: "' +
              currentSummary.slice(0, 60) +
              '..."',
            "info",
          );
        }
      }
    } finally {
      clearTimeout(tid);
    }
  } catch (e) {
    // Non-blocking — ignore errors silently
  } finally {
    isSummaryUpdating = false;
  }
}
