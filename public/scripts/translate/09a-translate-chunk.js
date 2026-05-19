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

  let currentChunk = chunk;
  let strictRetryMode = false;

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
        const payload =
          provider === "ollama"
            ? {
                model: modelName,
                stream: false,
                keep_alive: "30m",
                options: {
                  temperature: temperature,
                  top_p: 0.9,
                  repeat_penalty: strictRetryMode ? 1.18 : 1.12,
                  num_predict: getMaxTokensForTranslation(currentChunk),
                },
                messages: [
                  { role: "system", content: systemPrompt },
                  {
                    role: "user",
                    content: buildTranslationUserPrompt(
                      currentChunk,
                      strictRetryMode,
                    ),
                  },
                ],
              }
            : {
                model: modelName,
                temperature: temperature,
                frequency_penalty: strictRetryMode ? 0.4 : 0.2,
                presence_penalty: 0,
                max_tokens: getMaxTokensForTranslation(currentChunk),
                messages: [
                  { role: "system", content: systemPrompt },
                  {
                    role: "user",
                    content: buildTranslationUserPrompt(
                      currentChunk,
                      strictRetryMode,
                    ),
                  },
                ],
              };

        response = await requestChatCompletions(
          provider,
          baseUrl,
          apiKey,
          payload,
          controller.signal,
        );
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
      const rawOutput =
        provider === "ollama"
          ? responseData?.message?.content || ""
          : extractAssistantText(responseData);
      const translatedText = postProcessTranslationOutput(
        rawOutput,
        currentChunk,
        strictRetryMode,
      );

      if (!translatedText) {
        throw new Error("Phản hồi API không hợp lệ");
      }

      const shouldRunStrictQualityGate =
        strictRetryMode || !isSpeedOptimizedMode();

      if (
        shouldRunStrictQualityGate &&
        hasSevereSourceEcho(translatedText, currentChunk)
      ) {
        if (attempt < maxRetries) {
          strictRetryMode = true;
          addLog(
            `  ⚠ Đoạn ${chunkIndex + 1}: model trả lẫn bản gốc, retry chế độ nghiêm ngặt...`,
            "warning",
          );
          await sleep(600 * attempt);
          continue;
        }
        throw new Error("Model trả về lẫn bản gốc, không thể dùng kết quả này");
      }

      if (
        shouldRunStrictQualityGate &&
        hasSevereRepetition(translatedText)
      ) {
        if (attempt < maxRetries) {
          strictRetryMode = true;
          addLog(
            `  ⚠ Đoạn ${chunkIndex + 1}: phát hiện lặp câu/đoạn, retry chế độ nghiêm ngặt...`,
            "warning",
          );
          await sleep(500 * attempt);
          continue;
        }
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
        const splitPair = splitChunkForContextRetry(currentChunk);
        if (splitPair) {
          addLog(
            `  ⚠ Đoạn ${chunkIndex + 1}: Context quá dài, tách đôi đoạn để dịch lại...`,
            "warning",
          );
          const leftResult = await translateChunkWithRetry(
            splitPair[0],
            chunkIndex,
            2,
            null,
            glossaryInstruction,
          );
          const rightResult = await translateChunkWithRetry(
            splitPair[1],
            chunkIndex,
            2,
            null,
            glossaryInstruction,
          );
          return [leftResult, rightResult].filter(Boolean).join("\n");
        }
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
