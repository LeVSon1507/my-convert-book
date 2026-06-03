function normalizeTranslatedText(text) {
  if (!text) return "";
  let output = text.trim();
  // Some providers still wrap in markdown fences; strip for cleaner export.
  output = output
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/, "");
  // Strip markdown bold markers (not used in Vietnamese prose)
  output = output.replace(/\*\*/g, "");
  // Collapse sequences of 2+ em dashes into one
  output = output.replace(/—{2,}/g, "—");
  // Normalize em dashes used as dialogue markers: ensure no leading space before —
  // but preserve em dashes used mid-sentence (which should have spaces around them)
  output = output.replace(/^[ \t]+—/gm, "—");
  return output.trim();
}

function toComparableText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .toLowerCase()
    .replace(/[^a-z0-9\u00C0-\u024F\u1E00-\u1EFF]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSpeedOptimizedMode() {
  const runtimeFastMode = getRuntimeConfig()?.preferFastTranslation;
  if (typeof runtimeFastMode === "boolean") return runtimeFastMode;
  return true;
}

function buildTranslationUserPrompt(chunkText, strictMode, contextInfo) {
  var ctx = contextInfo || {};
  var glossary = ctx.glossaryInstruction || "";
  var prevTail = ctx.prevTranslatedTail || "";
  var summary = ctx.summaryBefore || "";
  if (!strictMode && isSpeedOptimizedMode()) {
    var speedPrompt = "D\u1ECBch ti\u1EBFng Vi\u1EC7t t\u1EF1 nhi\u00EAn, gi\u1EEF \u00FD v\u00E0 xu\u1ED1ng d\u00F2ng";
    if (glossary) speedPrompt += ". T\u1EEB v\u1EF1ng:\n" + glossary;
    return speedPrompt + ":\n\n" + chunkText;
  }
  // Standard mode: system prompt handles requirements.
  // User prompt is context-only + chunk. Keeps tokens low, quality high.
  var parts = [];
  if (summary) parts.push("T\u00F3m t\u1EAFt: " + summary.slice(0, 600));
  if (glossary) parts.push("T\u1EEB v\u1EF1ng:\n" + glossary);
  if (prevTail) parts.push("Tr\u01B0\u1EDBc: " + prevTail);
  if (strictMode) parts.push("(d\u1ECBch nghi\u00EAm ng\u1EB7t, \u01B0u ti\u00EAn ch\u00EDnh x\u00E1c ng\u1EAFn g\u1ECDn)");
  var prefix = parts.length ? parts.join("\n") + "\n\n" : "";
  return prefix + chunkText;
}

function extractTaggedTranslation(text) {
  const normalized = normalizeTranslatedText(text);
  const tagged = normalized.match(
    /<vi_translation>\s*([\s\S]*?)\s*<\/vi_translation>/i,
  );
  if (tagged && tagged[1]) return tagged[1].trim();
  return normalized;
}

function splitParagraphs(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map(function (part) {
      return part.trim();
    })
    .filter(Boolean);
}

function stripLeadingSourceEcho(translatedText, sourceChunk) {
  const outputParagraphs = splitParagraphs(translatedText);
  if (!outputParagraphs.length) return translatedText;

  const sourceSet = new Set(
    splitParagraphs(sourceChunk).map(function (part) {
      return toComparableText(part);
    }),
  );

  let leadingEchoCount = 0;
  while (leadingEchoCount < outputParagraphs.length) {
    const probe = toComparableText(outputParagraphs[leadingEchoCount]);
    if (!probe || probe.length < 30 || !sourceSet.has(probe)) break;
    leadingEchoCount++;
  }

  if (
    leadingEchoCount > 0 &&
    leadingEchoCount < outputParagraphs.length
  ) {
    return outputParagraphs.slice(leadingEchoCount).join("\n\n");
  }

  return translatedText;
}

function dedupeConsecutiveParagraphs(text) {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length <= 1) return String(text || "").trim();

  const deduped = [];
  paragraphs.forEach(function (paragraph) {
    const current = toComparableText(paragraph);
    if (!current) return;

    const previousParagraph = deduped[deduped.length - 1];
    const previous = toComparableText(previousParagraph);
    const isExactDuplicate = current === previous;
    const isNearDuplicate =
      current.length > 40 &&
      previous.length > 40 &&
      (current.includes(previous) || previous.includes(current));

    if (!isExactDuplicate && !isNearDuplicate) {
      deduped.push(paragraph);
    }
  });

  return deduped.join("\n\n").trim();
}

