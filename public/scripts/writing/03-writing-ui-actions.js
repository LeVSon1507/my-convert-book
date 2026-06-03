function stopContinueWriting() {
  isWritingStopped = true;
  document.getElementById("writingChunkLabel").textContent = "⏹ Đã dừng";
}

function downloadContinuedContent() {
  if (continuedChunks.length === 0) return;
  const format =
    document.querySelector('input[name="writingExportFormat"]:checked')
      ?.value || "txt";
  const baseName = originalFileName
    ? originalFileName.replace(/\.[^.]+$/, "") + "_continued"
    : "continued_story";

  exportAs(continuedChunks, baseName, format);
}

function downloadWritingPartial() {
  if (continuedChunks.length === 0) return;
  const format =
    document.querySelector('input[name="writingPartialFormat"]:checked')
      ?.value || "txt";
  const baseName = originalFileName
    ? originalFileName.replace(/\.[^.]+$/, "") +
      "_partial_" +
      continuedChunks.length +
      "parts"
    : "continued_partial_" + continuedChunks.length + "parts";

  exportAs(continuedChunks, baseName, format);
}

function renderWritingChunks() {
  const outputEl = document.getElementById("writingOutput");
  outputEl.innerHTML = "";

  continuedChunks.forEach(function renderSingleChunk(chunkText, chunkIdx) {
    const block = document.createElement("div");
    block.className = "writing-chunk-block";
    block.id = "chunk-block-" + chunkIdx;

    const header = document.createElement("div");
    header.className = "chunk-header";

    const label = document.createElement("span");
    label.textContent = "Đoạn " + (chunkIdx + 1);

    const actions = document.createElement("div");
    actions.className = "chunk-actions";

    const improveBtn = document.createElement("button");
    improveBtn.textContent = "✨ Cải thiện";
    improveBtn.onclick = function handleImprove() {
      improveChunk(chunkIdx);
    };

    const rewriteBtn = document.createElement("button");
    rewriteBtn.textContent = "🔄 Viết lại";
    rewriteBtn.onclick = function handleRewrite() {
      rewriteChunk(chunkIdx);
    };

    const expandBtn = document.createElement("button");
    expandBtn.textContent = "📏 Dài hơn";
    expandBtn.onclick = function handleExpand() {
      expandChunk(chunkIdx);
    };

    const condenseBtn = document.createElement("button");
    condenseBtn.textContent = "✂️ Ngắn hơn";
    condenseBtn.onclick = function handleCondense() {
      condenseChunk(chunkIdx);
    };

    const dialogueBtn = document.createElement("button");
    dialogueBtn.textContent = "💬 Thêm hội thoại";
    dialogueBtn.onclick = function handleDialogue() {
      addDialogueToChunk(chunkIdx);
    };

    const descBtn = document.createElement("button");
    descBtn.textContent = "🎨 Thêm miêu tả";
    descBtn.onclick = function handleDesc() {
      addDescriptionToChunk(chunkIdx);
    };

    const styleBtn = document.createElement("button");
    styleBtn.textContent = "🖊️ Giữ văn phong";
    styleBtn.onclick = function handleStyle() {
      matchStyleChunk(chunkIdx);
    };

    [
      improveBtn,
      rewriteBtn,
      expandBtn,
      condenseBtn,
      dialogueBtn,
      descBtn,
      styleBtn,
    ].forEach(function (btn) {
      actions.appendChild(btn);
    });
    header.appendChild(label);
    header.appendChild(actions);

    const content = document.createElement("div");
    content.className = "chunk-content";
    content.textContent = chunkText;

    block.appendChild(header);
    block.appendChild(content);
    outputEl.appendChild(block);
  });

  outputEl.scrollTop = outputEl.scrollHeight;
}

function setWritingOutputCollapsed(collapsed) {
  isWritingOutputCollapsed = Boolean(collapsed);
  const outputEl = document.getElementById("writingOutput");
  const toggleBtn = document.getElementById("toggleWritingOutputBtn");
  if (!outputEl || !toggleBtn) return;

  outputEl.classList.toggle("is-collapsed", isWritingOutputCollapsed);
  toggleBtn.textContent = isWritingOutputCollapsed
    ? "Mở nội dung"
    : "Thu gọn nội dung";
}

function toggleWritingOutput() {
  setWritingOutputCollapsed(!isWritingOutputCollapsed);
}

async function improveChunk(chunkIdx) {
  const originalText = continuedChunks[chunkIdx];
  if (!originalText) return;

  const block = document.getElementById("chunk-block-" + chunkIdx);
  if (block) block.classList.add("is-processing");

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
    showError("Lỗi cải thiện: " + improveError.message);
  }

  if (block) block.classList.remove("is-processing");
}

async function rewriteChunk(chunkIdx) {
  const block = document.getElementById("chunk-block-" + chunkIdx);
  if (block) block.classList.add("is-processing");

  const modelName = getSelectedModel();
  const writingBudgets = getWritingContextBudgets(modelName);
  const { styleSample, lastChapter } = extractWritingContext(
    fileContent,
    writingBudgets,
  );
  const plotDirection = document.getElementById("plotDirection").value.trim();
  const storyAnalysis = cachedStoryAnalysis;
  const systemPrompt = buildContinueWritingSystemPrompt(
    styleSample,
    storyAnalysis,
  );

  // Build accumulated text from chunks BEFORE this one
  const previousText = continuedChunks.slice(0, chunkIdx).join("\n\n");
  const previousTail = getTailContext(
    previousText,
    writingBudgets.previousTailLength,
  );
  const userPrompt = buildContinueWritingUserPrompt(
    lastChapter,
    plotDirection,
    previousTail,
    chunkIdx,
  );

  try {
    const rewritten = await callWritingApi(systemPrompt, userPrompt);
    continuedChunks[chunkIdx] = rewritten;
    renderWritingChunks();
  } catch (rewriteError) {
    showError("Lỗi viết lại: " + rewriteError.message);
  }

  if (block) block.classList.remove("is-processing");
}

