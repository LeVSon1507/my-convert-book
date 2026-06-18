const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type CacheEntry<T> = { value: T; timestamp: number };

/** Generic localStorage TTL cache, shared by the translation and story-analysis caches below. */
function readEntry<T>(key: string, maxAgeMs: number): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;

    const entry: CacheEntry<T> = JSON.parse(raw);
    if (!entry || Date.now() - entry.timestamp > maxAgeMs) {
      localStorage.removeItem(key);
      return null;
    }
    return entry.value;
  } catch (e) {
    console.warn("Cache read error:", e);
    return null;
  }
}

function writeEntry<T>(key: string, value: T): void {
  try {
    const entry: CacheEntry<T> = { value, timestamp: Date.now() };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch (e) {
    console.warn("Cache write error:", e);
  }
}

const TRANSLATION_CACHE_PREFIX = "translator_cache_2";
const STORY_ANALYSIS_CACHE_PREFIX = "story_analysis_cache_v1";

function translationCacheKey(chunkHash: string, model: string, provider: string): string {
  return `${TRANSLATION_CACHE_PREFIX}:${provider}:${model}:${chunkHash}`;
}

export function getCachedTranslation(
  chunkHash: string,
  model: string,
  provider: string,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): string | null {
  return readEntry(translationCacheKey(chunkHash, model, provider), maxAgeMs);
}

export function setCacheTranslation(
  chunkHash: string,
  model: string,
  provider: string,
  translation: string,
): void {
  writeEntry(translationCacheKey(chunkHash, model, provider), translation);
}

export function getCachedStoryAnalysis(
  fileHash: string,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
): string | null {
  if (!fileHash) return null;
  return readEntry(`${STORY_ANALYSIS_CACHE_PREFIX}:${fileHash}`, maxAgeMs);
}

export function setCachedStoryAnalysis(fileHash: string, analysis: string): void {
  if (!fileHash || !analysis) return;
  writeEntry(`${STORY_ANALYSIS_CACHE_PREFIX}:${fileHash}`, analysis);
}

/**
 * Groups chunks by identical normalized content so callers only need to translate
 * each distinct text once — repeated separators/headers in scanned/OCR'd source
 * text would otherwise burn API tokens translating the same string N times.
 * `resolve(uniqueText)` is called once per distinct chunk; its result is broadcast
 * back to every original index that shared that text.
 */
export async function translateUniqueChunks<T>(
  chunks: string[],
  resolve: (uniqueText: string, firstIndex: number) => Promise<T>,
): Promise<T[]> {
  const indicesByText = new Map<string, number[]>();
  chunks.forEach((text, index) => {
    const key = text.trim();
    const indices = indicesByText.get(key);
    if (indices) indices.push(index);
    else indicesByText.set(key, [index]);
  });

  const results: T[] = new Array(chunks.length);
  await Promise.all(
    Array.from(indicesByText.entries()).map(async ([text, indices]) => {
      const value = await resolve(text, indices[0]);
      indices.forEach((index) => {
        results[index] = value;
      });
    }),
  );

  return results;
}
