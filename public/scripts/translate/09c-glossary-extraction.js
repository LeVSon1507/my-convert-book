// ===== Auto-Glossary Extraction (opt-in pre-translation pass) =====

function mergeGlossaryResults(rawText) {
  var seen = new Map();
  var lines = rawText.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line || !line.includes("=>")) continue;
    var eqIdx = line.indexOf("=>");
    var key = line.slice(0, eqIdx).trim();
    var val = line.slice(eqIdx + 2).trim();
    if (key && val && !seen.has(key)) {
      seen.set(key, val);
    }
  }
  var result = [];
  seen.forEach(function (val, key) {
    result.push(key + " => " + val);
  });
  return result.join("\n");
}

async function extractGlossaryFromSamples(allChunks) {
  if (!allChunks || allChunks.length === 0) return "";

  var apiKey = document.getElementById("apiKey").value.trim();
  var modelName = getSelectedModel();
  var baseUrl = document
    .getElementById("baseUrl")
    .value.trim()
    .replace(/\/$/, "");
  var provider = getActiveProvider();

  var rawIndices = [0, Math.floor(allChunks.length / 2), allChunks.length - 1];
  var sampleIndices = rawIndices.filter(function (v, i, a) {
    return a.indexOf(v) === i;
  });

  var extractionSystem =
    "\u0110\u1ecdc \u0111o\u1ea1n v\u0103n v\u00e0 li\u1ec7t k\u00ea T\u00caN RI\u00caNG \u0111\u1eb7c bi\u1ec7t (ng\u01b0\u1eddi, \u0111\u1ecba danh, m\u00f4n ph\u00e1i, k\u1ef9 n\u0103ng \u0111\u1eb7c bi\u1ec7t, v\u1eadt ph\u1ea9m \u0111\u1eb7c bi\u1ec7t). Ch\u1ec9 li\u1ec7t k\u00ea nh\u1eefng t\u00ean KH\u00d4NG \u0111\u1ecdc \u0111\u01b0\u1ee3c ngh\u0129a \u0111en b\u1eb1ng ti\u1ebfng Vi\u1ec7t th\u00f4ng th\u01b0\u1eddng. M\u1ed7i d\u00f2ng: t\u00ean g\u1ed1c => g\u1ee3i \u00fd d\u1ecbch ti\u1ebfng Vi\u1ec7t (phi\u00ean \u00e2m ho\u1eb7c d\u1ecbch ngh\u0129a). Kh\u00f4ng gi\u1ea3i th\u00edch, kh\u00f4ng \u0111\u00e1nh s\u1ed1, ch\u1ec9 tr\u1ea3 v\u1ec1 danh s\u00e1ch. V\u00ed d\u1ee5:\n\u5f20\u4e09\u4e30 => Tr\u01b0\u01a1ng Tam Phong\n\u592a\u6781\u62f3 => Th\u00e1i C\u1ef1c Quy\u1ec1n\n\u6b66\u5f53\u5c71 => V\u00f5 \u0110\u0103ng S\u01a1n";

  var allResults = [];

  for (var si = 0; si < sampleIndices.length; si++) {
    if (isStopped) break;
    var idx = sampleIndices[si];
    var sampleText = allChunks[idx].slice(0, 3000);
    var loadingEl = document.getElementById("glossaryLoading");
    var loadingText = document.getElementById("glossaryLoadingText");
    if (loadingEl) loadingEl.style.display = "flex";
    if (loadingText) loadingText.textContent = "\u0110ang tr\u00EDch xu\u1EA5t t\u00EAn ri\u00EAng... (" + (si + 1) + "/" + sampleIndices.length + ")";
    addLog(
      "\ud83d\udd0d Tr\u00edch xu\u1ea5t t\u1eeb v\u1ef1ng \u0111o\u1ea1n m\u1eabu " +
        (si + 1) +
        "/" +
        sampleIndices.length +
        "...",
      "info",
    );

    try {
      var payload =
        provider === "ollama"
          ? {
              model: modelName,
              stream: false,
              messages: [
                { role: "system", content: extractionSystem },
                { role: "user", content: sampleText },
              ],
            }
          : {
              model: modelName,
              temperature: 0.1,
              max_tokens: 600,
              messages: [
                { role: "system", content: extractionSystem },
                { role: "user", content: sampleText },
              ],
            };

      var controller = new AbortController();
      var timeoutId = setTimeout(function () {
        controller.abort();
      }, 45000);
      try {
        var response = await requestChatCompletions(
          provider,
          baseUrl,
          apiKey,
          payload,
          controller.signal,
        );
        if (response.ok) {
          var data = await response.json();
          recordUsageFromResponse(data);
          var resultText =
            provider === "ollama"
              ? (data && data.message && data.message.content) || ""
              : extractAssistantText(data);
          if (resultText) allResults.push(resultText.trim());
        }
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (e) {
      // Ignore per-sample errors — non-blocking
    }
  }

  return mergeGlossaryResults(allResults.join("\n"));
}

function showGlossaryReviewModal(glossaryText) {
  return new Promise(function (resolve) {
    var modal = document.getElementById("glossaryModal");
    var textarea = document.getElementById("glossaryModalTextarea");
    var countEl = document.getElementById("glossaryModalCount");
    var applyBtn = document.getElementById("glossaryModalApplyBtn");
    var skipBtn = document.getElementById("glossaryModalSkipBtn");

    if (!modal) {
      resolve({ action: "skip", text: "" });
      return;
    }

    var lineCount = glossaryText.split("\n").filter(function (l) {
      return l.trim() && l.includes("=>");
    }).length;
    countEl.textContent = String(lineCount);
    textarea.value = glossaryText;
    modal.style.display = "flex";

    function cleanup() {
      modal.style.display = "none";
      applyBtn.removeEventListener("click", onApply);
      skipBtn.removeEventListener("click", onSkip);
    }

    function onApply() {
      var finalText = textarea.value;
      cleanup();
      resolve({ action: "apply", text: finalText });
    }

    function onSkip() {
      cleanup();
      resolve({ action: "skip", text: "" });
    }

    applyBtn.addEventListener("click", onApply);
    skipBtn.addEventListener("click", onSkip);
  });
}
