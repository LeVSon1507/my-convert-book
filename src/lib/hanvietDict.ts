import type { GlossaryPair } from "@/lib/glossary";

// Names in Chinese web novels are almost always 2-4 Han tu (see hanviet-dict.README.md
// for the length distribution); a single character is too common to be a useful glossary
// hint, so it's excluded even though the dictionary has entries for it.
const MIN_TERM_LEN = 2;
const MAX_TERM_LEN = 4;
const MIN_OCCURRENCES = 3;
const MAX_ENTRIES = 40;

type HanVietDict = Record<string, string>;

let dictPromise: Promise<HanVietDict> | null = null;

function loadHanVietDict(): Promise<HanVietDict> {
  if (!dictPromise) {
    dictPromise = import("@/data/hanviet-dict.json").then(
      (module) => module.default as HanVietDict,
    );
  }
  return dictPromise;
}

/**
 * Scans source text for recurring Chinese terms (candidate proper nouns) that exist in
 * the Han-Viet dictionary, and returns them as glossary pairs — a free, local stand-in
 * for an AI glossary pre-pass. Greedy longest-match-first per position, consuming matched
 * characters so overlapping substrings of the same name aren't double-counted.
 */
export async function extractAutoGlossary(
  sourceText: string,
): Promise<GlossaryPair[]> {
  const text = sourceText || "";
  if (!text.trim()) return [];

  const dict = await loadHanVietDict();
  const counts = new Map<string, number>();
  const len = text.length;
  let i = 0;

  while (i < len) {
    let matchedLen = 0;
    for (let l = Math.min(MAX_TERM_LEN, len - i); l >= MIN_TERM_LEN; l--) {
      const candidate = text.slice(i, i + l);
      if (Object.hasOwn(dict, candidate)) {
        counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
        matchedLen = l;
        break;
      }
    }
    i += matchedLen > 0 ? matchedLen : 1;
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= MIN_OCCURRENCES)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_ENTRIES)
    .map(([term]) => ({ source: term, target: dict[term] }))
    .filter((pair) => pair.target);
}
