const CJK_SENTENCE_ENDS = ["。", "!", "?", "…"];
const EN_SENTENCE_ENDS = [". ", "! ", "? "];

/**
 * Break strategies tried in priority order against the search window: paragraph
 * break > CJK sentence end > EN sentence end > plain newline. Each returns the
 * offset *within the window* right after the break, or -1 if not found.
 */
const BREAK_STRATEGIES: {
  find: (window: string) => number;
  breakLength: number;
}[] = [
  { find: (w) => w.lastIndexOf("\n\n"), breakLength: 2 },
  {
    find: (w) => Math.max(...CJK_SENTENCE_ENDS.map((p) => w.lastIndexOf(p))),
    breakLength: 1,
  },
  {
    find: (w) => Math.max(...EN_SENTENCE_ENDS.map((p) => w.lastIndexOf(p))),
    breakLength: 2,
  },
  { find: (w) => w.lastIndexOf("\n"), breakLength: 1 },
];

function findBreakOffset(window: string): number | null {
  for (const { find, breakLength } of BREAK_STRATEGIES) {
    const index = find(window);
    if (index >= 0) return index + breakLength;
  }
  return null;
}

export function splitIntoChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  const minSplit = Math.floor(chunkSize * 0.5);
  let currentPos = 0;

  while (currentPos < text.length) {
    const hardEnd = currentPos + chunkSize;
    if (hardEnd >= text.length) {
      chunks.push(text.slice(currentPos));
      break;
    }

    const window = text.slice(currentPos + minSplit, hardEnd + 1);
    const breakOffset = window ? findBreakOffset(window) : null;
    let endPos =
      breakOffset === null ? hardEnd : currentPos + minSplit + breakOffset;

    // Guard: don't produce tiny fragments or overshoot the text length.
    if (endPos <= currentPos + 80) endPos = hardEnd;
    if (endPos > text.length) endPos = text.length;

    chunks.push(text.slice(currentPos, endPos));
    currentPos = endPos;
  }

  return chunks;
}

export type ChapterBoundary = { offset: number; title: string };

export type ChapterDetectionResult = {
  found: boolean;
  count: number;
  boundaries: ChapterBoundary[];
};

export type ChapterMapEntry = {
  chunkIndex: number;
  chapterIndex: number;
  chapterTitle: string;
};

export const CHAPTER_PATTERNS: RegExp[] = [
  /^第\s*[\d零一二三四五六七八九十百千万]+\s*[章卷節回篇]/,
  /^[Cc]hapter\s+\d+/,
  /^CHAPTER\s+\d+/,
  /^[Pp]art\s+\d+/,
  /^卷[\d零一二三四五六七八九十百千万]+/,
  /^第[\d零一二三四五六七八九十百千万]+回/,
  /^(?:序章|前言|尾声|后记|番外\d*)/,
  /^(?:Prologue|Epilogue)/i,
];

function isChapterHeading(line: string): boolean {
  return CHAPTER_PATTERNS.some((pattern) => pattern.test(line));
}

export function detectChapters(text: string): ChapterDetectionResult {
  const lines = text.split("\n");
  const boundaries: ChapterBoundary[] = [];
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineOffset = offset;
    offset += lines[i].length + 1; // +1 for the \n

    const trimmed = lines[i].replace(/\r$/, "").trim();
    const previousTrimmed = i > 0 ? lines[i - 1].replace(/\r$/, "").trim() : "";
    const precededByBlankLine = previousTrimmed === "";

    if (trimmed && isChapterHeading(trimmed) && precededByBlankLine) {
      boundaries.push({ offset: lineOffset, title: trimmed });
    }
  }

  return {
    found: boundaries.length >= 2,
    count: boundaries.length,
    boundaries,
  };
}

function splitChapterIntoChunks(
  chapterText: string,
  chapterIndex: number,
  chapterTitle: string,
  chunkSize: number,
): { chunk: string; map: ChapterMapEntry }[] {
  if (chapterText.length <= chunkSize) {
    return [
      {
        chunk: chapterText,
        map: { chunkIndex: 0, chapterIndex, chapterTitle },
      },
    ];
  }

  return splitIntoChunks(chapterText, chunkSize).map((chunk, subIdx) => ({
    chunk,
    map: {
      chunkIndex: 0, // reassigned by caller once flattened across chapters
      chapterIndex,
      chapterTitle:
        subIdx === 0 ? chapterTitle : `${chapterTitle} (tiếp ${subIdx + 1})`,
    },
  }));
}

export function splitIntoChapterChunks(
  text: string,
  chunkSize: number,
): { chunks: string[]; chapterMap: ChapterMapEntry[] } {
  const { found, boundaries } = detectChapters(text);

  if (!found) {
    const chunks = splitIntoChunks(text, chunkSize);
    return {
      chunks,
      chapterMap: chunks.map((_, chunkIndex) => ({
        chunkIndex,
        chapterIndex: 0,
        chapterTitle: "",
      })),
    };
  }

  const sections: { text: string; chapterIndex: number; title: string }[] = [];
  if (boundaries[0].offset > 0) {
    sections.push({
      text: text.slice(0, boundaries[0].offset),
      chapterIndex: 0,
      title: "序",
    });
  }
  boundaries.forEach(({ offset, title }, i) => {
    const end =
      i + 1 < boundaries.length ? boundaries[i + 1].offset : text.length;
    sections.push({
      text: text.slice(offset, end),
      chapterIndex: i + 1,
      title,
    });
  });

  const chunks: string[] = [];
  const chapterMap: ChapterMapEntry[] = [];
  sections
    .filter((section) => section.text.trim())
    .forEach(({ text: sectionText, chapterIndex, title }) => {
      splitChapterIntoChunks(
        sectionText,
        chapterIndex,
        title,
        chunkSize,
      ).forEach(({ chunk, map }) => {
        chunks.push(chunk);
        chapterMap.push({ ...map, chunkIndex: chunks.length - 1 });
      });
    });

  return { chunks, chapterMap };
}
