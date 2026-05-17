
    function getRuntimeConfig() {
      return globalThis.TRANSLATOR_CONFIG || {};
    }

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
    let cacheHits = 0;
    let cacheMisses = 0;
    let lastResultText = '';
    let isPreviewExpanded = false;
    let isWritingOutputCollapsed = true;
    let currentFileHash = '';
    let openRouterPricingMap = null;
    let openRouterPricingLoadedAt = 0;
    let usageStats = { promptTokens: 0, completionTokens: 0, totalCost: 0 };

    function hasActiveLongTask() {
      return isTranslationRunning || isAnalysisRunning || isWritingRunning;
    }

    function getActiveProvider() {
      return document.querySelector('.tab.active')?.dataset?.provider || 'openrouter';
    }

    function shouldUseOpenRouterResponseCache(baseUrl, provider) {
      const normalizedBase = (baseUrl || '').toLowerCase();
      return provider === 'openrouter' || normalizedBase.includes('openrouter.ai');
    }

    function getOpenRouterCacheHeaders(baseUrl, provider) {
      if (!shouldUseOpenRouterResponseCache(baseUrl, provider)) return {};
      return {
        'X-OpenRouter-Cache': 'true',
        'X-OpenRouter-Cache-TTL': '300'
      };
    }

    function resetUsageStats() {
      usageStats = { promptTokens: 0, completionTokens: 0, totalCost: 0 };
    }

    function recordUsageFromResponse(responseData) {
      const usage = responseData?.usage;
      if (!usage || typeof usage !== 'object') return;

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
      const config = getRuntimeConfig();
      const provider = config?.defaultProvider || 'openrouter';
      switchProvider(provider);
      const apiKey = config?.keys?.[provider] || '';
      if (apiKey) document.getElementById('apiKey').value = apiKey;
      if (config?.defaultModel) {
        const select = document.getElementById('modelSelect');
        const hasOption = Array.from(select.options).some(function(opt) { return opt.value === config.defaultModel; });
        if (hasOption) {
          select.value = config.defaultModel;
          onModelSelectChange(config.defaultModel);
        }
      }
      updateWritingCostEstimation();
      applySpeedPreset(DEFAULT_SPEED_PRESET, { silent: true, animate: false });
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


    const OPENROUTER_MODEL_GROUPS = {
      mistral_translation: {
        defaultModel: 'mistralai/mistral-small-3.2-24b-instruct',
        models: [
          { id: 'mistralai/mistral-small-3.2-24b-instruct', label: 'Mistral Small 3.2 24B — cân bằng (khuyên dùng)' },
          { id: 'mistralai/mistral-nemo', label: 'Mistral Nemo — rẻ nhất cho batch lớn' },
          { id: 'mistralai/mistral-large-3-2512', label: 'Mistral Large 3 — chất lượng cao hơn' },
          { id: 'mistralai/mistral-small-creative', label: 'Mistral Small Creative — truyện/roleplay' },
          { id: '__custom__', label: '✏️ Nhập model ID...' },
        ]
      },
      grok_budget: {
        defaultModel: 'x-ai/grok-4.1-fast',
        models: [
          { id: 'x-ai/grok-4.1-fast', label: 'Grok 4.1 Fast — Recommended' },
          { id: 'x-ai/grok-4-fast', label: 'Grok 4 Fast — cheap multimodal' },
          { id: 'x-ai/grok-3-mini', label: 'Grok 3 Mini — cheapest reasoning' },
          { id: 'x-ai/grok-4.20', label: 'Grok 4.20 — better quality' },
          { id: '__custom__', label: '✏️ Nhập model ID...' },
        ]
      }
    };

    const PROVIDER_CONFIGS = {
      grok: {
        baseUrl: 'https://api.x.ai/v1',
        defaultModel: 'grok-3-mini',
        hint: 'API key tại console.x.ai',
        models: [
          { id: 'grok-3-mini',      label: 'Grok 3 Mini — nhanh, tiết kiệm' },
          { id: 'grok-3-mini-fast', label: 'Grok 3 Mini Fast — cực nhanh' },
          { id: 'grok-3',           label: 'Grok 3 — ổn định cho tác vụ text' },
          { id: 'grok-3-fast',      label: 'Grok 3 Fast — mạnh + nhanh' },
          { id: '__custom__',       label: '✏️ Nhập model ID...' },
        ]
      },
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini',
        hint: 'ChatGPT/OpenAI API key tại platform.openai.com/api-keys',
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
        defaultModel: 'mistralai/mistral-small-3.2-24b-instruct',
        hint: 'API key tại openrouter.ai/keys — dùng nhóm model Mistral/Grok rẻ',
        models: [
          { id: 'mistralai/mistral-small-3.2-24b-instruct', label: 'Mistral Small 3.2 24B — cân bằng (khuyên dùng)' },
          { id: 'mistralai/mistral-nemo', label: 'Mistral Nemo — rẻ nhất cho batch lớn' },
          { id: 'mistralai/mistral-large-3-2512', label: 'Mistral Large 3 — chất lượng cao hơn' },
          { id: 'mistralai/mistral-small-creative', label: 'Mistral Small Creative — truyện/roleplay' },
          { id: 'x-ai/grok-4.1-fast', label: 'Grok 4.1 Fast — Recommended' },
          { id: 'x-ai/grok-4-fast', label: 'Grok 4 Fast — cheap multimodal' },
          { id: 'x-ai/grok-3-mini', label: 'Grok 3 Mini — cheapest reasoning' },
          { id: 'x-ai/grok-4.20', label: 'Grok 4.20 — better quality' },
          { id: '__custom__', label: '✏️ Nhập model ID...' },
        ]
      },
      huggingface: {
        baseUrl: 'https://router.huggingface.co/v1',
        defaultModel: 'dphn/Dolphin-Mistral-24B-Venice-Edition',
        hint: 'Nhập Hugging Face token dạng hf_... (ô API Key bên trên)',
        models: [
          { id: 'dphn/Dolphin3.0-Qwen2.5-0.5B', label: 'Dolphin 3.0 Qwen2.5 0.5B — rẻ nhất' },
          { id: 'dphn/Dolphin3.0-Qwen2.5-1.5B', label: 'Dolphin 3.0 Qwen2.5 1.5B — rẻ + ổn định' },
          { id: 'dphn/Dolphin3.0-Qwen2.5-3b', label: 'Dolphin 3.0 Qwen2.5 3B — bản nhỏ mạnh hơn' },
          { id: 'dphn/dolphin-2.9.3-mistral-7B-32k', label: 'Dolphin 2.9.3 Mistral 7B 32k — bản cao hơn' },
          { id: 'dphn/dolphin-2.9.3-mistral-nemo-12b', label: 'Dolphin 2.9.3 Mistral Nemo 12B — cân bằng' },
          { id: 'dphn/dolphin-2.9.1-yi-1.5-34b', label: 'Dolphin 2.9.1 Yi 34B — chất lượng cao hơn' },
          { id: 'dphn/Dolphin-Mistral-24B-Venice-Edition', label: 'Dolphin Mistral 24B Venice Edition' },
          { id: 'dphn/dolphin-2.9.2-qwen2-72b', label: 'Dolphin 2.9.2 Qwen2 72B — bản lớn' },
          { id: 'mistralai/Mistral-Small-24B-Instruct-2501', label: 'Mistral Small 24B Instruct 2501' },
          { id: 'mistralai/Mistral-Small-24B-Base-2501', label: 'Mistral Small 24B Base 2501' },
          { id: '__custom__', label: '✏️ Nhập model ID...' },
        ]
      },
    };

    // Model context length limits (in characters, approximate)
    const MODEL_CONTEXT_LIMITS = {
      // Grok
      'grok-3-mini': 128000,
      'grok-3-mini-fast': 128000,
      'grok-3': 128000,
      'grok-3-fast': 128000,
      // OpenAI
      'gpt-4o-mini': 128000,
      'gpt-4o': 128000,
      'o4-mini': 200000,
      'o3-mini': 200000,
      'gpt-4-turbo': 128000,
      // Gemini
      'gemini-2.5-pro-preview-03-25': 1000000,
      'gemini-2.0-flash': 1000000,
      'gemini-2.0-flash-lite': 1000000,
      'gemini-1.5-pro': 2000000,
      // OpenRouter Mistral + Grok curated
      'mistralai/mistral-small-3.2-24b-instruct': 128000,
      'mistralai/mistral-nemo': 128000,
      'mistralai/mistral-large-3-2512': 262000,
      'mistralai/mistral-small-creative': 128000,
      'x-ai/grok-4.1-fast': 2000000,
      'x-ai/grok-4-fast': 2000000,
      'x-ai/grok-4.20': 1000000,
      // Hugging Face models
      'dphn/Dolphin3.0-Qwen2.5-0.5B': 32768,
      'dphn/Dolphin3.0-Qwen2.5-1.5B': 32768,
      'dphn/Dolphin3.0-Qwen2.5-3b': 32768,
      'dphn/dolphin-2.9.3-mistral-7B-32k': 32768,
      'dphn/dolphin-2.9.3-mistral-nemo-12b': 128000,
      'dphn/dolphin-2.9.1-yi-1.5-34b': 128000,
      'dphn/Dolphin-Mistral-24B-Venice-Edition': 131072,
      'dphn/dolphin-2.9.2-qwen2-72b': 128000,
      'mistralai/Mistral-Small-24B-Instruct-2501': 128000,
      'mistralai/Mistral-Small-24B-Base-2501': 128000,
    };

    // Token pricing (USD per 1M tokens) - approximate rates
    const MODEL_PRICING = {
      // Grok (via xAI direct)
      'grok-3-mini': { input: 0.30, output: 0.50 },
      'grok-3-mini-fast': { input: 0.30, output: 0.50 },
      'grok-3': { input: 5.00, output: 15.00 },
      'grok-3-fast': { input: 5.00, output: 15.00 },
      // OpenAI
      'gpt-4o-mini': { input: 0.15, output: 0.60 },
      'gpt-4o': { input: 2.50, output: 10.00 },
      'o4-mini': { input: 1.10, output: 4.40 },
      'o3-mini': { input: 1.10, output: 4.40 },
      'gpt-4-turbo': { input: 10.00, output: 30.00 },
      // Gemini
      'gemini-2.5-pro-preview-03-25': { input: 1.25, output: 5.00 },
      'gemini-2.0-flash': { input: 0.10, output: 0.40 },
      'gemini-2.0-flash-lite': { input: 0.05, output: 0.20 },
      'gemini-1.5-pro': { input: 1.25, output: 5.00 },
      // OpenRouter Mistral + Grok curated
      'mistralai/mistral-small-3.2-24b-instruct': { input: 0.075, output: 0.20 },
      'mistralai/mistral-nemo': { input: 0.02, output: 0.04 },
      'mistralai/mistral-large-3-2512': { input: 0.50, output: 1.50 },
      'mistralai/mistral-small-creative': { input: 0.10, output: 0.30 },
      'x-ai/grok-4.20': { input: 1.25, output: 2.50 },
      // Fallback values; app will auto-refresh live OpenRouter pricing when available.
      'x-ai/grok-4.1-fast': { input: 0.20, output: 0.50 },
      'x-ai/grok-4-fast': { input: 0.20, output: 0.50 },
      // Hugging Face routing varies by provider/hardware; placeholder for estimation UI
      'dphn/Dolphin3.0-Qwen2.5-0.5B': { input: 0.01, output: 0.03 },
      'dphn/Dolphin3.0-Qwen2.5-1.5B': { input: 0.02, output: 0.05 },
      'dphn/Dolphin3.0-Qwen2.5-3b': { input: 0.03, output: 0.08 },
      'dphn/dolphin-2.9.3-mistral-7B-32k': { input: 0.05, output: 0.12 },
      'dphn/dolphin-2.9.3-mistral-nemo-12b': { input: 0.08, output: 0.20 },
      'dphn/dolphin-2.9.1-yi-1.5-34b': { input: 0.20, output: 0.60 },
      'dphn/Dolphin-Mistral-24B-Venice-Edition': { input: 0.20, output: 0.60 },
      'dphn/dolphin-2.9.2-qwen2-72b': { input: 0.50, output: 1.50 },
      'mistralai/Mistral-Small-24B-Instruct-2501': { input: 0.10, output: 0.30 },
      'mistralai/Mistral-Small-24B-Base-2501': { input: 0.10, output: 0.30 },
    };

    async function ensureOpenRouterPricingLoaded() {
      const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
      if (openRouterPricingMap && (Date.now() - openRouterPricingLoadedAt) < CACHE_TTL_MS) {
        return openRouterPricingMap;
      }

      try {
        const response = await fetch('https://openrouter.ai/api/v1/models');
        if (!response.ok) return openRouterPricingMap;
        const payload = await response.json();
        const data = Array.isArray(payload?.data) ? payload.data : [];
        const map = {};

        data.forEach(function(modelInfo) {
          const id = modelInfo?.id;
          const promptPerToken = Number(modelInfo?.pricing?.prompt);
          const completionPerToken = Number(modelInfo?.pricing?.completion);
          if (!id || !Number.isFinite(promptPerToken) || !Number.isFinite(completionPerToken)) return;

          map[id] = {
            input: promptPerToken * 1000000,
            output: completionPerToken * 1000000
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
      return MODEL_PRICING[model] || { input: 0.10, output: 0.20 }; // conservative default
    }

    function normalizeChunkForCache(content) {
      return content
        .replace(/\r\n/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .trim();
    }

    // Stable hash function for caching
    async function hashContent(content) {
      const encoder = new TextEncoder();
      const data = encoder.encode(normalizeChunkForCache(content));
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function shouldSkipTranslation(chunkText) {
      const text = (chunkText || '').trim();
      if (!text) return true;
      // Skip chunks that are mainly separators/punctuation/numbers
      const letters = text.match(/[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/g);
      return !letters || letters.length < 8;
    }

    function getMaxTokensForTranslation(chunkText) {
      const estimatedInputTokens = estimateTokenCount((chunkText || '').length);
      const softCap = Math.ceil(estimatedInputTokens * 1.35 + 120);
      return Math.min(12000, Math.max(300, softCap));
    }

    function getTailContext(text, maxChars) {
      if (!text) return '';
      if (text.length <= maxChars) return text;

      const sliceStart = text.length - maxChars;
      const boundary = text.indexOf('\n\n', sliceStart);
      if (boundary !== -1 && boundary < text.length - 200) {
        return text.slice(boundary + 2);
      }

      return text.slice(sliceStart);
    }

    function getMaxTokensForWriting(systemPrompt, userPrompt) {
      const modelName = getSelectedModel();
      const contextLimit = MODEL_CONTEXT_LIMITS[modelName] || 32000;
      const inputTokens = estimateTokenCount((systemPrompt || '').length + (userPrompt || '').length);
      const reservedTokens = Math.max(500, Math.floor(contextLimit * 0.12));
      const available = contextLimit - inputTokens - reservedTokens;
      const dynamicCap = Math.floor(available * 0.9);

      return Math.max(500, Math.min(3200, dynamicCap));
    }

    function extractAssistantText(responseData) {
      const directContent = responseData?.choices?.[0]?.message?.content;
      if (typeof directContent === 'string' && directContent.trim()) return directContent;
      if (Array.isArray(directContent)) {
        const joined = directContent
          .map(function(part) { return typeof part?.text === 'string' ? part.text : ''; })
          .join('')
          .trim();
        if (joined) return joined;
      }

      const altText = responseData?.choices?.[0]?.text;
      if (typeof altText === 'string' && altText.trim()) return altText;

      const outputText = responseData?.output_text;
      if (typeof outputText === 'string' && outputText.trim()) return outputText;

      return '';
    }

    function normalizeTranslatedText(text) {
      if (!text) return '';
      let output = text.trim();
      // Some providers still wrap in markdown fences; strip for cleaner export.
      output = output.replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/, '');
      return output.trim();
    }

    // Caching system using localStorage
    const CACHE_PREFIX = 'translator_cache_';
    const CACHE_VERSION = '1';
    const STORY_ANALYSIS_CACHE_PREFIX = 'story_analysis_cache_v1:';

    function getCacheKey(chunkHash, model, provider) {
      return `${CACHE_PREFIX}${CACHE_VERSION}:${provider}:${model}:${chunkHash}`;
    }

    async function getCachedTranslation(chunkHash, model, provider, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
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
        console.warn('Cache read error:', e);
        return null;
      }
    }

    async function setCacheTranslation(chunkHash, model, provider, translation) {
      try {
        const key = getCacheKey(chunkHash, model, provider);
        const entry = {
          translation,
          timestamp: Date.now()
        };
        localStorage.setItem(key, JSON.stringify(entry));
      } catch (e) {
        // Storage quota exceeded or disabled
        console.warn('Cache write error:', e);
      }
    }

    function getStoryAnalysisCacheKey(fileHash) {
      if (!fileHash) return '';
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
        localStorage.setItem(key, JSON.stringify({
          analysis,
          timestamp: Date.now()
        }));
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

    function updateCostEstimation() {
      const fileInfoEl = document.getElementById('fileInfo');
      const costCard = document.getElementById('costEstimationCard');
      const costContent = document.getElementById('costEstimationContent');

      if (!fileContent || !fileInfoEl.classList.contains('visible')) {
        costCard.style.display = 'none';
        return;
      }

      const model = getSelectedModel();
      const provider = getActiveProvider();
      const chunkSize = Number.parseInt(document.getElementById('chunkSize').value, 10) || 6000;
      const chunks = splitIntoChunks(fileContent, chunkSize);
      const totalChunks = chunks.length;
      const systemPrompt = document.getElementById('systemPrompt').value.trim();

      const promptOverheadChars = systemPrompt.length + 'Dịch sang tiếng Việt, giữ nguyên format xuống dòng. Chỉ trả về bản dịch:\n\n'.length;
      const retryBufferFactor = 1.08;
      const outputExpansionFactor = 1.10;

      let estimatedInputChars = 0;
      let estimatedOutputChars = 0;

      chunks.forEach(function(chunk) {
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
      const hasActualUsage = usageStats.promptTokens > 0 || usageStats.completionTokens > 0 || usageStats.totalCost > 0;
      const actualCost = usageStats.totalCost > 0
        ? usageStats.totalCost
        : estimateCost(usageStats.promptTokens * 3, model, true) + estimateCost(usageStats.completionTokens * 3, model, false);

      costContent.innerHTML = `
        <div class="cost-item">
          <span class="cost-label">📄 Tổng ký tự</span>
          <span class="cost-value">${fileContent.length.toLocaleString('vi-VN')}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">🔢 Số đoạn dự kiến</span>
          <span class="cost-value">${totalChunks}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">📥 Token đầu vào (ước)</span>
          <span class="cost-value">${totalInputTokens.toLocaleString('vi-VN')}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">📤 Token đầu ra (ước)</span>
          <span class="cost-value">${totalOutputTokens.toLocaleString('vi-VN')}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">💰 Chi phí ước tính</span>
          <span class="cost-value highlight">$${totalCost.toFixed(4)} USD</span>
        </div>
        ${hasActualUsage ? `
        <div class="cost-item">
          <span class="cost-label">🧾 Token thực tế (đã chạy)</span>
          <span class="cost-value">${Math.round(usageStats.promptTokens).toLocaleString('vi-VN')} in · ${Math.round(usageStats.completionTokens).toLocaleString('vi-VN')} out</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">💳 Chi phí thực tế (đã chạy)</span>
          <span class="cost-value highlight">$${actualCost.toFixed(4)} USD</span>
        </div>
        ` : ''}
        ${hasLowPricing ? `<div class="cost-note">✅ Model này có mức giá thấp, phù hợp dịch lớn</div>` : ''}
      `;

      costCard.style.display = 'block';
    }

    function updateWritingCostEstimation() {
      const estimateEl = document.getElementById('writingCostEstimate');
      if (!estimateEl) return;

      if (!fileContent) {
        estimateEl.innerHTML = '⏳ Tải file để xem ước tính token viết tiếp.';
        return;
      }

      const model = getSelectedModel();
      const provider = getActiveProvider();
      const chunkCount = Number.parseInt(document.getElementById('writingChunkCount')?.value, 10) || 1;
      const safeChunkCount = Math.max(1, Math.min(100, chunkCount));
      const plotDirection = document.getElementById('plotDirection')?.value?.trim() || '';
      const isAnalysisEnabled = Boolean(document.getElementById('enableAnalysis')?.checked);
      const budgets = getWritingContextBudgets(model);
      const { styleSample, lastChapter } = extractWritingContext(fileContent, budgets);

      const estimatedAnalysisChars = isAnalysisEnabled
        ? (cachedStoryAnalysis ? cachedStoryAnalysis.length : 4000)
        : 0;
      const baseSystemPrompt = buildContinueWritingSystemPrompt(styleSample, null);
      const syntheticSystemPrompt = baseSystemPrompt + (estimatedAnalysisChars > 0 ? `\n${'x'.repeat(Math.min(estimatedAnalysisChars, 12000))}` : '');
      const firstUserPrompt = buildContinueWritingUserPrompt(lastChapter, plotDirection, '', 0);

      const inputPerChunk = estimateTokenCount(syntheticSystemPrompt.length + firstUserPrompt.length);
      const tailCarryPerChunk = estimateTokenCount(budgets.previousTailLength);
      const estimatedTotalInput = inputPerChunk * safeChunkCount + Math.max(0, safeChunkCount - 1) * tailCarryPerChunk;

      const maxTokensPerChunk = getMaxTokensForWriting(syntheticSystemPrompt, firstUserPrompt);
      const estimatedTotalOutput = maxTokensPerChunk * safeChunkCount;

      let analysisInputTokens = 0;
      let analysisOutputTokens = 0;
      if (isAnalysisEnabled && !cachedStoryAnalysis) {
        const analysisWindowChars = Math.min(fileContent.length, 60000);
        const analysisChunkCount = Math.ceil(analysisWindowChars / 6000);
        analysisInputTokens = estimateTokenCount(
          analysisWindowChars +
          analysisChunkCount * 900 +
          Math.floor(analysisWindowChars * 0.3)
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
      const providerLabel = provider === 'openrouter' ? 'OpenRouter' : provider;
      const analysisLabel = isAnalysisEnabled
        ? (cachedStoryAnalysis ? 'bật (dùng cache)' : 'bật (ước tính có gọi phân tích)')
        : 'tắt';

      estimateEl.innerHTML = `
        💡 Viết tiếp (${safeChunkCount} đoạn) · model ${model}<br>
        Ước tính token: vào ~${totalInputTokens.toLocaleString('vi-VN')} · ra ~${totalOutputTokens.toLocaleString('vi-VN')} · trần mỗi đoạn ~${maxTokensPerChunk.toLocaleString('vi-VN')}<br>
        Ước tính chi phí: <strong>~$${totalCost.toFixed(4)}</strong> (in $${inputCost.toFixed(4)} + out $${outputCost.toFixed(4)}) · provider ${providerLabel} · phân tích ${analysisLabel}
      `;
    }

    function buildModelDropdown(provider) {
      const select = document.getElementById('modelSelect');
      const config = PROVIDER_CONFIGS[provider];
      let models = config.models;

      if (provider === 'openrouter') {
        const groupSelect = document.getElementById('openrouterModelGroup');
        const groupKey = groupSelect?.value || 'mistral_translation';
        models = OPENROUTER_MODEL_GROUPS[groupKey]?.models || config.models;
      }

      select.innerHTML = '';
      models.forEach(function(modelInfo) {
        const option = document.createElement('option');
        option.value = modelInfo.id;
        option.textContent = modelInfo.label;
        select.appendChild(option);
      });
      if (provider === 'openrouter') {
        const groupSelect = document.getElementById('openrouterModelGroup');
        const groupKey = groupSelect?.value || 'mistral_translation';
        const defaultGroupModel = OPENROUTER_MODEL_GROUPS[groupKey]?.defaultModel || config.defaultModel;
        select.value = defaultGroupModel;
      } else {
        select.value = config.defaultModel;
      }
      onModelSelectChange(select.value);
    }

    function onOpenRouterGroupChange() {
      const activeProvider = document.querySelector('.tab.active')?.dataset?.provider;
      if (activeProvider === 'openrouter') {
        buildModelDropdown('openrouter');
        ensureOpenRouterPricingLoaded().then(function() {
          if (fileContent) {
            updateCostEstimation();
            updateWritingCostEstimation();
          }
        });
      }
    }

    function onModelSelectChange(selectedValue) {
      const isCustom = selectedValue === '__custom__';
      document.getElementById('customModelGroup').style.display = isCustom ? 'block' : 'none';
      if (!isCustom) {
        document.getElementById('modelName').value = selectedValue;
      }
      // Update cost estimation when model changes
      if (fileContent) {
        updateCostEstimation();
        updateWritingCostEstimation();
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
      const openrouterSubGroupEl = document.getElementById('openrouterSubGroup');
      document.getElementById('baseUrl').value = config.baseUrl;
      document.getElementById('modelHint').textContent = config.hint;
      openrouterSubGroupEl.style.display = provider === 'openrouter' ? 'block' : 'none';
      buildModelDropdown(provider);
      loadSavedApiKey(provider);

      if (provider === 'openrouter') {
        ensureOpenRouterPricingLoaded().then(function() {
          if (fileContent) {
            updateCostEstimation();
            updateWritingCostEstimation();
          }
        });
      }

      document.querySelectorAll('.tab').forEach(function(tab) {
        tab.classList.toggle('active', tab.dataset.provider === provider);
      });

      // Update cost estimation when provider changes
      if (fileContent) {
        updateCostEstimation();
        updateWritingCostEstimation();
      }
    }


    function toggleApiKeyVisibility() {
      const apiKeyInput = document.getElementById('apiKey');
      const isPassword = apiKeyInput.type === 'password';
      apiKeyInput.type = isPassword ? 'text' : 'password';
      document.getElementById('toggleApiKeyBtn').textContent = isPassword ? '🙈' : '👁';
    }

    function saveApiKey() {
      const provider = getActiveProvider();
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
      const configKey = getRuntimeConfig()?.keys?.[provider] || '';
      const savedKey = localStorage.getItem('translator_api_key_' + provider);
      const keyToUse = savedKey || configKey;
      const hint = document.getElementById('keySavedHint');
      if (keyToUse) {
        document.getElementById('apiKey').value = keyToUse;
        hint.textContent = savedKey ? '💾 Đã load key đã lưu cho ' + provider : '🔑 Key từ cấu hình runtime';
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
      currentFileHash = '';
      resetUsageStats();
      const cacheHint = document.getElementById('analysisCacheHint');
      if (cacheHint) cacheHint.style.display = 'none';

      const reader = new FileReader();
      reader.onload = async function(event) {
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

        // Update cost estimation
        updateCostEstimation();
        updateWritingCostEstimation();

        try {
          currentFileHash = await hashContent(fileContent);
        } catch {
          currentFileHash = '';
        }

        const persistedAnalysis = getCachedStoryAnalysis(currentFileHash);
        if (persistedAnalysis) {
          cachedStoryAnalysis = persistedAnalysis;
          if (cacheHint) {
            cacheHint.textContent = ' ✅ Đã có bản phân tích cache (sẽ dùng lại)';
            cacheHint.style.display = 'inline';
          }
        }

        updateWritingCostEstimation();
      };
      reader.readAsText(file, 'UTF-8');
    }

    function estimateChunks(charCount) {
      const chunkSize = Number.parseInt(document.getElementById('chunkSize').value, 10) || 6000;
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

    function resetCacheStats() {
      cacheHits = 0;
      cacheMisses = 0;
      updateCacheStatsUI();
    }

    function updateCacheStatsUI() {
      const cacheStatEl = document.getElementById('cacheStat');
      if (cacheStatEl) {
        if (cacheHits > 0 || cacheMisses > 0) {
          cacheStatEl.textContent = `Cache: ${cacheHits} hit, ${cacheMisses} miss`;
          cacheStatEl.style.display = 'inline';
        } else {
          cacheStatEl.style.display = 'none';
        }
      }
    }


    async function translateChunkWithRetry(chunk, chunkIndex, maxRetries, chunkHash = null) {
      const apiKey = document.getElementById('apiKey').value.trim();
      const modelName = getSelectedModel();
      const provider = getActiveProvider();
      const baseUrl = document.getElementById('baseUrl').value.trim().replace(/\/$/, '');
      const systemPrompt = document.getElementById('systemPrompt').value.trim();
      const temperature = Number.parseFloat(document.getElementById('temperature').value);

      const url = `${baseUrl}/chat/completions`;
      let currentChunk = chunk;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
              ...getOpenRouterCacheHeaders(baseUrl, provider)
            },
            body: JSON.stringify({
              model: modelName,
              temperature: temperature,
              max_tokens: getMaxTokensForTranslation(currentChunk),
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `Dịch sang tiếng Việt, giữ nguyên format xuống dòng. Chỉ trả về bản dịch:\n\n${currentChunk}` }
              ]
            })
          });

          if (!response.ok) {
            const errorBody = await response.text();
            try {
              const parsed = JSON.parse(errorBody);
              const code = parsed?.error?.code;
              if (code === 'model_not_supported') {
                const modelLabel = getSelectedModel();
                throw new Error(`Model "${modelLabel}" không hỗ trợ chat/completions trên Hugging Face Router. Hãy chọn model khác trong danh sách.`);
              }
              if (code === 'model_not_found') {
                const modelLabel = getSelectedModel();
                throw new Error(`Model "${modelLabel}" không tồn tại hoặc không khả dụng với provider hiện tại.`);
              }
            } catch {
              // Ignore parse issues and use raw error below.
            }
            const error = new Error(`HTTP ${response.status}: ${errorBody}`);
            error.status = response.status;
            throw error;
          }

          const responseData = await response.json();
          recordUsageFromResponse(responseData);
          const translatedText = normalizeTranslatedText(extractAssistantText(responseData));

          if (!translatedText) {
            throw new Error('Phản hồi API không hợp lệ');
          }

          // Cache the successful translation
          if (chunkHash) {
            await setCacheTranslation(chunkHash, modelName, provider, translatedText);
          }

          return translatedText;

        } catch (translationError) {
          const isRateLimit = translationError.status === 429;
          const isContextError = translationError.status === 400 &&
            (translationError.message.includes('context') ||
             translationError.message.includes('too long') ||
             translationError.message.includes('maximum'));

          if (isRateLimit && attempt < maxRetries) {
            // Exponential backoff with jitter
            const baseDelay = Math.min(5000 * Math.pow(2, attempt), 30000);
            const jitter = Math.random() * 1000;
            addLog(`  ⚠ Đoạn ${chunkIndex + 1}: Rate limit, thử lại sau ${(baseDelay/1000).toFixed(1)}s...`, 'warning');
            await sleep(baseDelay + jitter);
            continue;
          }

          if (isContextError && currentChunk.length > 1000 && attempt < maxRetries) {
            // Trim chunk by 20% and retry
            const originalLength = currentChunk.length;
            currentChunk = currentChunk.slice(0, Math.floor(currentChunk.length * 0.8));
            addLog(`  ⚠ Đoạn ${chunkIndex + 1}: Context quá dài (${originalLength}→${currentChunk.length}), thử lại...`, 'warning');
            continue;
          }

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
      const provider = document.querySelector('.tab.active')?.dataset?.provider || 'openrouter';
      const model = getSelectedModel();

      // Reset cache stats for this translation run
      resetCacheStats();

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

        async function launchChunk(currentIndex) {
          const chunk = chunks[currentIndex];
          activeRequests++;

          try {
            if (shouldSkipTranslation(chunk)) {
              results[currentIndex] = chunk;
              translatedChunks[currentIndex] = chunk;
              completedChunks++;
              updateProgress();
              addLog(`↷ Bỏ qua đoạn ${currentIndex + 1} (không cần dịch)`, 'info');
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
              addLog(`✓ [CACHE] Đoạn ${currentIndex + 1}`, 'success');
            } else {
              cacheMisses++;
              addLog(`▶ Đang dịch đoạn ${currentIndex + 1}/${chunks.length}...`, 'info');
              const translatedText = await translateChunkWithRetry(chunk, currentIndex, 3, chunkHash);
              results[currentIndex] = translatedText;
              translatedChunks[currentIndex] = translatedText;
              completedChunks++;
              updateProgress();
              updateCacheStatsUI();
              addLog(`✓ Hoàn thành đoạn ${currentIndex + 1}`, 'success');
            }
            const delayMs = Number.parseInt(document.getElementById('delayBetweenChunks').value, 10) || 0;
            if (delayMs > 0 && !isStopped) {
              await sleep(delayMs);
            }
          } catch (chunkError) {
            results[currentIndex] = `[LỖI DỊCH ĐOẠN ${currentIndex + 1}: ${chunkError.message}]\n\n${chunk}`;
            translatedChunks[currentIndex] = results[currentIndex];
            completedChunks++;
            updateProgress();
            addLog(`✗ Lỗi đoạn ${currentIndex + 1}: ${chunkError.message}`, 'error');
          } finally {
            activeRequests--;
            schedule();
          }
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
      }

      if (startTime && completedChunks > 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = completedChunks / elapsed;
        const remaining = (totalChunks - completedChunks) / rate;
        document.getElementById('statEta').textContent = formatTime(remaining);
        document.getElementById('statSpeed').textContent = `${rate.toFixed(2)} đoạn/s`;
      } else {
        document.getElementById('statSpeed').textContent = '--';
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
      resetUsageStats();
      requestWakeLock('start-translation');
      startTime = Date.now();
      completedChunks = 0;
      translatedChunks = [];

      // Reset and show cache stats
      resetCacheStats();
      updateCacheStatsUI();
      document.getElementById('cacheStatsContainer').style.display = 'block';

      // Update cost estimation with current settings
      updateCostEstimation();

      const chunks = splitIntoChunks(fileContent, chunkSize);
      totalChunks = chunks.length;

      document.getElementById('progressSection').classList.add('visible');
      document.getElementById('resultSection').classList.remove('visible');
      document.getElementById('startBtn').disabled = true;
      document.getElementById('stopBtn').style.display = 'flex';
      document.getElementById('progressLabel').textContent = 'Đang dịch...';
      document.getElementById('logContainer').innerHTML = '';
      document.getElementById('progressSection').scrollIntoView({ behavior: 'smooth', block: 'start' });

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
          updateCostEstimation();
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

    const SPEED_PRESETS = {
      turbo:    { concurrent: 20, delay: 0,    chunkSize: 8000, temperature: 0.3 },
      balanced: { concurrent: 10, delay: 100,  chunkSize: 6000, temperature: 0.3 },
      safe:     { concurrent: 4,  delay: 600,  chunkSize: 5000, temperature: 0.2 },
      economy:  { concurrent: 2,  delay: 1200, chunkSize: 6000, temperature: 0.2 },
    };
    const DEFAULT_SPEED_PRESET = 'balanced';

    function markActiveSpeedPreset(preset, animate) {
      const buttons = document.querySelectorAll('.speed-preset-btn[data-speed-preset]');
      buttons.forEach(function(button) {
        const isActive = button.dataset.speedPreset === preset;
        button.classList.toggle('active', isActive);
        if (isActive && animate) {
          button.classList.remove('is-applying');
          requestAnimationFrame(function() {
            button.classList.add('is-applying');
            setTimeout(function() { button.classList.remove('is-applying'); }, 460);
          });
        } else {
          button.classList.remove('is-applying');
        }
      });
    }

    function clearSpeedPresetHighlight() {
      const buttons = document.querySelectorAll('.speed-preset-btn[data-speed-preset]');
      buttons.forEach(function(button) {
        button.classList.remove('active', 'is-applying');
      });
    }

    function applySpeedPreset(preset, options) {
      const opts = options || {};
      const silent = Boolean(opts.silent);
      const animate = opts.animate !== false;
      const settings = SPEED_PRESETS[preset];
      if (!settings) return;
      document.getElementById('concurrentRequests').value = settings.concurrent;
      document.getElementById('delayBetweenChunks').value = settings.delay;
      document.getElementById('temperature').value = settings.temperature;
      document.getElementById('tempDisplay').textContent = settings.temperature;
      document.getElementById('tempValue').textContent = settings.temperature;
      markActiveSpeedPreset(preset, animate);
      if (!isStopped && completedChunks === 0) {
        // Auto-adjust chunk size based on model if economy preset
        if (preset === 'economy') {
          const model = getSelectedModel();
          const optimalSize = getOptimalChunkSize(model);
          document.getElementById('chunkSize').value = Math.min(optimalSize, 8000);
        } else {
          document.getElementById('chunkSize').value = settings.chunkSize;
        }
      }
      if (!silent) {
        addLog(`⚡ Preset "${preset}": ${settings.concurrent} song song · ${settings.delay}ms delay · temp ${settings.temperature}${completedChunks === 0 ? ` · chunk ${document.getElementById('chunkSize').value}` : ' (chunk size giữ nguyên vì đang dịch)'}`, 'accent');
      }
    }

    function stopTranslation() {
      isStopped = true;
      addLog('Đang dừng... (hoàn thành các yêu cầu đang chạy)', 'warning');
    }


    function showResult(translatedText) {
      lastResultText = translatedText || '';
      isPreviewExpanded = false;
      const charCount = translatedText.length.toLocaleString('vi-VN');
      const elapsed = formatTime((Date.now() - startTime) / 1000);

      document.getElementById('resultSummary').textContent =
        `Dịch hoàn tất ${totalChunks} đoạn trong ${elapsed} · ${charCount} ký tự`;

      renderResultPreview();
      updateCostEstimation();

      document.getElementById('resultSection').classList.add('visible');
      document.getElementById('resultSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function renderResultPreview() {
      const previewEl = document.getElementById('resultPreview');
      const toggleBtn = document.getElementById('togglePreviewBtn');
      if (!previewEl || !toggleBtn) return;

      const hasLongText = lastResultText.length > 500;
      const displayText = isPreviewExpanded || !hasLongText
        ? lastResultText
        : lastResultText.slice(0, 500) + '\n\n[...]';

      previewEl.textContent = displayText;
      previewEl.classList.toggle('full', isPreviewExpanded);
      toggleBtn.style.display = hasLongText ? 'inline-flex' : 'none';
      toggleBtn.textContent = isPreviewExpanded ? 'Thu gọn xem trước' : 'Mở rộng xem trước';
    }

    function toggleFullPreview() {
      isPreviewExpanded = !isPreviewExpanded;
      renderResultPreview();
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
      document.getElementById('costEstimationCard').style.display = 'none';
      document.getElementById('cacheStatsContainer').style.display = 'none';
      document.getElementById('progressSection').classList.remove('visible');
      document.getElementById('resultSection').classList.remove('visible');
      document.getElementById('progressBarFill').style.width = '0%';
      document.getElementById('logContainer').innerHTML = '';
      const partialBtn = document.getElementById('downloadPartialBtn');
      partialBtn.disabled = true;
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
      clearSpeedPresetHighlight();
    });

    let lastKnownConcurrency = getRuntimeConcurrentRequests();
    function onConcurrentRequestsChanged() {
      const currentConcurrency = getRuntimeConcurrentRequests();
      if (currentConcurrency === lastKnownConcurrency) return;

      lastKnownConcurrency = currentConcurrency;
      clearSpeedPresetHighlight();

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
    document.getElementById('delayBetweenChunks').addEventListener('input', clearSpeedPresetHighlight);
    document.getElementById('modelName').addEventListener('input', function() {
      if (fileContent) {
        updateCostEstimation();
        updateWritingCostEstimation();
      }
    });
    document.getElementById('writingChunkCount').addEventListener('input', updateWritingCostEstimation);
    document.getElementById('plotDirection').addEventListener('input', updateWritingCostEstimation);
    document.getElementById('enableAnalysis').addEventListener('change', updateWritingCostEstimation);


    /* ===== Continue Writing Feature ===== */

    let isWritingStopped = false;
    let continuedChunks = [];
    let cachedStoryAnalysis = null;

    function getWritingContextBudgets(modelName) {
      const contextLimit = MODEL_CONTEXT_LIMITS[modelName] || 32000;

      if (contextLimit <= 32768) {
        return { sampleSize: 1200, lastChapterLength: 4500, previousTailLength: 1200 };
      }
      if (contextLimit <= 64000) {
        return { sampleSize: 1800, lastChapterLength: 7000, previousTailLength: 2000 };
      }
      return { sampleSize: 2500, lastChapterLength: 10000, previousTailLength: 3500 };
    }

    function extractWritingContext(text, budgets) {
      const SAMPLE_SIZE = budgets?.sampleSize || 2500;
      const LAST_CHAPTER_LENGTH = budgets?.lastChapterLength || 10000;

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

      // Chỉ giữ cửa sổ ngữ cảnh gần cuối để giảm token lặp.
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

    function buildContinueWritingUserPrompt(lastChapter, plotDirection, previousTail, writtenChunkCount) {
      let prompt = `Đây là đoạn cuối cùng của truyện:\n\n=== ĐOẠN CUỐI ===\n${lastChapter}\n=== HẾT ===\n\n`;

      if (previousTail) {
        prompt += `Đây là phần đuôi bạn đã viết tiếp trước đó (${writtenChunkCount} đoạn trước, chỉ đưa phần gần nhất để tránh lặp):\n\n=== ĐUÔI PHẦN ĐÃ VIẾT ===\n${previousTail}\n=== HẾT ĐUÔI ===\n\n`;
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
      const provider = getActiveProvider();
      const baseUrl = document.getElementById('baseUrl').value.trim().replace(/\/$/, '');
      const temperature = Number.parseFloat(document.getElementById('writingTemperature').value);
      const maxTokens = getMaxTokensForWriting(systemPrompt, userPrompt);
      const url = `${baseUrl}/chat/completions`;
      const MAX_RETRIES = 2;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
              ...getOpenRouterCacheHeaders(baseUrl, provider)
            },
            body: JSON.stringify({
              model: modelName,
              temperature: temperature,
              max_tokens: maxTokens,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
              ]
            })
          });

          if (!response.ok) {
            const errorBody = await response.text();
            try {
              const parsed = JSON.parse(errorBody);
              const code = parsed?.error?.code;
              if (code === 'model_not_supported') {
                throw new Error('Model hiện tại không hỗ trợ chat/completions. Hãy đổi model khác trong dropdown.');
              }
            } catch {
              // Keep fallback error below.
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

    function setWritingOutputCollapsed(collapsed) {
      isWritingOutputCollapsed = Boolean(collapsed);
      const outputEl = document.getElementById('writingOutput');
      const toggleBtn = document.getElementById('toggleWritingOutputBtn');
      if (!outputEl || !toggleBtn) return;

      outputEl.classList.toggle('is-collapsed', isWritingOutputCollapsed);
      toggleBtn.textContent = isWritingOutputCollapsed ? 'Mở nội dung' : 'Thu gọn nội dung';
    }

    function toggleWritingOutput() {
      setWritingOutputCollapsed(!isWritingOutputCollapsed);
    }

    async function improveChunk(chunkIdx) {
      const originalText = continuedChunks[chunkIdx];
      if (!originalText) return;

      const block = document.getElementById('chunk-block-' + chunkIdx);
      if (block) block.classList.add('is-processing');

      const modelName = getSelectedModel();
      const writingBudgets = getWritingContextBudgets(modelName);
      const { styleSample } = extractWritingContext(fileContent, writingBudgets);

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

      const modelName = getSelectedModel();
      const writingBudgets = getWritingContextBudgets(modelName);
      const { styleSample, lastChapter } = extractWritingContext(fileContent, writingBudgets);
      const plotDirection = document.getElementById('plotDirection').value.trim();
      const storyAnalysis = cachedStoryAnalysis;
      const systemPrompt = buildContinueWritingSystemPrompt(styleSample, storyAnalysis);

      // Build accumulated text from chunks BEFORE this one
      const previousText = continuedChunks.slice(0, chunkIdx).join('\n\n');
      const previousTail = getTailContext(previousText, writingBudgets.previousTailLength);
      const userPrompt = buildContinueWritingUserPrompt(lastChapter, plotDirection, previousTail, chunkIdx);

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