async function applyChunkTransformation(
  chunkIdx,
  systemInstruction,
  userInstruction,
) {
  const originalText = continuedChunks[chunkIdx];
  if (!originalText) return;
  const block = document.getElementById("chunk-block-" + chunkIdx);
  if (block) block.classList.add("is-processing");
  try {
    const result = await callWritingApi(
      systemInstruction,
      userInstruction + "\n\n" + originalText,
    );
    continuedChunks[chunkIdx] = result;
    renderWritingChunks();
  } catch (e) {
    showError("Lỗi chỉnh sửa: " + e.message);
  }
  if (block) block.classList.remove("is-processing");
}

function expandChunk(chunkIdx) {
  return applyChunkTransformation(
    chunkIdx,
    "Bạn là biên tập viên. Mở rộng đoạn văn thêm khoảng 50%, giữ nguyên nội dung, phong cách và ngôi kể. CHỈ trả về đoạn văn đã mở rộng.",
    "Mở rộng đoạn văn sau thêm ~50%, giữ nguyên nội dung và phong cách:\n\n",
  );
}

function condenseChunk(chunkIdx) {
  return applyChunkTransformation(
    chunkIdx,
    "Bạn là biên tập viên. Tóm gọn đoạn văn khoảng 50%, giữ nguyên ý chính và phong cách. CHỈ trả về đoạn văn đã rút gọn.",
    "Tóm gọn đoạn văn sau khoảng 50%, giữ nguyên ý chính:\n\n",
  );
}

function addDialogueToChunk(chunkIdx) {
  return applyChunkTransformation(
    chunkIdx,
    "Bạn là biên tập viên. Thêm một đoạn hội thoại tự nhiên vào đoạn văn, phù hợp tình huống và nhân vật. CHỈ trả về đoạn văn đã chỉnh sửa.",
    "Thêm một đoạn hội thoại tự nhiên vào đoạn văn sau, phù hợp tình huống:\n\n",
  );
}

function addDescriptionToChunk(chunkIdx) {
  return applyChunkTransformation(
    chunkIdx,
    "Bạn là biên tập viên. Thêm 1–2 câu miêu tả cảnh hoặc cảm xúc nhân vật vào đoạn văn, phù hợp văn phong tác giả. CHỈ trả về đoạn văn đã chỉnh sửa.",
    "Thêm 1–2 câu miêu tả cảnh/cảm xúc vào đoạn văn sau:\n\n",
  );
}

function matchStyleChunk(chunkIdx) {
  const modelName = getSelectedModel();
  const writingBudgets = getWritingContextBudgets(modelName);
  const { styleSample } = extractWritingContext(fileContent, writingBudgets);
  const originalText = continuedChunks[chunkIdx];
  if (!originalText) return;
  const block = document.getElementById("chunk-block-" + chunkIdx);
  if (block) block.classList.add("is-processing");
  const sysPrompt =
    "Bạn là biên tập viên. Viết lại đoạn văn sau để bám sát hơn văn phong mẫu: ngôi kể, đại từ, nhịp câu, mật độ cảm xúc. KHÔNG thay đổi nội dung/tình tiết. CHỈ trả về đoạn văn đã viết lại.\n\n=== MẪU VĂN PHONG ===\n" +
    styleSample +
    "\n=== HẾT MẪU ===";
  callWritingApi(
    sysPrompt,
    "Viết lại đoạn văn sau bám sát văn phong mẫu hơn:\n\n" + originalText,
  )
    .then(function (result) {
      continuedChunks[chunkIdx] = result;
      renderWritingChunks();
    })
    .catch(function (e) {
      showError("Lỗi giữ văn phong: " + e.message);
    })
    .finally(function () {
      if (block) block.classList.remove("is-processing");
    });
}

function setSelectedWritingStyle(style) {
  selectedWritingStyle = style;
  document.querySelectorAll(".writing-style-btn").forEach(function (btn) {
    btn.classList.toggle("active", btn.dataset.style === style);
  });
}
globalThis.setSelectedWritingStyle = setSelectedWritingStyle;

async function copyContinuedContent() {
  const text = continuedChunks.join("\n\n");
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    showError(""); // Clear any existing error
    hideError();
    // Brief visual feedback
    const btn = document.querySelector("#writingResultSection .btn-secondary");
    const originalText = btn.innerHTML;
    btn.innerHTML = "<span>✅</span> Đã sao chép!";
    setTimeout(function () {
      btn.innerHTML = originalText;
    }, 2000);
  } catch {
    showError("Không thể sao chép vào clipboard.");
  }
}

document
  .getElementById("writingChunkCount")
  .addEventListener("input", updateWritingCostEstimation);
document
  .getElementById("plotDirection")
  .addEventListener("input", updateWritingCostEstimation);
document
  .getElementById("enableAnalysis")
  .addEventListener("change", updateWritingCostEstimation);
