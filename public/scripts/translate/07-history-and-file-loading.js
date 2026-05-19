function renderTranslationHistory() {
  const listEl = document.getElementById("historyList");
  if (!listEl) return;
  let localList = [];
  try {
    const raw = localStorage.getItem(TRANSLATION_HISTORY_KEY);
    localList = Array.isArray(JSON.parse(raw || "[]"))
      ? JSON.parse(raw || "[]")
      : [];
  } catch {
    localList = [];
  }

  let html = "";

  if (currentFirebaseUser) {
    if (cloudHistory.length > 0) {
      html +=
        '<div class="history-section-label">☁️ Cloud — đồng bộ mọi thiết bị (' +
        cloudHistory.length +
        ")</div>" +
        cloudHistory
          .map(function (item) {
            const timeSource = item.updatedAt || item.completedAt;
            const when = timeSource?.seconds
              ? new Date(timeSource.seconds * 1000).toLocaleString("vi-VN")
              : "—";
            const chars = item.charCount
              ? item.charCount.toLocaleString("vi-VN") + " ký tự"
              : "";
            const cost = item.cost ? " · $" + item.cost.toFixed(4) : "";
            const progressText =
              Number(item.completedChunks) > 0 && Number(item.totalChunks) > 0
                ? ` · ${item.completedChunks}/${item.totalChunks} đoạn`
                : "";
            const isInProgress =
              item.status === "in_progress" ||
              (Number(item.completedChunks) > 0 &&
                Number(item.completedChunks) < Number(item.totalChunks || 0));
            const fn = hEsc(item.fileName || "unknown.txt");
            const id = item.id;
            return (
              '<div class="history-item">' +
              '<div class="history-item-info">' +
              '<div class="history-item-name" title="' +
              fn +
              '">' +
              fn +
              "</div>" +
              '<div class="history-item-meta">' +
              when +
              (item.model ? " · " + hEsc(item.model) : "") +
              progressText +
              "</div>" +
              (chars
                ? '<div class="history-item-meta">' + chars + cost + "</div>"
                : "") +
              "</div>" +
              '<div class="history-item-actions">' +
              '<button id="hist-dl-' +
              id +
              '" class="btn btn-secondary btn-sm" onclick="downloadCloudFile(\'' +
              id +
              "','" +
              fn +
              "')\">⬇️ Tải về</button>" +
              (isInProgress
                ? '<button class="btn btn-secondary btn-sm" onclick="resumeCloudHistoryItem(\'' +
                  id +
                  "')\">▶ Tiếp tục</button>"
                : "") +
              '<button class="btn btn-danger btn-sm" onclick="deleteCloudFile(\'' +
              id +
              "')\">🗑</button>" +
              "</div>" +
              "</div>"
            );
          })
          .join("");
    } else {
      html +=
        '<div class="history-empty">☁️ Chưa có bản dịch nào trên cloud.<br><small>Bản dịch sẽ tự động lưu sau khi hoàn thành.</small></div>';
    }
  }

  if (localList.length > 0) {
    html +=
      '<div class="history-section-label">💾 Chỉ trên thiết bị này</div>' +
      localList
        .map(function (item) {
          const when = new Date(item.completedAt).toLocaleString("vi-VN");
          const done = Number(item.completedChunks || 0);
          const total = Number(item.totalChunks || 0);
          const progressText =
            total > 0
              ? done > 0
                ? `${done}/${total} đoạn`
                : `${total} đoạn`
              : "—";
          const statusText =
            item.status === "in_progress" ? "⏸ Dở dang" : "✅ Hoàn tất";
          const canResume =
            item.status === "in_progress" &&
            item.checkpointKey &&
            done > 0 &&
            done < total;
          const canDownloadPartial =
            item.status === "in_progress" && item.checkpointKey && done > 0;
          const safeName = hEsc(item.fileName || "unknown");
          const hid = encodeURIComponent(item.historyId || "");
          return (
            '<div class="history-item">' +
            '<div class="history-item-info">' +
            '<div class="history-item-name">' +
            safeName +
            "</div>" +
            '<div class="history-item-meta">' +
            when +
            (item.model ? " · " + hEsc(item.model) : "") +
            "</div>" +
            '<div class="history-item-meta">' +
            progressText +
            " · " +
            statusText +
            "</div>" +
            "</div>" +
            '<div class="history-item-actions">' +
            (canDownloadPartial
              ? '<button class="btn btn-secondary btn-sm" onclick="downloadLocalHistoryPartial(\'' +
                hid +
                "')\">⬇️ Tải về</button>"
              : "") +
            (canResume
              ? '<button class="btn btn-secondary btn-sm" onclick="resumeLocalHistoryItem(\'' +
                hid +
                "')\">▶ Tiếp tục</button>"
              : "") +
            "</div>" +
            "</div>"
          );
        })
        .join("");
  }

  if (!html) {
    html =
      '<div class="history-empty">Chưa có lịch sử dịch.<br><small>Dịch xong 1 đoạn là tiến độ sẽ xuất hiện tại đây.</small></div>';
  }
  listEl.innerHTML = html;
}

