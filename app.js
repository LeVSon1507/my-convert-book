
    let selectedFile = null;
    let fileContent = '';
    let translatedChunks = [];
    let totalChunks = 0;
    let completedChunks = 0;
    let isStopped = false;
    let startTime = null;
    let originalFileName = '';
    let isTranslationRunning = false;
    let isAnalysisRunning = false;
    let isWritingRunning = false;
    let wakeLockSentinel = null;

    function hasActiveLongTask() {
      return isTranslationRunning || isAnalysisRunning || isWritingRunning;
    }

    async function requestWakeLock(contextLabel) {
      if (!('wakeLock' in navigator)) return;
      if (!hasActiveLongTask()) return;
      if (wakeLockSentinel) return;

      try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', function() {
          wakeLockSentinel = null;
          if (hasActiveLongTask()) {
            addLog('⚠️ Wake Lock bị nhả (có thể do hệ thống), app sẽ cố xin lại khi quay lại foreground.', 'warning');
          }
        });
        addLog(`🔒 Bật giữ màn hình sáng (${contextLabel}) để giảm lỗi khi chạy nền trên mobile.`, 'info');
      } catch (wakeLockError) {
        addLog(`⚠️ Không bật được Wake Lock: ${wakeLockError.message}`, 'warning');
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


    document.addEventListener('DOMContentLoaded', function applyAdminConfig() {
      const config = globalThis.TRANSLATOR_CONFIG;
      const provider = config?.defaultProvider || 'openrouter';
      switchProvider(provider);
      const apiKey = config?.keys?.[provider] || config?.defaultApiKey || '';
      if (apiKey) document.getElementById('apiKey').value = apiKey;
      if (config?.defaultModel) {
        const select = document.getElementById('modelSelect');
        const hasOption = Array.from(select.options).some(function(opt) { return opt.value === config.defaultModel; });
        if (hasOption) {
          select.value = config.defaultModel;
          onModelSelectChange(config.defaultModel);
        }
      }
    });
    document.addEventListener('visibilitychange', function handleVisibilityChange() {
      if (!hasActiveLongTask()) return;

      if (document.hidden) {
        addLog('⚠️ App đang chạy nền. Trên mobile (đặc biệt iOS), hệ điều hành có thể tạm dừng network và làm request fail.', 'warning');
        return;
      }

      requestWakeLock('tab-visible-again');
    });
    window.addEventListener('focus', function() {
      if (hasActiveLongTask()) {
        requestWakeLock('window-focus');
      }
    });


    const PROVIDER_CONFIGS = {
      grok: {
        baseUrl: 'https://api.x.ai/v1',
        defaultModel: 'grok-3-mini',
        hint: 'API key tại console.x.ai',
        models: [
          { id: 'grok-3-mini',      label: 'Grok 3 Mini — nhanh, tiết kiệm' },
          { id: 'grok-3-mini-fast', label: 'Grok 3 Mini Fast — cực nhanh' },
          { id: 'grok-3',           label: 'Grok 3 — mạnh nhất xAI' },
          { id: 'grok-3-fast',      label: 'Grok 3 Fast — mạnh + nhanh hơn' },
          { id: 'grok-2-1212',      label: 'Grok 2 (1212) — thế hệ trước' },
          { id: '__custom__',       label: '✏️ Nhập model ID...' },
        ]
      },
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        hint: 'API key tại platform.openai.com/api-keys',
        models: [
          { id: 'gpt-4o-mini',      label: 'GPT-4o Mini — nhanh, rẻ nhất' },
          { id: 'gpt-4o',           label: 'GPT-4o — cân bằng tốc độ/chất lượng' },
          { id: 'o4-mini',          label: 'o4 Mini — reasoning, tiết kiệm' },
          { id: 'o3-mini',          label: 'o3 Mini — reasoning nhanh' },
          { id: 'gpt-4-turbo',      label: 'GPT-4 Turbo — thế hệ trước' },
          { id: '__custom__',       label: '✏️ Nhập model ID...' },
        ]
      },
      gemini: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        defaultModel: 'gemini-2.5-pro-preview-03-25',
        hint: 'API key tại aistudio.google.com/app/apikey',
        models: [
          { id: 'gemini-2.5-pro-preview-03-25', label: 'Gemini 2.5 Pro — mạnh nhất Google' },
          { id: 'gemini-2.0-flash',             label: 'Gemini 2.0 Flash — nhanh, miễn phí' },
          { id: 'gemini-2.0-flash-lite',        label: 'Gemini 2.0 Flash Lite — cực nhanh' },
          { id: 'gemini-1.5-pro',               label: 'Gemini 1.5 Pro — thế hệ trước' },
          { id: '__custom__',                   label: '✏️ Nhập model ID...' },
        ]
      },
      openrouter: {
        baseUrl: 'https://openrouter.ai/api/v1',
        defaultModel: 'x-ai/grok-3-mini',
        hint: 'API key tại openrouter.ai/keys — truy cập 300+ models',
        models: [
          { id: 'x-ai/grok-3-mini',               label: 'Grok 3 Mini — nhanh, rẻ ⭐' },
          { id: 'x-ai/grok-3-mini:fast',           label: 'Grok 3 Mini Fast — cực nhanh' },
          { id: 'x-ai/grok-3',                     label: 'Grok 3 — flagship xAI' },
          { id: 'x-ai/grok-3:fast',                label: 'Grok 3 Fast — mạnh + nhanh' },
          { id: 'anthropic/claude-3.5-sonnet',     label: 'Claude 3.5 Sonnet — rất mạnh' },
          { id: 'anthropic/claude-3.5-haiku',      label: 'Claude 3.5 Haiku — nhanh' },
          { id: 'google/gemini-2.5-pro-preview',   label: 'Gemini 2.5 Pro — Google flagship' },
          { id: 'google/gemini-2.0-flash-001',     label: 'Gemini 2.0 Flash — nhanh, rẻ' },
          { id: 'openai/gpt-4o-mini',              label: 'GPT-4o Mini — OpenAI nhanh' },
          { id: 'openai/gpt-4o',                   label: 'GPT-4o — OpenAI mạnh' },
          { id: 'deepseek/deepseek-chat-v3-0324',  label: 'DeepSeek V3 — rẻ, chất lượng cao' },
          { id: 'deepseek/deepseek-r1',            label: 'DeepSeek R1 — reasoning' },
          { id: '__custom__',                      label: '✏️ Nhập model ID...' },
        ]
      },
      custom: {
        baseUrl: '',
        defaultModel: '',
        hint: 'Nhập Base URL và Model ID tương thích OpenAI API',
        models: [
          { id: '__custom__', label: '✏️ Nhập model ID...' },
        ]
      }
    };

    function buildModelDropdown(provider) {
      const select = document.getElementById('modelSelect');
      const config = PROVIDER_CONFIGS[provider];
      select.innerHTML = '';
      config.models.forEach(function(modelInfo) {
        const option = document.createElement('option');
        option.value = modelInfo.id;
        option.textContent = modelInfo.label;
        select.appendChild(option);
      });
      select.value = config.defaultModel;
      onModelSelectChange(select.value);
    }

    function onModelSelectChange(selectedValue) {
      const isCustom = selectedValue === '__custom__';
      document.getElementById('customModelGroup').style.display = isCustom ? 'block' : 'none';
      if (!isCustom) {
        document.getElementById('modelName').value = selectedValue;
      }
    }

    function getSelectedModel() {
      const selectValue = document.getElementById('modelSelect').value;
      if (selectValue === '__custom__') {
        return document.getElementById('modelName').value.trim();
      }
      return selectValue;
    }

    function switchProvider(provider) {
      const config = PROVIDER_CONFIGS[provider];
      document.getElementById('baseUrl').value = config.baseUrl;
      document.getElementById('modelHint').textContent = config.hint;
      buildModelDropdown(provider);
      loadSavedApiKey(provider);

      document.querySelectorAll('.tab').forEach(function(tab) {
        tab.classList.toggle('active', tab.dataset.provider === provider);
      });
    }


    function toggleApiKeyVisibility() {
      const apiKeyInput = document.getElementById('apiKey');
      const isPassword = apiKeyInput.type === 'password';
      apiKeyInput.type = isPassword ? 'text' : 'password';
      document.getElementById('toggleApiKeyBtn').textContent = isPassword ? '🙈' : '👁';
    }

    function saveApiKey() {
      const provider = document.querySelector('.tab.active')?.dataset?.provider || 'openrouter';
      const apiKey = document.getElementById('apiKey').value.trim();
      if (!apiKey) return;
      localStorage.setItem('translator_api_key_' + provider, apiKey);
      const hint = document.getElementById('keySavedHint');
      hint.textContent = '✅ Đã lưu key cho ' + provider + ' vào browser.';
      hint.style.display = 'block';
    }

    function clearApiKey() {
      const provider = document.querySelector('.tab.active')?.dataset?.provider || 'openrouter';
      localStorage.removeItem('translator_api_key_' + provider);
      document.getElementById('apiKey').value = '';
      const hint = document.getElementById('keySavedHint');
      hint.textContent = '🗑 Đã xóa key.';
      hint.style.display = 'block';
      setTimeout(function() { hint.style.display = 'none'; }, 2000);
    }

    function loadSavedApiKey(provider) {
      const configKey = globalThis.TRANSLATOR_CONFIG?.keys?.[provider] || '';
      const savedKey = localStorage.getItem('translator_api_key_' + provider);
      const keyToUse = savedKey || configKey;
      const hint = document.getElementById('keySavedHint');
      if (keyToUse) {
        document.getElementById('apiKey').value = keyToUse;
        hint.textContent = savedKey ? '💾 Đã load key đã lưu cho ' + provider : '🔑 Key từ config.js';
        hint.style.display = 'block';
      } else {
        document.getElementById('apiKey').value = '';
        hint.style.display = 'none';
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
      const cacheHint = document.getElementById('analysisCacheHint');
      if (cacheHint) cacheHint.style.display = 'none';

      const reader = new FileReader();
      reader.onload = function(event) {
        fileContent = event.target.result;

        const sizeMB = (file.size / 1024 / 1024).toFixed(2);
        const charCount = fileContent.length.toLocaleString('vi-VN');

        const dropZone = document.getElementById('dropZone');
        dropZone.classList.add('has-file');
        dropZone.querySelector('.drop-icon').textContent = '✅';
        dropZone.querySelector('.drop-title').textContent = file.name;
        dropZone.querySelector('.drop-subtitle').textContent = `${sizeMB} MB · ${charCount} ký tự`;

        const fileInfo = document.getElementById('fileInfo');
        fileInfo.innerHTML = `
          <strong>${file.name}</strong> — ${sizeMB} MB (${charCount} ký tự) · 
          Ước tính ~${estimateChunks(fileContent.length)} đoạn cần dịch
        `;
        fileInfo.classList.add('visible');
      };
      reader.readAsText(file, 'UTF-8');
    }

    function estimateChunks(charCount) {
      const chunkSize = Number.parseInt(document.getElementById('chunkSize').value, 10) || 3000;
      return Math.ceil(charCount / chunkSize);
    }


    const dropZone = document.getElementById('dropZone');

    dropZone.addEventListener('dragover', function(event) {
      event.preventDefault();
      dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', function() {
      dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', function(event) {
      event.preventDefault();
      dropZone.classList.remove('drag-over');
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
          const paragraphBreak = text.lastIndexOf('\n\n', endPos);
          if (paragraphBreak > currentPos + chunkSize * 0.5) {
            endPos = paragraphBreak + 2;
          } else {
            // Try to break at sentence boundary
            const sentenceBreak = text.lastIndexOf('. ', endPos);
            if (sentenceBreak > currentPos + chunkSize * 0.5) {
              endPos = sentenceBreak + 2;
            } else {
              // Break at newline
              const newlineBreak = text.lastIndexOf('\n', endPos);
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
      const concurrentInput = document.getElementById('concurrentRequests');
      const rawValue = Number.parseInt(concurrentInput.value, 10);
      const normalizedValue = Number.isFinite(rawValue) ? Math.max(1, Math.min(50, rawValue)) : 1;
      concurrentInput.value = String(normalizedValue);
      return normalizedValue;
    }


    async function translateChunkWithRetry(chunk, chunkIndex, maxRetries) {
      const apiKey = document.getElementById('apiKey').value.trim();
      const modelName = getSelectedModel();
      const baseUrl = document.getElementById('baseUrl').value.trim().replace(/\/$/, '');
      const systemPrompt = document.getElementById('systemPrompt').value.trim();
      const temperature = Number.parseFloat(document.getElementById('temperature').value);

      const url = `${baseUrl}/chat/completions`;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: modelName,
              temperature: temperature,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Dịch đoạn văn bản sau sang tiếng Việt:\n\n${chunk}` }
              ]
            })
          });

          if (!response.ok) {
            const errorBody = await response.text();
            throw new Error(`HTTP ${response.status}: ${errorBody}`);
          }

          const responseData = await response.json();
          const translatedText = responseData.choices?.[0]?.message?.content;

          if (!translatedText) {
            throw new Error('Phản hồi API không hợp lệ');
          }

          return translatedText;

        } catch (translationError) {
          if (attempt === maxRetries) {
            throw translationError;
          }
          const retryDelay = attempt * 2000;
          addLog(`  ⚠ Đoạn ${chunkIndex + 1}: Thử lại (${attempt}/${maxRetries}) sau ${retryDelay}ms — ${translationError.message}`, 'warning');
          await sleep(retryDelay);
        }
      }
    }


    async function processChunksWithConcurrency(chunks) {
      const results = new Array(chunks.length).fill(null);
      let nextChunkIndex = 0;
      let activeRequests = 0;
      let scheduleTimer = null;

      return new Promise(function(resolve) {
        function queueSchedule(delayMs) {
          if (scheduleTimer !== null) return;
          scheduleTimer = setTimeout(function() {
            scheduleTimer = null;
            schedule();
          }, delayMs);
        }

        function maybeResolve() {
          if ((isStopped || nextChunkIndex >= chunks.length) && activeRequests === 0) {
            resolve(results);
            return true;
          }
          return false;
        }

        function launchChunk(currentIndex) {
          const chunk = chunks[currentIndex];
          activeRequests++;

          (async function() {
            try {
              addLog(`▶ Đang dịch đoạn ${currentIndex + 1}/${chunks.length}...`, 'info');
              const translatedText = await translateChunkWithRetry(chunk, currentIndex, 3);
              results[currentIndex] = translatedText;
              translatedChunks[currentIndex] = translatedText;
              completedChunks++;
              updateProgress();
              addLog(`✓ Hoàn thành đoạn ${currentIndex + 1}`, 'success');
            } catch (chunkError) {
              results[currentIndex] = `[LỖI DỊCH ĐOẠN ${currentIndex + 1}: ${chunkError.message}]\n\n${chunk}`;
              translatedChunks[currentIndex] = results[currentIndex];
              completedChunks++;
              updateProgress();
              addLog(`✗ Lỗi đoạn ${currentIndex + 1}: ${chunkError.message}`, 'error');
            }

            const delayMs = Number.parseInt(document.getElementById('delayBetweenChunks').value, 10) || 0;
            if (delayMs > 0 && !isStopped) {
              await sleep(delayMs);
            }
          })().finally(function() {
            activeRequests--;
            schedule();
          });
        }

        function schedule() {
          if (maybeResolve()) return;

          const desiredConcurrency = getRuntimeConcurrentRequests();
          while (!isStopped && activeRequests < desiredConcurrency && nextChunkIndex < chunks.length) {
            launchChunk(nextChunkIndex);
            nextChunkIndex++;
          }

          if (maybeResolve()) return;

          if (!isStopped && nextChunkIndex < chunks.length && activeRequests < getRuntimeConcurrentRequests()) {
            queueSchedule(120);
          }
        }

        schedule();
      });
    }

    async function retryFailedChunks(maxRetryRounds) {
      const FAILED_MARKER = '[LỖI DỊCH ĐOẠN';

      for (let round = 1; round <= maxRetryRounds; round++) {
        if (isStopped) break;

        const failedIndices = [];
        translatedChunks.forEach(function findFailed(chunkText, chunkIndex) {
          if (chunkText && chunkText.startsWith(FAILED_MARKER)) {
            failedIndices.push(chunkIndex);
          }
        });

        if (failedIndices.length === 0) break;

        addLog(`\n🔄 Retry vòng ${round}/${maxRetryRounds}: ${failedIndices.length} đoạn lỗi`, 'accent');
        document.getElementById('progressLabel').textContent = `🔄 Retry vòng ${round} — ${failedIndices.length} đoạn lỗi...`;

        const roundDelay = round * 3000;
        addLog(`  ⏳ Đợi ${roundDelay / 1000}s trước khi retry...`, 'info');
        await sleep(roundDelay);

        for (const failedIndex of failedIndices) {
          if (isStopped) break;

          const failedContent = translatedChunks[failedIndex];
          const originalTextStart = failedContent.indexOf('\n\n');
          if (originalTextStart === -1) continue;
          const originalChunkText = failedContent.slice(originalTextStart + 2);
          if (!originalChunkText.trim()) continue;

          addLog(`  ▶ Retry đoạn ${failedIndex + 1}...`, 'info');

          try {
            const retranslated = await translateChunkWithRetry(originalChunkText, failedIndex, 2);
            translatedChunks[failedIndex] = retranslated;
            addLog(`  ✓ Đoạn ${failedIndex + 1} đã sửa!`, 'success');
          } catch (retryError) {
            addLog(`  ✗ Đoạn ${failedIndex + 1} vẫn lỗi: ${retryError.message}`, 'error');
          }

          await sleep(1500);
        }
      }

      const remainingErrors = translatedChunks.filter(function checkStillFailed(chunkText) {
        return chunkText && chunkText.startsWith(FAILED_MARKER);
      }).length;

      return remainingErrors;
    }


    function updateProgress() {
      const percentage = totalChunks > 0 ? Math.round((completedChunks / totalChunks) * 100) : 0;

      document.getElementById('progressBarFill').style.width = `${percentage}%`;
      document.getElementById('progressPercent').textContent = `${percentage}%`;
      document.getElementById('statDone').textContent = completedChunks;
      document.getElementById('statTotal').textContent = totalChunks;

      const doneCount = translatedChunks.filter(Boolean).length;
      const partialBtn = document.getElementById('downloadPartialBtn');
      document.getElementById('downloadPartialCount').textContent = doneCount;
      if (doneCount > 0) {
        partialBtn.disabled = false;
        partialBtn.style.opacity = '1';
        partialBtn.style.cursor = 'pointer';
      }

      if (startTime && completedChunks > 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = completedChunks / elapsed;
        const remaining = (totalChunks - completedChunks) / rate;
        document.getElementById('statEta').textContent = formatTime(remaining);
      }

      document.title = `[${percentage}%] Đang dịch... — Trình Dịch Truyện AI`;
    }

    function formatTime(seconds) {
      if (seconds < 60) return `${Math.round(seconds)}s`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
      return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    }


    function addLog(message, type) {
      const logContainer = document.getElementById('logContainer');
      const timestamp = new Date().toLocaleTimeString('vi-VN');
      const entry = document.createElement('div');
      entry.className = `log-entry ${type || 'info'}`;
      entry.textContent = `[${timestamp}] ${message}`;
      logContainer.appendChild(entry);
      logContainer.scrollTop = logContainer.scrollHeight;
    }


    async function startTranslation() {
      const apiKey = document.getElementById('apiKey').value.trim();
      const modelName = getSelectedModel();
      const baseUrl = document.getElementById('baseUrl').value.trim();
      const chunkSize = Number.parseInt(document.getElementById('chunkSize').value, 10);
      const concurrentRequests = getRuntimeConcurrentRequests();

      if (!apiKey) return showError('Vui lòng nhập API key.');
      if (!modelName) return showError('Vui lòng chọn hoặc nhập tên model.');
      if (!baseUrl) return showError('Vui lòng nhập Base URL.');
      if (!fileContent) return showError('Vui lòng chọn file cần dịch.');

      hideError();
      isStopped = false;
      isTranslationRunning = true;
      requestWakeLock('start-translation');
      startTime = Date.now();
      completedChunks = 0;
      translatedChunks = [];

      const chunks = splitIntoChunks(fileContent, chunkSize);
      totalChunks = chunks.length;

      document.getElementById('progressSection').classList.add('visible');
      document.getElementById('resultSection').classList.remove('visible');
      document.getElementById('startBtn').disabled = true;
      document.getElementById('stopBtn').style.display = 'flex';
      document.getElementById('progressLabel').textContent = 'Đang dịch...';
      document.getElementById('logContainer').innerHTML = '';

      addLog(`Bắt đầu dịch: ${totalChunks} đoạn · ${concurrentRequests} luồng song song`, 'accent');
      addLog(`Model: ${modelName} @ ${baseUrl}`, 'info');

      updateProgress();

      const runTranslation = async function() {
        try {
          translatedChunks = await processChunksWithConcurrency(chunks);

          if (isStopped) {
            document.getElementById('progressLabel').textContent = '⏹ Đã dừng';
            addLog('Đã dừng bởi người dùng.', 'warning');
          } else {
            // Phase 2: Auto-retry failed chunks
            const remainingErrors = await retryFailedChunks(3);

            if (remainingErrors > 0) {
              document.getElementById('progressLabel').textContent = `⚠️ Dịch xong — còn ${remainingErrors} đoạn lỗi`;
              addLog(`⚠️ Hoàn thành với ${remainingErrors} đoạn vẫn lỗi sau retry. Tổng thời gian: ${formatTime((Date.now() - startTime) / 1000)}`, 'warning');
            } else {
              document.getElementById('progressLabel').textContent = '✅ Dịch hoàn tất!';
              addLog(`🎉 Hoàn thành! Tổng thời gian: ${formatTime((Date.now() - startTime) / 1000)}`, 'success');
            }
            showResult(translatedChunks.join('\n\n'));
          }
        } catch (fatalError) {
          addLog(`Lỗi nghiêm trọng: ${fatalError.message}`, 'error');
          showError(`Lỗi dịch: ${fatalError.message}`);
        } finally {
          isTranslationRunning = false;
          releaseWakeLockIfIdle();
          document.getElementById('startBtn').disabled = false;
          document.getElementById('stopBtn').style.display = 'none';
          document.title = 'Trình Dịch Truyện AI';
        }
      };

      // Web Lock giữ tab hoạt động khi chạy nền
      if (navigator.locks) {
        navigator.locks.request('translation_active', runTranslation);
      } else {
        runTranslation();
      }
    }

    function applySpeedPreset(preset) {
      const presets = {
        turbo:    { concurrent: 20, delay: 0,    chunkSize: 6000 },
        balanced: { concurrent: 10, delay: 200,  chunkSize: 4000 },
        safe:     { concurrent: 3,  delay: 1000, chunkSize: 3000 },
      };
      const settings = presets[preset];
      if (!settings) return;
      document.getElementById('concurrentRequests').value = settings.concurrent;
      document.getElementById('delayBetweenChunks').value = settings.delay;
      if (!isStopped && completedChunks === 0) {
        document.getElementById('chunkSize').value = settings.chunkSize;
      }
      addLog(`⚡ Preset "${preset}": ${settings.concurrent} song song · ${settings.delay}ms delay${completedChunks === 0 ? ` · chunk ${settings.chunkSize}` : ' (chunk size giữ nguyên vì đang dịch)'}`, 'accent');
    }

    function stopTranslation() {
      isStopped = true;
      addLog('Đang dừng... (hoàn thành các yêu cầu đang chạy)', 'warning');
    }


    function showResult(translatedText) {
      const charCount = translatedText.length.toLocaleString('vi-VN');
      const elapsed = formatTime((Date.now() - startTime) / 1000);

      document.getElementById('resultSummary').textContent =
        `Dịch hoàn tất ${totalChunks} đoạn trong ${elapsed} · ${charCount} ký tự`;

      document.getElementById('resultPreview').textContent = translatedText.slice(0, 500) + (translatedText.length > 500 ? '\n\n[...]' : '');

      document.getElementById('resultSection').classList.add('visible');
      document.getElementById('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function downloadPartial() {
      const doneChunks = translatedChunks.filter(Boolean);
      if (doneChunks.length === 0) return;
      const format = document.querySelector('input[name="partialFormat"]:checked')?.value || 'txt';
      const baseName = originalFileName.replace(/\.[^.]+$/, '');
      exportAs(doneChunks, `${baseName}_partial_${doneChunks.length}chunks_vietnamese`, format)
        .then(function(fileName) { addLog(`⬇ Tải tiến độ: ${fileName}`, 'success'); });
    }

    function downloadResult() {
      const format = document.querySelector('input[name="exportFormat"]:checked')?.value || 'txt';
      const baseName = originalFileName.replace(/\.[^.]+$/, '');
      exportAs(translatedChunks, `${baseName}_vietnamese`, format)
        .then(function(fileName) { addLog(`⬇ Đã tải file: ${fileName}`, 'success'); });
    }

    async function exportAs(chunks, baseName, format) {
      const fullText = chunks.join('\n\n');
      const title = baseName.replace(/_vietnamese$/, '').replaceAll('_', ' ');

      if (format === 'docx') {
        return exportAsDocx(chunks, baseName, title);
      }
      if (format === 'epub') {
        return exportAsEpub(chunks, baseName, title);
      }
      return exportAsTxt(fullText, baseName);
    }

    function exportAsTxt(text, baseName) {
      const fileName = `${baseName}.txt`;
      triggerDownload(new Blob([text], { type: 'text/plain;charset=utf-8' }), fileName);
      return Promise.resolve(fileName);
    }

    async function exportAsDocx(chunks, baseName, title) {
      const fileName = `${baseName}.docx`;
      const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;

      const paragraphs = [
        new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
      ];

      chunks.forEach(function(chunkText, chunkIndex) {
        if (!chunkText) return;
        chunkText.split('\n').forEach(function(line) {
          paragraphs.push(new Paragraph({
            children: [new TextRun({ text: line, size: 24, font: 'Times New Roman' })],
            spacing: { after: line.trim() === '' ? 0 : 120 },
          }));
        });
        if (chunkIndex < chunks.length - 1) {
          paragraphs.push(new Paragraph({ text: '' }));
        }
      });

      const doc = new Document({ sections: [{ properties: {}, children: paragraphs }] });
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
${chunks.filter(Boolean).map(function(chunk) {
  return chunk.split('\n').filter(function(line) { return line.trim(); })
    .map(function(line) { return `<p>${line.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')}</p>`; }).join('\n');
}).join('\n')}
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

      zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
      zip.file('META-INF/container.xml',
        `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
      zip.file('OEBPS/content.opf', opf);
      zip.file('OEBPS/toc.ncx', ncx);
      zip.file('OEBPS/chapter.xhtml', chapterHtml);

      const epubBlob = await zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
      triggerDownload(epubBlob, fileName);
      return fileName;
    }

    function triggerDownload(blob, fileName) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    }

    async function copyResult() {
      const translatedText = translatedChunks.join('\n\n');
      try {
        await navigator.clipboard.writeText(translatedText);
        addLog('📋 Đã sao chép vào clipboard', 'success');
      } catch {
        addLog('Không thể sao chép (hãy thử tải file)', 'warning');
      }
    }

    function resetAll() {
      selectedFile = null;
      fileContent = '';
      translatedChunks = [];
      originalFileName = '';
      cachedStoryAnalysis = null;

      document.getElementById('fileInput').value = '';
      const dropZone = document.getElementById('dropZone');
      dropZone.classList.remove('has-file');
      dropZone.querySelector('.drop-icon').textContent = '📄';
      dropZone.querySelector('.drop-title').textContent = 'Kéo thả file vào đây';
      dropZone.querySelector('.drop-subtitle').textContent = 'hoặc click để chọn file · Hỗ trợ .txt, .md, .text';

      document.getElementById('fileInfo').classList.remove('visible');
      document.getElementById('progressSection').classList.remove('visible');
      document.getElementById('resultSection').classList.remove('visible');
      document.getElementById('progressBarFill').style.width = '0%';
      document.getElementById('logContainer').innerHTML = '';
      const partialBtn = document.getElementById('downloadPartialBtn');
      partialBtn.disabled = true;
      partialBtn.style.opacity = '0.5';
      partialBtn.style.cursor = 'not-allowed';
      document.getElementById('downloadPartialCount').textContent = '0';
      hideError();
    }


    function sleep(ms) {
      return new Promise(function(resolve) {
        return setTimeout(resolve, ms);
      });
    }

    function showError(message) {
      const alertEl = document.getElementById('alertError');
      document.getElementById('alertErrorMsg').textContent = message;
      alertEl.classList.add('visible');
      alertEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function hideError() {
      document.getElementById('alertError').classList.remove('visible');
    }


    document.getElementById('temperature').addEventListener('input', function() {
      document.getElementById('tempValue').textContent = this.value;
      document.getElementById('tempDisplay').textContent = this.value;
    });

    let lastKnownConcurrency = getRuntimeConcurrentRequests();
    function onConcurrentRequestsChanged() {
      const currentConcurrency = getRuntimeConcurrentRequests();
      if (currentConcurrency === lastKnownConcurrency) return;

      lastKnownConcurrency = currentConcurrency;

      if (isTranslationRunning) {
        addLog(`⚙️ Áp dụng ngay: ${currentConcurrency} request song song (request đang chạy sẽ hoàn tất trước).`, 'accent');
      }

      if (isAnalysisRunning && !isWritingStopped) {
        const outputEl = document.getElementById('writingOutput');
        if (outputEl) {
          outputEl.textContent += `⚙️ Cập nhật song song: ${currentConcurrency} request\n`;
          outputEl.scrollTop = outputEl.scrollHeight;
        }
      }
    }
    document.getElementById('concurrentRequests').addEventListener('input', onConcurrentRequestsChanged);
    document.getElementById('concurrentRequests').addEventListener('change', onConcurrentRequestsChanged);


    /* ===== Continue Writing Feature ===== */

    let isWritingStopped = false;
    let continuedChunks = [];
    let cachedStoryAnalysis = null;

    function extractWritingContext(text) {
      const SAMPLE_SIZE = 5000;
      const LAST_CHAPTER_LENGTH = 30000;

      // Lấy 3 mẫu văn phong: đầu, giữa, cuối
      const beginSample = text.slice(0, Math.min(SAMPLE_SIZE, text.length));

      let styleSample = `[ĐẦU TRUYỆN]\n${beginSample}`;

      if (text.length > SAMPLE_SIZE * 3) {
        const middleStart = Math.floor(text.length / 2) - Math.floor(SAMPLE_SIZE / 2);
        const middleSample = text.slice(middleStart, middleStart + SAMPLE_SIZE);
        styleSample += `\n\n[GIỮA TRUYỆN]\n${middleSample}`;

        const nearEndStart = Math.floor(text.length * 0.8);
        const nearEndSample = text.slice(nearEndStart, nearEndStart + SAMPLE_SIZE);
        styleSample += `\n\n[GẦN CUỐI TRUYỆN]\n${nearEndSample}`;
      }

      // Lấy 30K ký tự cuối để AI có đủ context gần nhất
      const lastChapter = text.length > LAST_CHAPTER_LENGTH
        ? text.slice(-LAST_CHAPTER_LENGTH)
        : text;

      return { styleSample, lastChapter };
    }

    /* --- Story Pre-Analysis --- */

    function splitStoryForAnalysis(text) {
      const ANALYSIS_CHUNK_SIZE = 6000;
      const analysisChunks = [];
      let currentPosition = 0;

      while (currentPosition < text.length) {
        let endPosition = currentPosition + ANALYSIS_CHUNK_SIZE;

        if (endPosition < text.length) {
          const paragraphBreak = text.lastIndexOf('\n\n', endPosition);
          if (paragraphBreak > currentPosition + ANALYSIS_CHUNK_SIZE * 0.5) {
            endPosition = paragraphBreak + 2;
          }
        }

        analysisChunks.push(text.slice(currentPosition, endPosition));
        currentPosition = endPosition;
      }

      return analysisChunks;
    }

    async function analyzeChunkContent(chunkText, chunkNumber, totalAnalysisChunks) {
      const systemPrompt = `Bạn là nhà phê bình văn học chuyên nghiệp. Nhiệm vụ: đọc đoạn truyện và trích xuất thông tin cấu trúc.

Trả về CHÍNH XÁC theo format sau (không thêm gì khác):

**SỰ KIỆN:** [Liệt kê các sự kiện chính xảy ra trong đoạn này, theo thứ tự thời gian]

**NHÂN VẬT:** [Tên nhân vật — mô tả ngắn về tính cách, vai trò, hành động trong đoạn này. Nếu có mối quan hệ mới được tiết lộ, ghi rõ]

**BỐI CẢNH:** [Địa điểm, thời gian, không gian diễn ra trong đoạn]

**CẢM XÚC:** [Tông cảm xúc chủ đạo: căng thẳng, lãng mạn, buồn, vui, kịch tính...]

**TUYẾN TRUYỆN:** [Các tuyến truyện đang mở hoặc phát triển trong đoạn này]`;

      const userPrompt = `Đây là đoạn ${chunkNumber}/${totalAnalysisChunks} của truyện. Phân tích đoạn sau:\n\n${chunkText}`;

      return await callWritingApi(systemPrompt, userPrompt);
    }

    async function consolidateAnalysis(chunkSummaries) {
      const allSummaries = chunkSummaries.join('\n\n---\n\n');

      const systemPrompt = `Bạn là nhà phê bình văn học. Nhiệm vụ: tổng hợp các bản phân tích từng đoạn thành MỘT bản phân tích tổng thể.`;

       const userPrompt = `Dưới đây là phân tích các đoạn gần cuối của một truyện dài. Hãy tổng hợp thành BẢN PHÂN TÍCH HOÀN CHỈNH theo format:

**NGÔI KỂ & GIỌNG VĂN:**
- Ngôi kể: [ngôi thứ mấy? Gần gũi hay xa cách?]
- Đại từ chỉ nhân vật chính: ["anh" hay "hắn" hay "y" hay tên riêng?]
- Cách thể hiện suy nghĩ: [xen trực tiếp kiểu "Sao phải làm lớn chuyện đến thế?" hay miêu tả từ ngoài kiểu "Hắn cảm thấy khó chịu"?]
- Tone: [hóm hỉnh/nghiêm túc/nhẹ nhàng/nặng nề?]

**TÓM TẮT CỐT TRUYỆN GẦN ĐÂY:**
[Tóm tắt cốt truyện trong phần được phân tích, ~300 từ]

**HỒ SƠ NHÂN VẬT:**
[Với MỖI nhân vật quan trọng:]
- Tên: [tên]
- Cách xưng hô: [trong truyện gọi như thế nào? "anh", "hắn", "nàng", tên riêng?]
- Tính cách: [mô tả ngắn]
- Mối quan hệ: [quan hệ với các nhân vật khác]
- Tình trạng: [đang làm gì, ở đâu]

**CÁC TUYẾN TRUYỆN ĐANG MỞ:**
[Liệt kê các tuyến truyện chưa kết thúc]

=== CÁC BẢN PHÂN TÍCH TỪNG ĐOẠN ===
${allSummaries}
=== HẾT ===`;

      return await callWritingApi(systemPrompt, userPrompt);
    }

    async function analyzeFullStory(text, updateStatusCallback) {
      // Chỉ phân tích 60K ký tự cuối thay vì toàn bộ — tiết kiệm API và hiệu quả hơn
      const ANALYSIS_WINDOW = 60000;
      const textToAnalyze = text.length > ANALYSIS_WINDOW
        ? text.slice(-ANALYSIS_WINDOW)
        : text;

      const analysisChunks = splitStoryForAnalysis(textToAnalyze);
      const totalAnalysisChunks = analysisChunks.length;

      if (textToAnalyze.length < 20000) {
        updateStatusCallback('Phân tích trực tiếp...');
        const directAnalysis = await analyzeChunkContent(textToAnalyze, 1, 1);
        return directAnalysis;
      }

      const chunkResults = new Array(totalAnalysisChunks).fill(null);
      let nextAnalysisIndex = 0;
      let completedAnalysisCount = 0;
      let activeAnalysisRequests = 0;
      let analysisScheduleTimer = null;
      isAnalysisRunning = true;

      updateStatusCallback(`Đang đọc ${totalAnalysisChunks} đoạn (song song động, có thể đổi khi đang chạy)...`);

      try {
        await new Promise(function(resolve) {
          function queueSchedule(delayMs) {
            if (analysisScheduleTimer !== null) return;
            analysisScheduleTimer = setTimeout(function() {
              analysisScheduleTimer = null;
              scheduleAnalysis();
            }, delayMs);
          }

          function maybeResolve() {
            if ((isWritingStopped || nextAnalysisIndex >= totalAnalysisChunks) && activeAnalysisRequests === 0) {
              resolve();
              return true;
            }
            return false;
          }

          function launchAnalysis(indexToAnalyze) {
            activeAnalysisRequests++;

            (async function() {
              try {
                const summary = await analyzeChunkContent(
                  analysisChunks[indexToAnalyze],
                  indexToAnalyze + 1,
                  totalAnalysisChunks
                );
                chunkResults[indexToAnalyze] = `[Đoạn ${indexToAnalyze + 1}]\n${summary}`;
              } catch (analysisError) {
                chunkResults[indexToAnalyze] = `[Đoạn ${indexToAnalyze + 1}] — Lỗi: ${analysisError.message}`;
              }

              completedAnalysisCount++;
              updateStatusCallback(`Đã đọc ${completedAnalysisCount}/${totalAnalysisChunks} đoạn...`);
            })().finally(function() {
              activeAnalysisRequests--;
              scheduleAnalysis();
            });
          }

          function scheduleAnalysis() {
            if (maybeResolve()) return;

            const desiredConcurrency = getRuntimeConcurrentRequests();
            while (!isWritingStopped && activeAnalysisRequests < desiredConcurrency && nextAnalysisIndex < totalAnalysisChunks) {
              launchAnalysis(nextAnalysisIndex);
              nextAnalysisIndex++;
            }

            if (maybeResolve()) return;

            if (!isWritingStopped && nextAnalysisIndex < totalAnalysisChunks && activeAnalysisRequests < getRuntimeConcurrentRequests()) {
              queueSchedule(120);
            }
          }

          scheduleAnalysis();
        });

        if (isWritingStopped) return null;

        const chunkSummaries = chunkResults.filter(Boolean);
        updateStatusCallback('Đang tổng hợp phân tích...');
        return await consolidateAnalysis(chunkSummaries);
      } finally {
        isAnalysisRunning = false;
      }
    }

    /* --- Prompt Builders --- */

    function buildContinueWritingSystemPrompt(styleSample, storyAnalysis) {
      let prompt = `Bạn là một nhà văn chuyên SAO CHÉP phong cách. Bạn KHÔNG sáng tạo giọng văn mới — bạn NHÁI CHÍNH XÁC giọng văn đã cho.

ĐIỀU QUAN TRỌNG NHẤT — NGÔI KỂ VÀ GIỌNG KỂ:
- XÁC ĐỊNH ngôi kể trong mẫu: ngôi thứ nhất ("tôi"), ngôi thứ ba gần ("anh"), hay ngôi thứ ba xa ("hắn")?
- DÙNG ĐÚNG đại từ cho nhân vật chính như mẫu: nếu mẫu gọi "anh" thì VIẾT "anh", KHÔNG đổi thành "hắn"
- COPY cách thể hiện suy nghĩ: nếu mẫu viết suy nghĩ trực tiếp xen trong văn ("Sao phải làm lớn chuyện đến thế?") thì bạn CŨNG viết kiểu đó, KHÔNG đổi thành "Hắn tự hỏi sao phải làm lớn chuyện"
- COPY khoảng cách người kể: nếu mẫu kể gần gũi như đang ở trong đầu nhân vật, bạn cũng kể gần như vậy

GIỌNG VĂN & NHỊP:
- Tone: SAO CHÉP — nếu mẫu hóm hỉnh thì hóm hỉnh, nếu nghiêm túc thì nghiêm túc
- Nhịp câu: ĐẾM câu dài/ngắn và giữ TỈ LỆ TƯƠNG TỰ
- Mật độ cảm xúc: Dùng ĐÚNG số lượng tính từ cảm xúc như mẫu. KHÔNG THÊM
- Cách xưng hô trong đối thoại: COPY chính xác

LỖI PHỔ BIẾN — TUYỆT ĐỐI KHÔNG LÀM:
❌ Mẫu dùng "anh" cho nhân vật chính → BẠN đổi thành "hắn" ← SAI, sai ngôi kể
❌ Mẫu viết suy nghĩ trực tiếp: "Thật tài giỏi quá!" → BẠN đổi thành: "Hắn cảm thấy thán phục" ← SAI, sai cách thể hiện
❌ Mẫu kể nhẹ nhàng, hóm hỉnh → BẠN viết u ám, drama ← SAI, sai tone
❌ Mẫu miêu tả hành động giản dị → BẠN thêm bầu không khí, ánh sáng, cảm xúc ← SAI
❌ Mẫu không miêu tả ngoại hình chi tiết → BẠN thêm "váy ngắn ôm sát, ngực cao" ← SAI

QUY TẮC VÀNG — ĐỌc lại mẫu, ĐẾM:
- Nhân vật chính được gọi là gì? → Dùng ĐÚNG từ đó
- Suy nghĩ được viết kiểu gì? → COPY kiểu đó
- Bao nhiêu dòng đối thoại vs miêu tả? → Giữ ĐÚNG tỉ lệ
- Có miêu tả bầu không khí/ánh sáng không? → Chỉ thêm nếu mẫu có

QUY TẮC KHÁC:
- Viết tiếp ĐÚNG nhịp truyện — KHÔNG tăng tốc, KHÔNG dồn nén
- KHÔNG tóm tắt, KHÔNG nhảy cóc thời gian
- CHỈ trả về nội dung truyện, KHÔNG giải thích, ghi chú
- KHÔNG bắt đầu bằng "Dưới đây là...", "Tiếp theo..."

=== MẪU VĂN PHONG (HÃY NHÁI CHÍNH XÁC NGÔI KỂ, GIỌNG KỂ, ĐẠI TỪ) ===
${styleSample}
=== HẾT MẪU ===`;

      if (storyAnalysis) {
        prompt += `

=== PHÂN TÍCH TÁC PHẨM ===
${storyAnalysis}
=== HẾT PHÂN TÍCH ===

Hãy sử dụng bản phân tích trên để:
- Dùng ĐÚNG đại từ/cách xưng hô của từng nhân vật như ghi trong phân tích
- Tiếp tục các tuyến truyện đang mở
- Giữ nhất quán với cốt truyện`;
      }

      return prompt;
    }

    function buildContinueWritingUserPrompt(lastChapter, plotDirection, previouslyWritten) {
      let prompt = `Đây là đoạn cuối cùng của truyện:\n\n=== ĐOẠN CUỐI ===\n${lastChapter}\n=== HẾT ===\n\n`;

      if (previouslyWritten) {
        prompt += `Đây là phần bạn đã viết tiếp trước đó (TIẾP TỤC từ đây, KHÔNG lặp lại):\n\n=== ĐÃ VIẾT ===\n${previouslyWritten}\n=== HẾT PHẦN ĐÃ VIẾT ===\n\n`;
      }

      prompt += `Hãy viết tiếp khoảng 1500 từ, giữ ĐÚNG giọng văn và nhịp truyện của tác giả.`;

      if (plotDirection) {
        prompt += `\n\nGợi ý hướng phát triển cốt truyện (chỉ là gợi ý, hãy triển khai tự nhiên theo nhịp truyện):\n${plotDirection}`;
      }

      prompt += `\n\nLưu ý QUAN TRỌNG — đọc kỹ:
- Viết tiếp TỰ NHIÊN ngay từ câu tiếp theo, không lặp lại nội dung đã có
- KHÔNG thêm cảm xúc, tính từ, miêu tả nội tâm NHIỀU HƠN tác giả gốc
- Nếu tác giả gốc viết "Cô ấy đi ra ngoài" — KHÔNG viết "Cô ấy đi ra ngoài, lòng nặng trĩu nỗi buồn"
- Giữ TỈ LỆ đối thoại vs miêu tả ĐÚNG như truyện gốc
- CHỈ trả về nội dung truyện, không ghi chú, không bình luận`;

      return prompt;
    }

    async function callWritingApi(systemPrompt, userPrompt) {
      const apiKey = document.getElementById('apiKey').value.trim();
      const modelName = getSelectedModel();
      const baseUrl = document.getElementById('baseUrl').value.trim().replace(/\/$/, '');
      const temperature = Number.parseFloat(document.getElementById('writingTemperature').value);
      const url = `${baseUrl}/chat/completions`;
      const MAX_RETRIES = 2;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: modelName,
              temperature: temperature,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
              ]
            })
          });

          if (!response.ok) {
            const errorBody = await response.text();
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

          const generatedText = responseData.choices?.[0]?.message?.content;

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

      if (!apiKey) return showError('Vui lòng nhập API key.');
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

      const { styleSample, lastChapter } = extractWritingContext(fileContent);

      // UI setup
      document.getElementById('writingResultSection').classList.add('visible');
      document.getElementById('writingOutput').textContent = '';
      document.getElementById('startWritingBtn').disabled = true;
      document.getElementById('stopWritingBtn').style.display = 'flex';
      document.getElementById('downloadWritingBtn').disabled = true;
      document.getElementById('writingChunkIndicator').style.display = 'inline-flex';
      const partialWritingBtn = document.getElementById('downloadWritingPartialBtn');
      partialWritingBtn.disabled = true;
      partialWritingBtn.style.opacity = '0.5';
      partialWritingBtn.style.cursor = 'not-allowed';
      document.getElementById('writingPartialCount').textContent = '0';

      document.getElementById('writingResultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Phase 1: Story Analysis (if enabled)
      const isAnalysisEnabled = document.getElementById('enableAnalysis').checked;
      let storyAnalysis = null;

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
            document.getElementById('analysisCacheHint').style.display = 'inline';
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
          const userPrompt = buildContinueWritingUserPrompt(
            lastChapter,
            plotDirection,
            accumulatedText
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
          partialBtn.style.opacity = '1';
          partialBtn.style.cursor = 'pointer';

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

    function stopContinueWriting() {
      isWritingStopped = true;
      document.getElementById('writingChunkLabel').textContent = '⏹ Đã dừng';
    }

    function downloadContinuedContent() {
      if (continuedChunks.length === 0) return;
      const format = document.querySelector('input[name="writingExportFormat"]:checked')?.value || 'txt';
      const baseName = originalFileName
        ? originalFileName.replace(/\.[^.]+$/, '') + '_continued'
        : 'continued_story';

      exportAs(continuedChunks, baseName, format);
    }

    function downloadWritingPartial() {
      if (continuedChunks.length === 0) return;
      const format = document.querySelector('input[name="writingPartialFormat"]:checked')?.value || 'txt';
      const baseName = originalFileName
        ? originalFileName.replace(/\.[^.]+$/, '') + '_partial_' + continuedChunks.length + 'parts'
        : 'continued_partial_' + continuedChunks.length + 'parts';

      exportAs(continuedChunks, baseName, format);
    }

    // Cached context for improve/rewrite operations
    let cachedWritingContext = null;

    function renderWritingChunks() {
      const outputEl = document.getElementById('writingOutput');
      outputEl.innerHTML = '';

      continuedChunks.forEach(function renderSingleChunk(chunkText, chunkIdx) {
        const block = document.createElement('div');
        block.className = 'writing-chunk-block';
        block.id = 'chunk-block-' + chunkIdx;

        const header = document.createElement('div');
        header.className = 'chunk-header';

        const label = document.createElement('span');
        label.textContent = 'Đoạn ' + (chunkIdx + 1);

        const actions = document.createElement('div');
        actions.className = 'chunk-actions';

        const improveBtn = document.createElement('button');
        improveBtn.textContent = '✨ Cải thiện';
        improveBtn.onclick = function handleImprove() { improveChunk(chunkIdx); };

        const rewriteBtn = document.createElement('button');
        rewriteBtn.textContent = '🔄 Viết lại';
        rewriteBtn.onclick = function handleRewrite() { rewriteChunk(chunkIdx); };

        actions.appendChild(improveBtn);
        actions.appendChild(rewriteBtn);
        header.appendChild(label);
        header.appendChild(actions);

        const content = document.createElement('div');
        content.className = 'chunk-content';
        content.textContent = chunkText;

        block.appendChild(header);
        block.appendChild(content);
        outputEl.appendChild(block);
      });

      outputEl.scrollTop = outputEl.scrollHeight;
    }

    async function improveChunk(chunkIdx) {
      const originalText = continuedChunks[chunkIdx];
      if (!originalText) return;

      const block = document.getElementById('chunk-block-' + chunkIdx);
      if (block) block.classList.add('is-processing');

      const { styleSample } = extractWritingContext(fileContent);

      const systemPrompt = `Bạn là biên tập viên. Nhiệm vụ: cải thiện đoạn văn dưới đây để GIỐNG giọng văn mẫu hơn.

KHÔNG thay đổi nội dung, cốt truyện, tình tiết. CHỈ cải thiện:
- Ngôi kể, đại từ cho đúng với mẫu
- Cách thể hiện suy nghĩ cho đúng với mẫu
- Giảm miêu tả cảm xúc thừa nếu mẫu không có
- Điều chỉnh tone cho khớp mẫu
- CHỈ trả về đoạn văn đã cải thiện, KHÔNG giải thích

=== MẪU VĂN PHONG ===
${styleSample}
=== HẾT MẪU ===`;

      const userPrompt = `Cải thiện đoạn sau cho giống giọng văn mẫu hơn:

${originalText}`;

      try {
        const improved = await callWritingApi(systemPrompt, userPrompt);
        continuedChunks[chunkIdx] = improved;
        renderWritingChunks();
      } catch (improveError) {
        showError('Lỗi cải thiện: ' + improveError.message);
      }

      if (block) block.classList.remove('is-processing');
    }

    async function rewriteChunk(chunkIdx) {
      const block = document.getElementById('chunk-block-' + chunkIdx);
      if (block) block.classList.add('is-processing');

      const { styleSample, lastChapter } = extractWritingContext(fileContent);
      const plotDirection = document.getElementById('plotDirection').value.trim();
      const storyAnalysis = cachedStoryAnalysis;
      const systemPrompt = buildContinueWritingSystemPrompt(styleSample, storyAnalysis);

      // Build accumulated text from chunks BEFORE this one
      const previousText = continuedChunks.slice(0, chunkIdx).join('\n\n');
      const userPrompt = buildContinueWritingUserPrompt(lastChapter, plotDirection, previousText);

      try {
        const rewritten = await callWritingApi(systemPrompt, userPrompt);
        continuedChunks[chunkIdx] = rewritten;
        renderWritingChunks();
      } catch (rewriteError) {
        showError('Lỗi viết lại: ' + rewriteError.message);
      }

      if (block) block.classList.remove('is-processing');
    }

    async function copyContinuedContent() {
      const text = continuedChunks.join('\n\n');
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        showError(''); // Clear any existing error
        hideError();
        // Brief visual feedback
        const btn = document.querySelector('#writingResultSection .btn-secondary');
        const originalText = btn.innerHTML;
        btn.innerHTML = '<span>✅</span> Đã sao chép!';
        setTimeout(function() { btn.innerHTML = originalText; }, 2000);
      } catch {
        showError('Không thể sao chép vào clipboard.');
      }
    }
