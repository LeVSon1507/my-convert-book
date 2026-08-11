const MARKDOWN_FENCE_START_RE = /^```(?:text|markdown)?\s*/i;
const MARKDOWN_FENCE_END_RE = /\s*```$/;
const NON_COMPARABLE_CHARS_RE = /[^a-z0-9À-ɏḀ-ỿ]+/g;
const QUOTE_LIKE_CHARS = String.raw`"'”’)\]}»`;
const SENTENCE_END_CHARS = ".。!?！？…";
const VALID_LINE_ENDINGS = `${SENTENCE_END_CHARS}》”’"`;

export function normalizeTranslatedText(text: string): string {
  if (!text) return "";
  return (
    text
      .trim()
      // Some providers still wrap in markdown fences; strip for cleaner export.
      .replace(MARKDOWN_FENCE_START_RE, "")
      .replace(MARKDOWN_FENCE_END_RE, "")
      // Markdown bold markers aren't used in Vietnamese prose.
      .replaceAll("**", "")
      // Collapse sequences of 2+ em dashes into one.
      .replace(/—{2,}/g, "—")
      // Em dashes are used as dialogue markers; no leading space before them.
      .replace(/^[ \t]+—/gm, "—")
      .trim()
  );
}

export function toComparableText(text: string): string {
  return String(text || "")
    .replaceAll("\r\n", "\n")
    .toLowerCase()
    .replace(NON_COMPARABLE_CHARS_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type TranslationPromptContext = {
  glossaryInstruction?: string;
  prevTranslatedTail?: string;
  summaryBefore?: string;
};

export function buildTranslationUserPrompt(
  chunkText: string,
  strictMode: boolean,
  speedMode: boolean,
  contextInfo?: TranslationPromptContext,
): string {
  const {
    glossaryInstruction = "",
    prevTranslatedTail = "",
    summaryBefore = "",
  } = contextInfo ?? {};

  if (!strictMode && speedMode) {
    const speedPrompt = glossaryInstruction
      ? `Dịch tiếng Việt tự nhiên, giữ ý và xuống dòng. Từ vựng:\n${glossaryInstruction}`
      : "Dịch tiếng Việt tự nhiên, giữ ý và xuống dòng";
    return `${speedPrompt}:\n\n${chunkText}`;
  }

  // Standard mode: system prompt handles requirements.
  // User prompt is context-only + chunk. Keeps tokens low, quality high.
  const contextLines = [
    summaryBefore && `Tóm tắt: ${summaryBefore.slice(0, 600)}`,
    glossaryInstruction && `Từ vựng:\n${glossaryInstruction}`,
    prevTranslatedTail && `Trước: ${prevTranslatedTail}`,
    strictMode && "(dịch nghiêm ngặt, ưu tiên chính xác ngắn gọn)",
  ].filter(Boolean);

  const prefix = contextLines.length ? `${contextLines.join("\n")}\n\n` : "";
  return prefix + chunkText;
}

function extractTaggedTranslation(text: string): string {
  const normalized = normalizeTranslatedText(text);
  const tagged = new RegExp(
    /<vi_translation>\s*([\s\S]*?)\s*<\/vi_translation>/i,
  ).exec(normalized);
  return tagged ? tagged[1].trim() : normalized;
}

function splitParagraphs(text: string): string[] {
  return String(text || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Counts how many leading items satisfy `predicate`, stopping at the first miss. */
function countLeadingWhile<T>(
  items: T[],
  predicate: (item: T) => boolean,
): number {
  let count = 0;
  while (count < items.length && predicate(items[count])) count++;
  return count;
}

function stripLeadingSourceEcho(
  translatedText: string,
  sourceChunk: string,
): string {
  const outputParagraphs = splitParagraphs(translatedText);
  if (!outputParagraphs.length) return translatedText;

  const sourceSet = new Set(splitParagraphs(sourceChunk).map(toComparableText));

  const leadingEchoCount = countLeadingWhile(outputParagraphs, (paragraph) => {
    const probe = toComparableText(paragraph);
    return Boolean(probe) && probe.length >= 30 && sourceSet.has(probe);
  });

  if (leadingEchoCount > 0 && leadingEchoCount < outputParagraphs.length) {
    return outputParagraphs.slice(leadingEchoCount).join("\n\n");
  }

  return translatedText;
}

function dedupeConsecutiveParagraphs(text: string): string {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length <= 1) return String(text || "").trim();

  const deduped: string[] = [];
  for (const paragraph of paragraphs) {
    const current = toComparableText(paragraph);
    if (!current) continue;

    const previous = toComparableText(deduped.at(-1) ?? "");
    const isExactDuplicate = current === previous;
    const isNearDuplicate =
      current.length > 40 &&
      previous.length > 40 &&
      (current.includes(previous) || previous.includes(current));

    if (!isExactDuplicate && !isNearDuplicate) deduped.push(paragraph);
  }

  return deduped.join("\n\n").trim();
}

function normalizePunctuationSpacing(text: string): string {
  return String(text || "")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(
      new RegExp(String.raw`([,;:!?])(?![\s\n${QUOTE_LIKE_CHARS}])`, "g"),
      "$1 ",
    )
    .replace(
      new RegExp(String.raw`([.])(?![.\s\n${QUOTE_LIKE_CHARS}])`, "g"),
      "$1 ",
    )
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Drops paragraphs from the start of `paragraphs` that just repeat the previous chunk's last paragraph. */
function dropOverlapWithPrevious(
  paragraphs: string[],
  previousTail: string,
): string[] {
  if (!previousTail) return paragraphs;
  const overlapCount = countLeadingWhile(paragraphs, (paragraph) => {
    const head = toComparableText(paragraph);
    return head.length > 20 && head === previousTail;
  });
  return paragraphs.slice(overlapCount);
}

export function normalizeTranslatedChunks(
  chunks: (string | null | undefined)[],
): string[] {
  const result: string[] = [];

  for (const chunkText of chunks ?? []) {
    if (typeof chunkText !== "string") continue;
    const cleaned = normalizePunctuationSpacing(chunkText);
    if (!cleaned) continue;

    const currentParagraphs = splitParagraphs(cleaned);
    const previousChunk = result.at(-1);
    const previousTail = previousChunk
      ? toComparableText(splitParagraphs(previousChunk).at(-1) ?? "")
      : "";

    const merged = dropOverlapWithPrevious(currentParagraphs, previousTail)
      .join("\n\n")
      .trim();
    if (merged) result.push(merged);
  }

  return result;
}

export function buildFinalTextFromChunks(
  chunks: (string | null | undefined)[],
): string {
  return normalizeTranslatedChunks(chunks).join("\n\n");
}

export function postProcessTranslationOutput(
  rawText: string,
  sourceChunk: string,
  strictMode: boolean,
  speedMode: boolean,
): string {
  const tagged = extractTaggedTranslation(rawText);
  if (!strictMode && speedMode) {
    return normalizePunctuationSpacing(tagged);
  }
  const noSourceEcho = stripLeadingSourceEcho(tagged, sourceChunk);
  const noRepeat = dedupeConsecutiveParagraphs(noSourceEcho);
  return normalizePunctuationSpacing(noRepeat);
}

export function hasSevereSourceEcho(
  translatedText: string,
  sourceChunk: string,
): boolean {
  const outputComparable = toComparableText(translatedText);
  const sourceComparable = toComparableText(sourceChunk);
  if (!outputComparable || !sourceComparable) return false;

  const prefixProbeLength = Math.min(180, sourceComparable.length);
  if (prefixProbeLength >= 120) {
    const probe = sourceComparable.slice(0, prefixProbeLength);
    if (outputComparable.startsWith(probe)) return true;
  }

  const longLine = (line: string) => toComparableText(line).length > 25;
  const sourceLines = String(sourceChunk || "")
    .split(/\n+/)
    .filter(longLine)
    .map(toComparableText);
  if (!sourceLines.length) return false;

  const sourceSet = new Set(sourceLines);
  const outputLines = String(translatedText || "")
    .split(/\n+/)
    .filter(longLine)
    .map(toComparableText);
  if (!outputLines.length) return false;

  const overlapCount = outputLines.filter((line) => sourceSet.has(line)).length;
  return overlapCount >= 2 && overlapCount / outputLines.length > 0.45;
}

export function hasSevereRepetition(translatedText: string): boolean {
  const paragraphs = splitParagraphs(translatedText)
    .map(toComparableText)
    .filter((paragraph) => paragraph.length > 20);
  if (paragraphs.length < 3) return false;

  // Single pass: track per-paragraph counts, how many paragraphs have a duplicate,
  // and the highest repeat count — avoids building the count map twice.
  const counts = new Map<string, number>();
  let duplicateParagraphCount = 0;
  let highestRepeat = 1;

  for (const paragraph of paragraphs) {
    const count = (counts.get(paragraph) ?? 0) + 1;
    counts.set(paragraph, count);
    if (count === 2) duplicateParagraphCount++;
    if (count > highestRepeat) highestRepeat = count;
  }

  if (highestRepeat >= 3) return true;
  return duplicateParagraphCount / paragraphs.length > 0.35;
}

/**
 * NOTE: in the legacy script (04-translation-quality-utils.js) this function was
 * accidentally nested inside hasSevereRepetition's body, making it unreachable as a
 * global — callers in 09a-translate-chunk.js invoke it as a top-level function, which
 * would throw ReferenceError at runtime. Restored as a standalone function here.
 */
export function hasTruncatedOutput(translatedText: string, sourceChunk = ""): boolean {
  const text = (translatedText || "").trim();
  if (!text) return false;

  // A model that stops early can still end on a grammatically complete,
  // properly-punctuated sentence (observed: Grok announcing "tôi sẽ chia
  // thành nhiều phần" mid-translation then closing that sentence with "?"),
  // which defeats every check below since they only look at how the text
  // ends. Convert-Hán-Việt output runs roughly as long as the source or
  // longer, so output well under half the source length is truncated
  // regardless of how tidy its last sentence looks.
  const sourceLength = sourceChunk.trim().length;
  if (sourceLength > 200 && text.length < sourceLength * 0.45) return true;

  const lastChar = text.at(-1) ?? "";
  if (VALID_LINE_ENDINGS.includes(lastChar)) return false;
  if (/<[^>]*$/.test(text)) return true;

  const lastLine = text.split("\n").at(-1)?.trim() ?? "";
  if (!lastLine) return false;

  const endsWithSentencePunctuation = new RegExp(
    String.raw`[${SENTENCE_END_CHARS}]\s*$`,
  ).test(lastLine);
  const looksLikeStandaloneLine = /^(?:“|‘|「|『|[A-ZÀ-ỹ])/.test(lastLine);
  if (
    lastLine.length < 15 &&
    !endsWithSentencePunctuation &&
    !looksLikeStandaloneLine
  ) {
    return true;
  }

  return /[,;，、]\s*$/.test(lastLine);
}

export function splitChunkForContextRetry(
  chunkText: string,
): [string, string] | null {
  const text = String(chunkText || "");
  if (text.length < 1200) return null;

  const midpoint = Math.floor(text.length / 2);
  const candidateBreaks = [
    text.lastIndexOf("\n\n", midpoint),
    text.lastIndexOf(". ", midpoint),
    text.lastIndexOf("\n", midpoint),
  ];
  const splitPos =
    candidateBreaks.find((position) => position > text.length * 0.25) ??
    midpoint;
  const safeSplitPos = splitPos <= 0 ? midpoint : splitPos;

  let rightStart: number;

  if (text[safeSplitPos] === "\n") {
    rightStart = safeSplitPos + 1;
  } else if (text[safeSplitPos + 1] === " ") {
    rightStart = safeSplitPos + 2;
  } else {
    rightStart = safeSplitPos;
  }

  const left = text.slice(0, safeSplitPos).trim();
  const right = text.slice(rightStart).trim();

  if (!left || !right) return null;
  return [left, right];
}
