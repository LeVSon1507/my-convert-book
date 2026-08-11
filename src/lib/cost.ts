import { getModelPricing } from "./providers";

const CJK_CHAR_RE = /[一-鿿㐀-䶿豈-﫿]/g;
// Han characters tokenize far denser than Latin-script text — calibrated against
// real OpenRouter usage (mistral-nemo, two chapters of different length): ~1.2-1.3
// tokens per Han character, vs. ~0.33 for Vietnamese/English. Applying the flat
// chars/3 ratio to Chinese source text undercounted input tokens ~3x, which fed
// into getMaxTokensForTranslation below and silently truncated real translations
// mid-chapter.
const CJK_TOKENS_PER_CHAR = 1.25;

export function estimateTokenCount(chars: number): number {
  // Approximate: Vietnamese ~2.5 chars per token, English ~4 chars per token.
  // Mixed Latin-script text: use 3 as average. Only valid for Vietnamese/English —
  // use estimateTokenCountForText for text that may contain Chinese source content.
  return Math.ceil(chars / 3);
}

export function estimateTokenCountForText(text: string): number {
  const content = text || "";
  const cjkChars = (content.match(CJK_CHAR_RE) || []).length;
  const otherChars = content.length - cjkChars;
  return Math.ceil(cjkChars * CJK_TOKENS_PER_CHAR + otherChars / 3);
}

export function costFromTokens(tokens: number, model: string, isInput = true): number {
  const pricing = getModelPricing(model);
  const rate = isInput ? pricing.input : pricing.output;
  return (tokens / 1000000) * rate;
}

export function getMaxTokensForTranslation(chunkText: string): number {
  const estimatedInputTokens = estimateTokenCountForText(chunkText || "");
  const softCap = Math.ceil(estimatedInputTokens * 1.7 + 120);
  return Math.min(16000, Math.max(300, softCap));
}

export function applyTranslationScope<T>(chunks: T[], scopePercent: number): T[] {
  const scope = Math.max(1, Math.min(100, scopePercent));
  if (scope >= 100) return chunks;
  const scopedCount = Math.max(1, Math.ceil(chunks.length * (scope / 100)));
  return chunks.slice(0, scopedCount);
}
