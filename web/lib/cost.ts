import { getModelPricing } from "./providers";

export function estimateTokenCount(chars: number): number {
  // Approximate: Vietnamese ~2.5 chars per token, English ~4 chars per token
  // Mixed text: use 3 as average
  return Math.ceil(chars / 3);
}

export function estimateCost(chars: number, model: string, isInput = true): number {
  const pricing = getModelPricing(model);
  const tokens = estimateTokenCount(chars);
  const rate = isInput ? pricing.input : pricing.output;
  return (tokens / 1000000) * rate;
}

export function getMaxTokensForTranslation(chunkText: string): number {
  const estimatedInputTokens = estimateTokenCount((chunkText || "").length);
  const softCap = Math.ceil(estimatedInputTokens * 1.7 + 120);
  return Math.min(16000, Math.max(300, softCap));
}

export function applyTranslationScope<T>(chunks: T[], scopePercent: number): T[] {
  const scope = Math.max(1, Math.min(100, scopePercent));
  if (scope >= 100) return chunks;
  const scopedCount = Math.max(1, Math.ceil(chunks.length * (scope / 100)));
  return chunks.slice(0, scopedCount);
}
