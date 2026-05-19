const SPEED_PRESETS = {
  turbo: { concurrent: 20, delay: 0, chunkSize: 8000, temperature: 0.3 },
  balanced: { concurrent: 10, delay: 100, chunkSize: 6000, temperature: 0.3 },
  safe: { concurrent: 4, delay: 600, chunkSize: 5000, temperature: 0.2 },
  economy: { concurrent: 2, delay: 1200, chunkSize: 6000, temperature: 0.2 },
};
const DEFAULT_SPEED_PRESET = "balanced";

function markActiveSpeedPreset(preset, animate) {
  const buttons = document.querySelectorAll(
    ".speed-preset-btn[data-speed-preset]",
  );
  buttons.forEach(function (button) {
    const isActive = button.dataset.speedPreset === preset;
    button.classList.toggle("active", isActive);
    if (isActive && animate) {
      button.classList.remove("is-applying");
      requestAnimationFrame(function () {
        button.classList.add("is-applying");
        setTimeout(function () {
          button.classList.remove("is-applying");
        }, 460);
      });
    } else {
      button.classList.remove("is-applying");
    }
  });
}

function clearSpeedPresetHighlight() {
  const buttons = document.querySelectorAll(
    ".speed-preset-btn[data-speed-preset]",
  );
  buttons.forEach(function (button) {
    button.classList.remove("active", "is-applying");
  });
}

function applySpeedPreset(preset, options) {
  const opts = options || {};
  const silent = Boolean(opts.silent);
  const animate = opts.animate !== false;
  const settings = SPEED_PRESETS[preset];
  if (!settings) return;
  document.getElementById("concurrentRequests").value = settings.concurrent;
  document.getElementById("delayBetweenChunks").value = settings.delay;
  document.getElementById("temperature").value = settings.temperature;
  document.getElementById("tempDisplay").textContent = settings.temperature;
  document.getElementById("tempValue").textContent = settings.temperature;
  markActiveSpeedPreset(preset, animate);
  if (!isStopped && completedChunks === 0) {
    // Auto-adjust chunk size based on model if economy preset
    if (preset === "economy") {
      const model = getSelectedModel();
      const optimalSize = getOptimalChunkSize(model);
      document.getElementById("chunkSize").value = Math.min(optimalSize, 8000);
    } else {
      document.getElementById("chunkSize").value = settings.chunkSize;
    }
  }
  if (!silent) {
    addLog(
      `⚡ Preset "${preset}": ${settings.concurrent} song song · ${settings.delay}ms delay · temp ${settings.temperature}${completedChunks === 0 ? ` · chunk ${document.getElementById("chunkSize").value}` : " (chunk size giữ nguyên vì đang dịch)"}`,
      "accent",
    );
  }
}

function stopTranslation() {
  isStopped = true;
  addLog("Đang dừng... (hoàn thành các yêu cầu đang chạy)", "warning");
}

function showResult(translatedText) {
  lastResultText = translatedText || "";
  isPreviewExpanded = false;
  const charCount = translatedText.length.toLocaleString("vi-VN");
  const elapsed = formatTime((Date.now() - startTime) / 1000);

  document.getElementById("resultSummary").textContent =
    `Dịch hoàn tất ${totalChunks} đoạn trong ${elapsed} · ${charCount} ký tự`;

  renderResultPreview();
  updateCostEstimation();

  document.getElementById("resultSection").classList.add("visible");
  document
    .getElementById("resultSection")
    .scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderResultPreview() {
  const previewEl = document.getElementById("resultPreview");
  const toggleBtn = document.getElementById("togglePreviewBtn");
  if (!previewEl || !toggleBtn) return;

  const hasLongText = lastResultText.length > 500;
  const displayText =
    isPreviewExpanded || !hasLongText
      ? lastResultText
      : lastResultText.slice(0, 500) + "\n\n[...]";

  previewEl.textContent = displayText;
  previewEl.classList.toggle("full", isPreviewExpanded);
  toggleBtn.style.display = hasLongText ? "inline-flex" : "none";
  toggleBtn.textContent = isPreviewExpanded
    ? "Thu gọn xem trước"
    : "Mở rộng xem trước";
}

function toggleFullPreview() {
  isPreviewExpanded = !isPreviewExpanded;
  renderResultPreview();
}

function downloadPartial() {
  const doneChunks = translatedChunks.filter(Boolean);
  if (doneChunks.length === 0) return;
  const format =
    document.querySelector('input[name="partialFormat"]:checked')?.value ||
    "txt";
  const baseName = originalFileName.replace(/\.[^.]+$/, "");
  exportAs(
    doneChunks,
    `${baseName}_partial_${doneChunks.length}chunks_vietnamese`,
    format,
  ).then(function (fileName) {
    addLog(`⬇ Tải tiến độ: ${fileName}`, "success");
  });
}

function downloadResult() {
  const format =
    document.querySelector('input[name="exportFormat"]:checked')?.value ||
    "txt";
  const baseName = originalFileName.replace(/\.[^.]+$/, "");
  exportAs(translatedChunks, `${baseName}_vietnamese`, format).then(
    function (fileName) {
      addLog(`⬇ Đã tải file: ${fileName}`, "success");
    },
  );
}

async function exportAs(chunks, baseName, format) {
  const normalizedChunks = normalizeTranslatedChunks(chunks);
  const fullText = normalizedChunks.join("\n\n");
  const title = baseName.replace(/_vietnamese$/, "").replaceAll("_", " ");

  if (format === "docx") {
    return exportAsDocx(normalizedChunks, baseName, title);
  }
  if (format === "epub") {
    return exportAsEpub(normalizedChunks, baseName, title);
  }
  return exportAsTxt(fullText, baseName);
}

function exportAsTxt(text, baseName) {
  const fileName = `${baseName}.txt`;
  triggerDownload(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
    fileName,
  );
  return Promise.resolve(fileName);
}

async function exportAsDocx(chunks, baseName, title) {
  const fileName = `${baseName}.docx`;
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = docx;

  const paragraphs = [
    new Paragraph({ text: title, heading: HeadingLevel.TITLE }),
  ];

  chunks.forEach(function (chunkText, chunkIndex) {
    if (!chunkText) return;
    chunkText.split("\n").forEach(function (line) {
      paragraphs.push(
        new Paragraph({
          children: [
            new TextRun({ text: line, size: 24, font: "Times New Roman" }),
          ],
          spacing: { after: line.trim() === "" ? 0 : 120 },
        }),
      );
    });
    if (chunkIndex < chunks.length - 1) {
      paragraphs.push(new Paragraph({ text: "" }));
    }
  });

  const doc = new Document({
    sections: [{ properties: {}, children: paragraphs }],
  });
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
${chunks
  .filter(Boolean)
  .map(function (chunk) {
    return chunk
      .split("\n")
      .filter(function (line) {
        return line.trim();
      })
      .map(function (line) {
        return `<p>${line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p>`;
      })
      .join("\n");
  })
  .join("\n")}
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

  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file("OEBPS/content.opf", opf);
  zip.file("OEBPS/toc.ncx", ncx);
  zip.file("OEBPS/chapter.xhtml", chapterHtml);

  const epubBlob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
  });
  triggerDownload(epubBlob, fileName);
  return fileName;
}

function triggerDownload(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