async function resumeCloudHistoryItem(docId) {
  if (!currentFirebaseUser || typeof cloudLoadResumeCheckpoint !== "function")
    return;
  try {
    const checkpoint = await cloudLoadResumeCheckpoint(docId);
    if (!checkpoint || !Array.isArray(checkpoint.translatedChunks)) {
      showError("Không tìm thấy checkpoint để tiếp tục.");
      return;
    }
    pendingResumeCheckpoint = checkpoint;
    switchAppMode("translate");
    const done = checkpoint.translatedChunks.filter(Boolean).length;
    const total = checkpoint.translatedChunks.length;
    const resumePromptEl = document.getElementById("resumePrompt");
    const promptTextEl = document.getElementById("resumePromptText");
    if (promptTextEl)
      promptTextEl.textContent = `Checkpoint cloud: đã dịch ${done}/${total} đoạn. Tiếp tục?`;
    if (resumePromptEl) resumePromptEl.style.display = "flex";
  } catch (e) {
    showError("Không thể tải checkpoint cloud: " + (e?.message || e));
  }
}

function downloadLocalHistoryPartial(historyId) {
  const item = findLocalHistoryItem(decodeURIComponent(historyId || ""));
  if (!item || !item.checkpointKey) return;
  try {
    const raw = localStorage.getItem(item.checkpointKey);
    if (!raw) return showError("Không còn dữ liệu checkpoint local để tải.");
    const parsed = JSON.parse(raw);
    const chunks = Array.isArray(parsed?.translatedChunks)
      ? parsed.translatedChunks.filter(Boolean)
      : [];
    if (!chunks.length)
      return showError("Checkpoint local chưa có nội dung dịch.");
    const baseName = (item.fileName || "translated_partial").replace(
      /\.[^.]+$/,
      "",
    );
    exportAs(
      chunks,
      `${baseName}_partial_${chunks.length}chunks_vietnamese`,
      "txt",
    );
  } catch (e) {
    showError("Không thể tải bản dịch local: " + (e?.message || e));
  }
}