function normalizePunctuationSpacing(text) {
  return String(text || "")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/([,;:!?])(?![\s\n"'”’)\]}»])/g, "$1 ")
    .replace(/([.])(?![.\s\n"'”’)\]}»])/g, "$1 ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeTranslatedChunks(chunks) {
  const normalizedChunks = [];

  (chunks || []).forEach(function (chunkText) {
    if (typeof chunkText !== "string") return;
    const cleaned = normalizePunctuationSpacing(chunkText);
    if (!cleaned) return;

    if (normalizedChunks.length === 0) {
      normalizedChunks.push(cleaned);
      return;
    }

    const previousChunk = normalizedChunks[normalizedChunks.length - 1];
    const previousParagraphs = splitParagraphs(previousChunk);
    const currentParagraphs = splitParagraphs(cleaned);

    if (previousParagraphs.length && currentParagraphs.length) {
      const previousTail = toComparableText(
        previousParagraphs[previousParagraphs.length - 1],
      );

      while (currentParagraphs.length > 0) {
        const currentHead = toComparableText(currentParagraphs[0]);
        if (
          previousTail &&
          currentHead &&
          currentHead.length > 20 &&
          currentHead === previousTail
        ) {
          currentParagraphs.shift();
          continue;
        }
        break;
      }
    }

    const mergedCurrent = currentParagraphs.join("\n\n").trim();
    if (mergedCurrent) normalizedChunks.push(mergedCurrent);
  });

  return normalizedChunks;
}

function buildFinalTextFromChunks(chunks) {
  return normalizeTranslatedChunks(chunks).join("\n\n");
}

function postProcessTranslationOutput(rawText, sourceChunk, strictMode) {
  const tagged = extractTaggedTranslation(rawText);
  if (!strictMode && isSpeedOptimizedMode()) {
    return normalizePunctuationSpacing(tagged);
  }
  const noSourceEcho = stripLeadingSourceEcho(tagged, sourceChunk);
  const noRepeat = dedupeConsecutiveParagraphs(noSourceEcho);
  return normalizePunctuationSpacing(noRepeat);
}

function hasSevereSourceEcho(translatedText, sourceChunk) {
  const outputComparable = toComparableText(translatedText);
  const sourceComparable = toComparableText(sourceChunk);
  if (!outputComparable || !sourceComparable) return false;

  const prefixProbeLength = Math.min(180, sourceComparable.length);
  if (prefixProbeLength >= 120) {
    const probe = sourceComparable.slice(0, prefixProbeLength);
    if (outputComparable.startsWith(probe)) return true;
  }

  const sourceLines = String(sourceChunk || "")
    .split(/\n+/)
    .map(function (line) {
      return toComparableText(line);
    })
    .filter(function (line) {
      return line.length > 25;
    });
  if (!sourceLines.length) return false;

  const sourceSet = new Set(sourceLines);
  const outputLines = String(translatedText || "")
    .split(/\n+/)
    .map(function (line) {
      return toComparableText(line);
    })
    .filter(function (line) {
      return line.length > 25;
    });
  if (!outputLines.length) return false;

  const overlapCount = outputLines.filter(function (line) {
    return sourceSet.has(line);
  }).length;
  return overlapCount >= 2 && overlapCount / outputLines.length > 0.45;
}

function hasSevereRepetition(translatedText) {
  const paragraphs = splitParagraphs(translatedText)
    .map(function (paragraph) {
      return toComparableText(paragraph);
    })
    .filter(function (paragraph) {
      return paragraph.length > 20;
    });
  if (paragraphs.length < 3) return false;

  const countMap = new Map();
  paragraphs.forEach(function (paragraph) {
    countMap.set(paragraph, (countMap.get(paragraph) || 0) + 1);
  });

function hasTruncatedOutput(translatedText) {
  var text = (translatedText || "").trim();
  if (!text) return false;
  var lastChar = text.charAt(text.length - 1);
  // Valid sentence-ending characters
  var validEndings = ".\u3002!?\uFF01\uFF1F\u2026\u300B\u201D\u2019\"";
  if (validEndings.indexOf(lastChar) >= 0) return false;
  // Check if last "word" is cut short — Chinese char mid-sequence or Vietnamese word fragment
  var lastSegment = text.slice(-80);
  // If the text ends with a partial tag or marker, it's truncated
  if (/<[^>]*$/.test(text)) return true;
  // If last line ends mid-word (no space, no punct, and preceded by normal text)
  // Common truncation pattern: text ends with a non-terminal character in the middle of content
  var lines = text.split("\n");
  var lastLine = lines[lines.length - 1].trim();
  if (!lastLine) return false;
  // If lastLine is very short (< 15 chars) and lacks ending punctuation, likely truncated
  if (lastLine.length < 15 && !/[.\u3002!?\uFF01\uFF1F\u2026]\s*$/.test(lastLine)) {
    // But don't flag if it's clearly a standalone short line (e.g. chapter title, dialogue line)
    if (!/^(?:\u201C|\u2018|\u300C|\u300E|[A-Z\u00C0-\u1EF9])/.test(lastLine)) {
      return true;
    }
  }
  // Heuristic: translated content should NOT end with a comma or conjunction-like word
  if (/[,;\uFF0C\u3001]\s*$/.test(lastLine)) return true;
  return false;
}
  const duplicateCount = Array.from(countMap.values()).filter(function (count) {
    return count > 1;
  }).length;
  const highestRepeat = Math.max.apply(
    null,
    Array.from(countMap.values()),
  );

  if (highestRepeat >= 3) return true;
  return duplicateCount / paragraphs.length > 0.35;
}

function splitChunkForContextRetry(chunkText) {
  const text = String(chunkText || "");
  if (text.length < 1200) return null;

  const midpoint = Math.floor(text.length / 2);
  const candidateBreaks = [
    text.lastIndexOf("\n\n", midpoint),
    text.lastIndexOf(". ", midpoint),
    text.lastIndexOf("\n", midpoint),
  ];
  let splitPos = candidateBreaks.find(function (position) {
    return position > text.length * 0.25;
  });
  if (!splitPos || splitPos <= 0) splitPos = midpoint;

  const rightStart =
    text[splitPos] === "\n" ? splitPos + 1 : text[splitPos + 1] === " " ? splitPos + 2 : splitPos;
  const left = text.slice(0, splitPos).trim();
  const right = text.slice(rightStart).trim();

  if (!left || !right) return null;
  return [left, right];
}

// Caching system using localStorage
const CACHE_PREFIX = "translator_cache_";
const CACHE_VERSION = "2";
const STORY_ANALYSIS_CACHE_PREFIX = "story_analysis_cache_v1:";

function getCacheKey(chunkHash, model, provider) {
  return `${CACHE_PREFIX}${CACHE_VERSION}:${provider}:${model}:${chunkHash}`;
}

async function getCachedTranslation(
  chunkHash,
  model,
  provider,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
) {
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
    console.warn("Cache read error:", e);
    return null;
  }
}

async function setCacheTranslation(chunkHash, model, provider, translation) {
  try {
    const key = getCacheKey(chunkHash, model, provider);
    const entry = {
      translation,
      timestamp: Date.now(),
    };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch (e) {
    // Storage quota exceeded or disabled
    console.warn("Cache write error:", e);
  }
}

function getStoryAnalysisCacheKey(fileHash) {
  if (!fileHash) return "";
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
    localStorage.setItem(
      key,
      JSON.stringify({
        analysis,
        timestamp: Date.now(),
      }),
    );
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

function getTranslationScopePercent() {
  const raw = Number.parseInt(
    document.getElementById("translationScope")?.value,
    10,
  );
  if (!Number.isFinite(raw)) return 100;
  return Math.max(1, Math.min(100, raw));
}

function applyTranslationScope(chunks) {
  const scope = getTranslationScopePercent();
  if (scope >= 100) return chunks;
  const scopedCount = Math.max(1, Math.ceil(chunks.length * (scope / 100)));
  return chunks.slice(0, scopedCount);
}
