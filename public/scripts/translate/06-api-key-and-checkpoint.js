function toggleApiKeyVisibility() {
  const apiKeyInput = document.getElementById("apiKey");
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  document.getElementById("toggleApiKeyBtn").textContent = isPassword
    ? "🙈"
    : "👁";
}

function saveApiKey() {
  const provider = getActiveProvider();
  if (provider === "ollama") return;
  const apiKey = document.getElementById("apiKey").value.trim();
  if (!apiKey) return;
  localStorage.setItem("translator_api_key_" + provider, apiKey);
  const hint = document.getElementById("keySavedHint");
  hint.textContent = "✅ Đã lưu key cho " + provider + " vào browser.";
  hint.style.display = "block";
  if (provider === "huggingface") {
    ensureHuggingFaceModelsLoaded(true).then(function () {
      buildModelDropdown("huggingface");
    });
  }
}

async function saveApiKeyToAccount() {
  const provider = getActiveProvider();
  const apiKey = document.getElementById("apiKey").value.trim();
  if (!apiKey) return;
  const hint = document.getElementById("keySavedHint");
  if (!currentFirebaseUser || typeof cloudSaveApiKey !== "function") {
    hint.textContent = "⚠️ Cần đăng nhập account để lưu key lên cloud.";
    hint.style.display = "block";
    return;
  }
  const ok = await cloudSaveApiKey(provider, apiKey);
  hint.textContent = ok
    ? "☁️ Đã lưu key cho " + provider + " vào account."
    : "❌ Không lưu được key lên account.";
  hint.style.display = "block";
}

function clearApiKey() {
  const provider = getActiveProvider();
  if (provider === "ollama") return;
  localStorage.removeItem("translator_api_key_" + provider);
  document.getElementById("apiKey").value = "";
  const hint = document.getElementById("keySavedHint");
  hint.textContent = "🗑 Đã xóa key.";
  hint.style.display = "block";
  if (provider === "huggingface") {
    huggingFaceModels = getHuggingFaceFallbackModels();
    huggingFaceModelsLoadedAt = 0;
    PROVIDER_CONFIGS.huggingface.models = huggingFaceModels.concat([
      { id: "__custom__", label: "✏️ Nhập model ID..." },
    ]);
    PROVIDER_CONFIGS.huggingface.defaultModel = huggingFaceModels[0].id;
    buildModelDropdown("huggingface");
  }
  setTimeout(function () {
    hint.style.display = "none";
  }, 2000);
}

function loadSavedApiKey(provider) {
  if (provider === "ollama") {
    document.getElementById("apiKey").value = "";
    document.getElementById("keySavedHint").style.display = "none";
    return;
  }
  const configKey = getRuntimeConfig()?.keys?.[provider] || "";
  const savedKey = localStorage.getItem("translator_api_key_" + provider);
  const keyToUse = savedKey || configKey;
  const hint = document.getElementById("keySavedHint");
  if (keyToUse) {
    document.getElementById("apiKey").value = keyToUse;
    hint.textContent = savedKey
      ? "💾 Đã load key đã lưu cho " + provider
      : "🔑 Key từ cấu hình runtime";
    hint.style.display = "block";
  } else {
    document.getElementById("apiKey").value = "";
    hint.style.display = "none";
  }
  if (provider === "huggingface" && keyToUse) {
    ensureHuggingFaceModelsLoaded().then(function () {
      buildModelDropdown("huggingface");
    });
  }

  if (
    !savedKey &&
    currentFirebaseUser &&
    typeof cloudLoadApiKey === "function"
  ) {
    cloudLoadApiKey(provider).then(function (cloudKey) {
      if (!cloudKey) return;
      if (provider !== getActiveProvider()) return;
      const currentValue = document.getElementById("apiKey").value.trim();
      if (currentValue) return;
      document.getElementById("apiKey").value = cloudKey;
      hint.textContent = "☁️ Đã load key cloud cho " + provider + ".";
      hint.style.display = "block";
      if (provider === "huggingface") {
        ensureHuggingFaceModelsLoaded(true).then(function () {
          buildModelDropdown("huggingface");
        });
      }
    });
  }
}

