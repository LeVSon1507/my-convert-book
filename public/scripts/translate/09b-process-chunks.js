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
          const maxRetries = isSpeedOptimizedMode() ? 2 : 3;
          const translatedText = await translateChunkWithRetry(
            chunk,
            currentIndex,
            maxRetries,
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
