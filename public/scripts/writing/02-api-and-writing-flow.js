    async function callWritingApi(systemPrompt, userPrompt) {
      const apiKey = document.getElementById('apiKey').value.trim();
      let modelName = getSelectedModel();
      const baseUrl = document.getElementById('baseUrl').value.trim().replace(/\/$/, '');
      const provider = getActiveProvider();
      const temperature = Number.parseFloat(document.getElementById('writingTemperature').value);
      const maxTokens = getMaxTokensForWriting(systemPrompt, userPrompt);
      const MAX_RETRIES = 2;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          let response;
          const payload = provider === 'ollama'
            ? {
                model: modelName,
                stream: false,
                keep_alive: '30m',
                options: {
                  temperature: temperature,
                  num_predict: maxTokens,
                },
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt }
                ]
              }
            : {
                model: modelName,
                temperature: temperature,
                max_tokens: maxTokens,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt }
                ]
              };

          response = await requestChatCompletions(
            provider,
            baseUrl,
            apiKey,
            payload
          );

          if (!response.ok) {
            const errorBody = await response.text();
            let parsed = null;
            try {
              parsed = JSON.parse(errorBody);
            } catch {
              parsed = null;
            }
            const code = parsed?.error?.code;

            if (code === 'model_not_supported') {
              if (
                getActiveProvider() === 'huggingface' &&
                attempt < MAX_RETRIES &&
                typeof globalThis.switchToSupportedHuggingFaceModel === 'function'
              ) {
                const fallbackModel = await globalThis.switchToSupportedHuggingFaceModel(modelName);
                if (fallbackModel) {
                  modelName = fallbackModel;
                  if (typeof addLog === 'function') {
                    addLog(`♻️ Hugging Face: chuyển model fallback sang "${fallbackModel}" cho tính năng viết tiếp.`, 'warning');
                  }
                  continue;
                }
              }
              throw new Error('Model hiện tại không hỗ trợ chat/completions với provider Hugging Face hiện tại. Hãy dùng model từ dropdown tự nạp.');
            }
            throw new Error(`HTTP ${response.status}: ${errorBody}`);
          }

          const responseText = await response.text();

          if (!responseText || responseText.trim().length === 0) {
            throw new Error('API trả về response rỗng');
          }

          let responseData;
          try {
            responseData = JSON.parse(responseText);
          } catch (parseError) {
            throw new Error('JSON parse lỗi — response có thể bị cắt ngắn (timeout). Thử lại...');
          }
          recordUsageFromResponse(responseData);

          const generatedText = provider === 'ollama'
            ? responseData?.message?.content
            : responseData.choices?.[0]?.message?.content;

          if (!generatedText) {
            throw new Error('Phản hồi API không hợp lệ — không có nội dung trả về');
          }

          return generatedText.trim();

        } catch (apiCallError) {
          const isRetryable = apiCallError.message.includes('JSON parse') ||
            apiCallError.message.includes('response rỗng') ||
            apiCallError.message.includes('Failed to fetch') ||
            apiCallError.message.includes('network');

          if (isRetryable && attempt < MAX_RETRIES) {
            const retryDelay = (attempt + 1) * 2000;
            console.warn(`Retry ${attempt + 1}/${MAX_RETRIES} sau ${retryDelay}ms:`, apiCallError.message);
            await sleep(retryDelay);
            continue;
          }

          throw apiCallError;
        }
      }
    }

    async function startContinueWriting() {
      const apiKey = document.getElementById('apiKey').value.trim();
      const modelName = getSelectedModel();
      const baseUrl = document.getElementById('baseUrl').value.trim();
      const provider = getActiveProvider();

      if (provider !== 'ollama' && !apiKey) return showError('Vui lòng nhập API key.');
      if (!modelName) return showError('Vui lòng chọn hoặc nhập tên model.');
      if (!baseUrl) return showError('Vui lòng nhập Base URL.');
      if (!fileContent) return showError('Vui lòng tải file truyện lên trước.');

      hideError();
      isWritingStopped = false;
      isWritingRunning = true;
      requestWakeLock('start-writing');
      continuedChunks = [];

      const chunkCount = Number.parseInt(document.getElementById('writingChunkCount').value, 10);
      const plotDirection = document.getElementById('plotDirection').value.trim();
      const writingBudgets = getWritingContextBudgets(modelName);

      const { styleSample, lastChapter } = extractWritingContext(fileContent, writingBudgets);

      // UI setup
      document.getElementById('writingResultSection').classList.add('visible');
      document.getElementById('writingOutput').textContent = '';
      document.getElementById('startWritingBtn').disabled = true;
      document.getElementById('stopWritingBtn').style.display = 'flex';
      document.getElementById('downloadWritingBtn').disabled = true;
      document.getElementById('writingChunkIndicator').style.display = 'inline-flex';
      const partialWritingBtn = document.getElementById('downloadWritingPartialBtn');
      partialWritingBtn.disabled = true;
      document.getElementById('writingPartialCount').textContent = '0';
      setWritingOutputCollapsed(true);

      document.getElementById('writingResultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Phase 1: Story Analysis (if enabled)
      const isAnalysisEnabled = document.getElementById('enableAnalysis').checked;
      let storyAnalysis = null;
      const persistedAnalysis = (!cachedStoryAnalysis && currentFileHash)
        ? getCachedStoryAnalysis(currentFileHash)
        : null;
      if (persistedAnalysis) {
        cachedStoryAnalysis = persistedAnalysis;
        document.getElementById('analysisCacheHint').textContent = ' ✅ Đã có bản phân tích cache (sẽ dùng lại)';
        document.getElementById('analysisCacheHint').style.display = 'inline';
        updateWritingCostEstimation();
      }

      if (isAnalysisEnabled) {
        if (cachedStoryAnalysis) {
          storyAnalysis = cachedStoryAnalysis;
          document.getElementById('writingOutput').textContent = '✅ Dùng lại bản phân tích đã có\n\n';
        } else {
          document.getElementById('writingOutput').textContent = '🔍 Đang phân tích truyện...\n';

          try {
            storyAnalysis = await analyzeFullStory(fileContent, function updateAnalysisStatus(statusMsg) {
              if (isWritingStopped) return;
              document.getElementById('writingChunkLabel').textContent = '📖 ' + statusMsg;
              const outputEl = document.getElementById('writingOutput');
              outputEl.textContent += statusMsg + '\n';
              outputEl.scrollTop = outputEl.scrollHeight;
            });

            if (isWritingStopped || !storyAnalysis) {
              isWritingRunning = false;
              releaseWakeLockIfIdle();
              document.getElementById('writingChunkIndicator').style.display = 'none';
              document.getElementById('startWritingBtn').disabled = false;
              document.getElementById('stopWritingBtn').style.display = 'none';
              return;
            }

            cachedStoryAnalysis = storyAnalysis;
            if (currentFileHash) {
              setCachedStoryAnalysis(currentFileHash, storyAnalysis);
            }
            document.getElementById('analysisCacheHint').style.display = 'inline';
            updateWritingCostEstimation();
            document.getElementById('writingOutput').textContent += '\n✅ Phân tích hoàn tất! Bắt đầu viết...\n\n';

          } catch (analysisError) {
            document.getElementById('writingOutput').textContent += '\n⚠️ Lỗi phân tích: ' + analysisError.message + '\nSẽ viết tiếp không có phân tích...\n\n';
          }
        }
      }

      // Phase 2: Writing
      const systemPrompt = buildContinueWritingSystemPrompt(styleSample, storyAnalysis);

      document.getElementById('writingResultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });

      let accumulatedText = '';

      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
        if (isWritingStopped) break;

        document.getElementById('writingChunkLabel').textContent =
          `Đang viết đoạn ${chunkIndex + 1}/${chunkCount}...`;

        try {
          const previousTail = getTailContext(accumulatedText, writingBudgets.previousTailLength);
          const userPrompt = buildContinueWritingUserPrompt(
            lastChapter,
            plotDirection,
            previousTail,
            continuedChunks.length
          );

          const generatedText = await callWritingApi(systemPrompt, userPrompt);
          continuedChunks.push(generatedText);

          if (accumulatedText) {
            accumulatedText += '\n\n';
          }
          accumulatedText += generatedText;

          renderWritingChunks();

          // Update partial download button
          document.getElementById('writingPartialCount').textContent = continuedChunks.length;
          const partialBtn = document.getElementById('downloadWritingPartialBtn');
          partialBtn.disabled = false;

          // Auto-scroll output to bottom
          const outputEl = document.getElementById('writingOutput');
          outputEl.scrollTop = outputEl.scrollHeight;

          // Delay có thể chỉnh realtime từ ô "Độ trễ giữa các đoạn (ms)"
          if (chunkIndex < chunkCount - 1 && !isWritingStopped) {
            const writingDelayMs = Number.parseInt(document.getElementById('delayBetweenChunks').value, 10) || 0;
            if (writingDelayMs > 0) {
              await sleep(writingDelayMs);
            }
          }

        } catch (writingError) {
          continuedChunks.push(`[LỖI ĐOẠN ${chunkIndex + 1}: ${writingError.message}]`);
          renderWritingChunks();
          showError(`Lỗi khi viết đoạn ${chunkIndex + 1}: ${writingError.message}`);
          break;
        }
      }

      // Done
      document.getElementById('writingChunkIndicator').style.display = 'none';
      document.getElementById('startWritingBtn').disabled = false;
      document.getElementById('stopWritingBtn').style.display = 'none';

      if (continuedChunks.length > 0) {
        document.getElementById('downloadWritingBtn').disabled = false;
      }

      if (!isWritingStopped && continuedChunks.length === chunkCount) {
        document.getElementById('writingChunkLabel').textContent = '✅ Viết xong!';
        document.getElementById('writingChunkIndicator').style.display = 'inline-flex';
        const indicatorSpinner = document.getElementById('writingChunkIndicator').querySelector('.spinner');
        if (indicatorSpinner) indicatorSpinner.style.display = 'none';
      }

      isWritingRunning = false;
      releaseWakeLockIfIdle();
    }