function resumeLocalHistoryItem(historyId) {
  const item = findLocalHistoryItem(decodeURIComponent(historyId || ""));
  if (!item || !item.checkpointKey) return;
  try {
    const raw = localStorage.getItem(item.checkpointKey);
    if (!raw) return showError("Không còn checkpoint local để tiếp tục.");
    const parsed = JSON.parse(raw);
    const chunks = Array.isArray(parsed?.translatedChunks)
      ? parsed.translatedChunks
      : [];
    if (!chunks.length) return showError("Checkpoint local trống.");
    pendingResumeCheckpoint = {
      translatedChunks: chunks,
      totalChunks: Number(parsed?.totalChunks) || chunks.length,
    };
    switchAppMode("translate");
    const done = chunks.filter(Boolean).length;
    const total = chunks.length;
    const resumePromptEl = document.getElementById("resumePrompt");
    const promptTextEl = document.getElementById("resumePromptText");
    if (promptTextEl)
      promptTextEl.textContent = `Checkpoint local: đã dịch ${done}/${total} đoạn. Tiếp tục?`;
    if (resumePromptEl) resumePromptEl.style.display = "flex";
  } catch (e) {
    showError("Không thể đọc checkpoint local: " + (e?.message || e));
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
  currentFileHash = "";
  resetUsageStats();
  const cacheHint = document.getElementById("analysisCacheHint");
  if (cacheHint) cacheHint.style.display = "none";

  const reader = new FileReader();
  reader.onload = async function (event) {
    fileContent = event.target.result;

    const sizeMB = (file.size / 1024 / 1024).toFixed(2);
    const charCount = fileContent.length.toLocaleString("vi-VN");

    const dropZone = document.getElementById("dropZone");
    dropZone.classList.add("has-file");
    dropZone.querySelector(".drop-icon").textContent = "✅";
    dropZone.querySelector(".drop-title").textContent = file.name;
    dropZone.querySelector(".drop-subtitle").textContent =
      `${sizeMB} MB · ${charCount} ký tự`;

    const fileInfo = document.getElementById("fileInfo");
    fileInfo.innerHTML = `
          <strong>${file.name}</strong> — ${sizeMB} MB (${charCount} ký tự) · 
          Ước tính ~${estimateChunks(fileContent.length)} đoạn cần dịch
        `;
    fileInfo.classList.add("visible");

    // Update cost estimation
    updateCostEstimation();
    updateWritingCostEstimation();

    try {
      currentFileHash = await hashContent(fileContent);
    } catch {
      currentFileHash = "";
    }

    pendingResumeCheckpoint = null;
    const resumePromptEl = document.getElementById("resumePrompt");
    if (resumePromptEl) resumePromptEl.style.display = "none";

    const modelName = getSelectedModel();
    const provider = getActiveProvider();
    const chunkSize =
      Number.parseInt(document.getElementById("chunkSize").value, 10) || 6000;
    const fullChunks = splitIntoChunks(fileContent, chunkSize);
    const currentChunks = applyTranslationScope(fullChunks);
    const scopePercent = getTranslationScopePercent();
    const checkpoint = getTranslationCheckpoint(
      currentFileHash,
      provider,
      modelName,
      chunkSize,
      scopePercent,
    );
    const translatedList = Array.isArray(checkpoint?.translatedChunks)
      ? checkpoint.translatedChunks
      : [];
    const doneCount = translatedList.filter(Boolean).length;
    if (
      checkpoint &&
      translatedList.length === currentChunks.length &&
      doneCount > 0 &&
      doneCount < currentChunks.length
    ) {
      pendingResumeCheckpoint = checkpoint;
      const promptTextEl = document.getElementById("resumePromptText");
      if (promptTextEl) {
        promptTextEl.textContent = `File này đã dịch ${doneCount}/${currentChunks.length} đoạn, tiếp tục từ đoạn ${doneCount + 1}?`;
      }
      if (resumePromptEl) resumePromptEl.style.display = "flex";
    }

    if (
      !pendingResumeCheckpoint &&
      currentFirebaseUser &&
      typeof cloudFindResumeCandidate === "function" &&
      typeof cloudLoadResumeCheckpoint === "function"
    ) {
      try {
        const cloudMeta = await cloudFindResumeCandidate(
          currentFileHash,
          provider,
          modelName,
          chunkSize,
          scopePercent,
        );
        if (cloudMeta) {
          const cloudCheckpoint = await cloudLoadResumeCheckpoint(cloudMeta.id);
          const cloudList = Array.isArray(cloudCheckpoint?.translatedChunks)
            ? cloudCheckpoint.translatedChunks
            : [];
          const cloudDone = cloudList.filter(Boolean).length;
          if (
            cloudList.length === currentChunks.length &&
            cloudDone > 0 &&
            cloudDone < currentChunks.length
          ) {
            pendingResumeCheckpoint = cloudCheckpoint;
            const promptTextEl = document.getElementById("resumePromptText");
            if (promptTextEl) {
              promptTextEl.textContent = `Cloud checkpoint: đã dịch ${cloudDone}/${currentChunks.length} đoạn, tiếp tục từ đoạn ${cloudDone + 1}?`;
            }
            if (resumePromptEl) resumePromptEl.style.display = "flex";
          }
        }
      } catch {
        // ignore cloud resume lookup errors
      }
    }

    const persistedAnalysis = getCachedStoryAnalysis(currentFileHash);
    if (persistedAnalysis) {
      cachedStoryAnalysis = persistedAnalysis;
      if (cacheHint) {
        cacheHint.textContent = " ✅ Đã có bản phân tích cache (sẽ dùng lại)";
        cacheHint.style.display = "inline";
      }
    }

    updateWritingCostEstimation();
  };
  reader.readAsText(file, "UTF-8");
}

function estimateChunks(charCount) {
  const chunkSize =
    Number.parseInt(document.getElementById("chunkSize").value, 10) || 6000;
  return Math.ceil(charCount / chunkSize);
}

