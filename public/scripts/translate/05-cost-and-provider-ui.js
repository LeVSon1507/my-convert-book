function updateCostEstimation() {
  const fileInfoEl = document.getElementById("fileInfo");
  const costCard = document.getElementById("costEstimationCard");
  const costContent = document.getElementById("costEstimationContent");

  if (!fileContent || !fileInfoEl.classList.contains("visible")) {
    costCard.style.display = "none";
    return;
  }

  const model = getSelectedModel();
  const provider = getActiveProvider();
  const chunkSize =
    Number.parseInt(document.getElementById("chunkSize").value, 10) || 6000;
  const fullChunks = splitIntoChunks(fileContent, chunkSize);
  const chunks = applyTranslationScope(fullChunks);
  const totalChunks = chunks.length;
  const scopePercent = getTranslationScopePercent();
  const systemPrompt = document.getElementById("systemPrompt").value.trim();
  const glossaryPairs = parseGlossaryInput(
    document.getElementById("glossaryInput")?.value || "",
  );
  const glossaryInstruction = buildGlossaryInstruction(glossaryPairs);

  const promptOverheadChars =
    (systemPrompt + glossaryInstruction).length +
    buildTranslationUserPrompt("[CHUNK]", false).length;
  const retryBufferFactor = 1.08;
  const outputExpansionFactor = 1.1;

  let estimatedInputChars = 0;
  let estimatedOutputChars = 0;

  chunks.forEach(function (chunk) {
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
  const hasActualUsage =
    usageStats.promptTokens > 0 ||
    usageStats.completionTokens > 0 ||
    usageStats.totalCost > 0;
  const actualCost =
    usageStats.totalCost > 0
      ? usageStats.totalCost
      : estimateCost(usageStats.promptTokens * 3, model, true) +
        estimateCost(usageStats.completionTokens * 3, model, false);

  costContent.innerHTML = `
        <div class="cost-item">
          <span class="cost-label">📄 Tổng ký tự</span>
          <span class="cost-value">${fileContent.length.toLocaleString("vi-VN")}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">🎯 Phạm vi dịch</span>
          <span class="cost-value">${scopePercent}% ${scopePercent < 100 ? `(~${chunks.join("").length.toLocaleString("vi-VN")} ký tự)` : ""}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">🔢 Số đoạn dự kiến</span>
          <span class="cost-value">${totalChunks}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">📥 Token đầu vào (ước)</span>
          <span class="cost-value">${totalInputTokens.toLocaleString("vi-VN")}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">📤 Token đầu ra (ước)</span>
          <span class="cost-value">${totalOutputTokens.toLocaleString("vi-VN")}</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">💰 Chi phí ước tính</span>
          <span class="cost-value highlight">$${totalCost.toFixed(4)} USD</span>
        </div>
        ${
          hasActualUsage
            ? `
        <div class="cost-item">
          <span class="cost-label">🧾 Token thực tế (đã chạy)</span>
          <span class="cost-value">${Math.round(usageStats.promptTokens).toLocaleString("vi-VN")} in · ${Math.round(usageStats.completionTokens).toLocaleString("vi-VN")} out</span>
        </div>
        <div class="cost-item">
          <span class="cost-label">💳 Chi phí thực tế (đã chạy)</span>
          <span class="cost-value highlight">$${actualCost.toFixed(4)} USD</span>
        </div>
        `
            : ""
        }
        ${hasLowPricing ? `<div class="cost-note">✅ Model này có mức giá thấp, phù hợp dịch lớn</div>` : ""}
      `;

  costCard.style.display = "block";
}

function updateWritingCostEstimation() {
  const estimateEl = document.getElementById("writingCostEstimate");
  if (!estimateEl) return;

  if (!fileContent) {
    estimateEl.innerHTML = "⏳ Tải file để xem ước tính token viết tiếp.";
    return;
  }

  const model = getSelectedModel();
  const provider = getActiveProvider();
  const chunkCount =
    Number.parseInt(document.getElementById("writingChunkCount")?.value, 10) ||
    1;
  const safeChunkCount = Math.max(1, Math.min(100, chunkCount));
  const plotDirection =
    document.getElementById("plotDirection")?.value?.trim() || "";
  const isAnalysisEnabled = Boolean(
    document.getElementById("enableAnalysis")?.checked,
  );
  const budgets = getWritingContextBudgets(model);
  const { styleSample, lastChapter } = extractWritingContext(
    fileContent,
    budgets,
  );

  const estimatedAnalysisChars = isAnalysisEnabled
    ? cachedStoryAnalysis
      ? cachedStoryAnalysis.length
      : 4000
    : 0;
  const baseSystemPrompt = buildContinueWritingSystemPrompt(styleSample, null);
  const syntheticSystemPrompt =
    baseSystemPrompt +
    (estimatedAnalysisChars > 0
      ? `\n${"x".repeat(Math.min(estimatedAnalysisChars, 12000))}`
      : "");
  const firstUserPrompt = buildContinueWritingUserPrompt(
    lastChapter,
    plotDirection,
    "",
    0,
  );

  const inputPerChunk = estimateTokenCount(
    syntheticSystemPrompt.length + firstUserPrompt.length,
  );
  const tailCarryPerChunk = estimateTokenCount(budgets.previousTailLength);
  const estimatedTotalInput =
    inputPerChunk * safeChunkCount +
    Math.max(0, safeChunkCount - 1) * tailCarryPerChunk;

  const maxTokensPerChunk = getMaxTokensForWriting(
    syntheticSystemPrompt,
    firstUserPrompt,
  );
  const estimatedTotalOutput = maxTokensPerChunk * safeChunkCount;

  let analysisInputTokens = 0;
  let analysisOutputTokens = 0;
  if (isAnalysisEnabled && !cachedStoryAnalysis) {
    const analysisWindowChars = Math.min(fileContent.length, 60000);
    const analysisChunkCount = Math.ceil(analysisWindowChars / 6000);
    analysisInputTokens = estimateTokenCount(
      analysisWindowChars +
        analysisChunkCount * 900 +
        Math.floor(analysisWindowChars * 0.3),
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
  const providerLabel = provider === "openrouter" ? "OpenRouter" : provider;
  const analysisLabel = isAnalysisEnabled
    ? cachedStoryAnalysis
      ? "bật (dùng cache)"
      : "bật (ước tính có gọi phân tích)"
    : "tắt";

  estimateEl.innerHTML = `
        💡 Viết tiếp (${safeChunkCount} đoạn) · model ${model}<br>
        Ước tính token: vào ~${totalInputTokens.toLocaleString("vi-VN")} · ra ~${totalOutputTokens.toLocaleString("vi-VN")} · trần mỗi đoạn ~${maxTokensPerChunk.toLocaleString("vi-VN")}<br>
        Ước tính chi phí: <strong>~$${totalCost.toFixed(4)}</strong> (in $${inputCost.toFixed(4)} + out $${outputCost.toFixed(4)}) · provider ${providerLabel} · phân tích ${analysisLabel}
      `;
}

function buildModelDropdown(provider) {
  const select = document.getElementById("modelSelect");
  const config = PROVIDER_CONFIGS[provider];
  const activeProviderBefore =
    typeof getActiveProvider === "function" ? getActiveProvider() : provider;
  const canPreservePrevious = activeProviderBefore === provider;
  const previousModel =
    canPreservePrevious && typeof getSelectedModel === "function"
      ? getSelectedModel()
      : "";
  let models = config.models;

  if (provider === "openrouter") {
    const groupSelect = document.getElementById("openrouterModelGroup");
    const groupKey = groupSelect?.value || "mistral_translation";
    models = OPENROUTER_MODEL_GROUPS[groupKey]?.models || config.models;
  }

  const accountModels =
    typeof getAccountCustomModelsForProvider === "function"
      ? getAccountCustomModelsForProvider(provider)
      : [];
  const mergedModels = [];
  const seen = new Set();
  let hasCustomOption = false;
  models.forEach(function (modelInfo) {
    const id = String(modelInfo?.id || "").trim();
    if (!id) return;
    if (id === "__custom__") {
      hasCustomOption = true;
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    mergedModels.push(modelInfo);
  });
  accountModels.forEach(function (modelId) {
    if (!modelId || seen.has(modelId)) return;
    seen.add(modelId);
    mergedModels.push({
      id: modelId,
      label: `${modelId} — đã nhập trong account`,
    });
  });
  if (hasCustomOption || mergedModels.length === 0) {
    mergedModels.push({ id: "__custom__", label: "✏️ Nhập model ID..." });
  }

  select.innerHTML = "";
  mergedModels.forEach(function (modelInfo) {
    const option = document.createElement("option");
    option.value = modelInfo.id;
    option.textContent = modelInfo.label;
    select.appendChild(option);
  });
  const optionValues = Array.from(select.options).map(function (opt) {
    return opt.value;
  });
  const hasPreviousModel =
    previousModel &&
    previousModel !== "__custom__" &&
    optionValues.includes(previousModel);
  const shouldUseCustomPrevious =
    previousModel && previousModel !== "__custom__" && !hasPreviousModel;

  if (provider === "openrouter") {
    const groupSelect = document.getElementById("openrouterModelGroup");
    const groupKey = groupSelect?.value || "mistral_translation";
    const defaultGroupModel =
      OPENROUTER_MODEL_GROUPS[groupKey]?.defaultModel || config.defaultModel;
    select.value = optionValues.includes(defaultGroupModel)
      ? defaultGroupModel
      : "__custom__";
  } else {
    select.value = optionValues.includes(config.defaultModel)
      ? config.defaultModel
      : "__custom__";
  }

  if (hasPreviousModel) {
    select.value = previousModel;
  } else if (shouldUseCustomPrevious && optionValues.includes("__custom__")) {
    select.value = "__custom__";
    document.getElementById("modelName").value = previousModel;
  }
  onModelSelectChange(select.value);
}

function onOpenRouterGroupChange() {
  const activeProvider = getActiveProvider();
  if (activeProvider === "openrouter") {
    buildModelDropdown("openrouter");
    ensureOpenRouterPricingLoaded().then(function () {
      if (fileContent) {
        updateCostEstimation();
        updateWritingCostEstimation();
      }
    });
  }
}

function onModelSelectChange(selectedValue) {
  const isCustom = selectedValue === "__custom__";
  document.getElementById("customModelGroup").style.display = isCustom
    ? "block"
    : "none";
  if (!isCustom) {
    document.getElementById("modelName").value = selectedValue;
  }
  // Update cost estimation when model changes
  if (fileContent) {
    updateCostEstimation();
    updateWritingCostEstimation();
  }
}

function getSelectedModel() {
  const selectValue = document.getElementById("modelSelect").value;
  if (selectValue === "__custom__") {
    return document.getElementById("modelName").value.trim();
  }
  return selectValue;
}

function updateApiKeyUiForProvider(provider) {
  const keyGroup = document.getElementById("apiKeyGroup");
  const keyInput = document.getElementById("apiKey");
  if (!keyGroup || !keyInput) return;

  const isOllama = provider === "ollama";
  keyGroup.style.display = isOllama ? "none" : "block";
  keyInput.placeholder = isOllama
    ? "Ollama local không cần API key"
    : "Nhập API key của bạn...";
}

function syncConcurrentInputLimitForProvider(provider) {
  const input = document.getElementById("concurrentRequests");
  if (!input) return;

  const maxForProvider = provider === "ollama" ? 200 : 50;
  input.max = String(maxForProvider);

  const current = Number.parseInt(input.value, 10);
  if (!Number.isFinite(current)) {
    input.value = provider === "ollama" ? "20" : "10";
    return;
  }
  if (current > maxForProvider) {
    input.value = String(maxForProvider);
  }
}

function switchProvider(provider) {
  const config = PROVIDER_CONFIGS[provider];
  const openrouterSubGroupEl = document.getElementById("openrouterSubGroup");
  document.getElementById("baseUrl").value = config.baseUrl;
  document.getElementById("modelHint").textContent = config.hint;
  openrouterSubGroupEl.style.display =
    provider === "openrouter" ? "block" : "none";
  buildModelDropdown(provider);
  loadSavedApiKey(provider);
  if (typeof loadSavedPrompts === "function") {
    loadSavedPrompts(provider);
  }
  updateApiKeyUiForProvider(provider);
  syncConcurrentInputLimitForProvider(provider);

  if (provider === "openrouter") {
    ensureOpenRouterPricingLoaded().then(function () {
      if (fileContent) {
        updateCostEstimation();
        updateWritingCostEstimation();
      }
    });
  }
  if (provider === "huggingface") {
    ensureHuggingFaceModelsLoaded().then(function () {
      buildModelDropdown("huggingface");
      if (fileContent) {
        updateCostEstimation();
        updateWritingCostEstimation();
      }
    });
  }
  if (provider === "ollama") {
    ensureOllamaModelsLoaded().then(function () {
      buildModelDropdown("ollama");
      if (fileContent) {
        updateCostEstimation();
        updateWritingCostEstimation();
      }
    });
  }

  document.querySelectorAll("#providerTabs .tab").forEach(function (tab) {
    tab.classList.toggle("active", tab.dataset.provider === provider);
  });

  // Update cost estimation when provider changes
  if (fileContent) {
    updateCostEstimation();
    updateWritingCostEstimation();
  }
}