function getTranslationCheckpointKey(
  fileHash,
  provider,
  model,
  chunkSize,
  scopePercent,
) {
  if (!fileHash || !provider || !model || !chunkSize) return "";
  return `${TRANSLATION_CHECKPOINT_PREFIX}${fileHash}:${provider}:${model}:${chunkSize}:${scopePercent || 100}`;
}

function getTranslationCheckpoint(
  fileHash,
  provider,
  model,
  chunkSize,
  scopePercent,
) {
  try {
    const key = getTranslationCheckpointKey(
      fileHash,
      provider,
      model,
      chunkSize,
      scopePercent,
    );
    if (!key) return null;
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function setTranslationCheckpoint(
  fileHash,
  provider,
  model,
  chunkSize,
  scopePercent,
  payload,
) {
  try {
    const key = getTranslationCheckpointKey(
      fileHash,
      provider,
      model,
      chunkSize,
      scopePercent,
    );
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // ignore quota
  }
}

function clearTranslationCheckpoint(
  fileHash,
  provider,
  model,
  chunkSize,
  scopePercent,
) {
  try {
    const key = getTranslationCheckpointKey(
      fileHash,
      provider,
      model,
      chunkSize,
      scopePercent,
    );
    if (!key) return;
    localStorage.removeItem(key);
  } catch {
    // noop
  }
}

function getTranslationHistoryId(
  fileHash,
  provider,
  model,
  chunkSize,
  scopePercent,
) {
  if (!fileHash || !provider || !model || !chunkSize) return "";
  return `${fileHash}:${provider}:${model}:${chunkSize}:${scopePercent || 100}`;
}

function pushTranslationHistory(record) {
  try {
    const raw = localStorage.getItem(TRANSLATION_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const list = Array.isArray(parsed) ? parsed : [];
    const historyId = record?.historyId || "";
    if (historyId) {
      const existingIndex = list.findIndex(function (item) {
        return item?.historyId === historyId;
      });
      if (existingIndex >= 0) {
        list[existingIndex] = Object.assign({}, list[existingIndex], record);
        const updated = list.splice(existingIndex, 1)[0];
        list.unshift(updated);
      } else {
        list.unshift(record);
      }
    } else {
      list.unshift(record);
    }
    localStorage.setItem(
      TRANSLATION_HISTORY_KEY,
      JSON.stringify(list.slice(0, 40)),
    );
    if (activeAppMode === "history") {
      renderTranslationHistory();
    }
  } catch {
    // noop
  }
}

function findLocalHistoryItem(historyId) {
  try {
    const raw = localStorage.getItem(TRANSLATION_HISTORY_KEY);
    const list = Array.isArray(JSON.parse(raw || "[]"))
      ? JSON.parse(raw || "[]")
      : [];
    return (
      list.find(function (item) {
        return item?.historyId === historyId;
      }) || null
    );
  } catch {
    return null;
  }
}

function updateLocalProgressHistoryEntry(status) {
  if (!currentFileHash || !translatedChunks || translatedChunks.length === 0)
    return;
  const modelName = getSelectedModel();
  const provider = getActiveProvider();
  const chunkSize =
    Number.parseInt(document.getElementById("chunkSize").value, 10) || 6000;
  const scopePercent = getTranslationScopePercent();
  const checkpointKey = getTranslationCheckpointKey(
    currentFileHash,
    provider,
    modelName,
    chunkSize,
    scopePercent,
  );
  const historyId = getTranslationHistoryId(
    currentFileHash,
    provider,
    modelName,
    chunkSize,
    scopePercent,
  );
  const doneCount = translatedChunks.filter(Boolean).length;
  const normalizedStatus = status || "in_progress";
  pushTranslationHistory({
    historyId: historyId,
    checkpointKey: normalizedStatus === "completed" ? "" : checkpointKey,
    fileHash: currentFileHash,
    fileName: originalFileName || "unknown",
    provider: provider,
    model: modelName,
    chunkSize: chunkSize,
    scopePercent: scopePercent,
    totalChunks: totalChunks,
    completedChunks: doneCount,
    status: normalizedStatus,
    completedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

