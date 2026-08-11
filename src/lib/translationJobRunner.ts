import { after } from "next/server";
import {
  appendJobLog,
  claimJobLease,
  getJobProgress,
  getOrderedChunkTexts,
  getTranslationJob,
  getWorkBatch,
  hasRemainingWork,
  releaseJobLease,
  updateTranslationJob,
  writeChunkFailure,
  writeChunkSuccess,
  type TranslationJobDoc,
} from "@/lib/translationJobs";
import { callChatApiDirect } from "@/lib/chatApi";
import { ensureOpenRouterPricingLoaded, shouldSkipTranslation } from "@/lib/providers";
import {
  translateChunkWithRetry,
  type EngineParams,
  type UsageDelta,
} from "@/lib/translationEngine";
import { buildFinalTextFromChunks } from "@/lib/quality";
import { saveTranslationServer } from "@/lib/translationHistoryAdmin";

/**
 * Self-chaining backend worker: each call processes a time-boxed batch of chunks
 * then, if work remains, schedules its own HTTP continuation via next/server's
 * after() before returning — this is the mechanism that keeps translation going
 * with no browser tab open. See src/app/api/translate/jobs/[jobId]/tick/route.ts
 * for the entry point that invokes this over HTTP, and the daily cron sweep at
 * src/app/api/cron/resume-stalled-jobs/route.ts for the safety net if a chain
 * breaks (Vercel Hobby only allows once/day cron, so the self-chain — not cron —
 * is what actually keeps a job moving).
 */

const TICK_BUDGET_MS = 45_000;
const MAX_TRANSLATE_ATTEMPTS_PER_CHUNK = 3;

function getBaseUrl(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

export function scheduleNextTick(jobId: string): void {
  after(async () => {
    try {
      await fetch(`${getBaseUrl()}/api/translate/jobs/${jobId}/tick`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.INTERNAL_JOB_SECRET}` },
      });
    } catch {
      // Best effort — the daily cron sweep and the client's stale-poll nudge
      // (see resumeActiveBackendJob in translationStore.ts) are the safety nets
      // if this particular continuation is lost.
    }
  });
}

async function processOneChunk(
  job: TranslationJobDoc & { id: string },
  chunk: { index: number; source: string },
  params: EngineParams,
): Promise<void> {
  if (shouldSkipTranslation(chunk.source)) {
    await writeChunkSuccess(job.id, chunk.index, chunk.source, {
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
    }).catch((e) => console.error(`[job ${job.id}] writeChunkSuccess (skip) failed`, e));
    return;
  }

  let usage: UsageDelta = { promptTokens: 0, completionTokens: 0, cost: 0 };
  try {
    const translated = await translateChunkWithRetry(
      chunk.source,
      MAX_TRANSLATE_ATTEMPTS_PER_CHUNK,
      params,
      callChatApiDirect,
      (delta) => {
        usage = {
          promptTokens: usage.promptTokens + delta.promptTokens,
          completionTokens: usage.completionTokens + delta.completionTokens,
          cost: usage.cost + delta.cost,
        };
      },
    );
    await writeChunkSuccess(job.id, chunk.index, translated, usage);
    await appendJobLog(
      job.id,
      `✓ Hoàn thành đoạn ${chunk.index + 1}/${job.totalChunks}`,
      "success",
    ).catch(() => {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeChunkFailure(job.id, chunk.index, message).catch((e) =>
      console.error(`[job ${job.id}] writeChunkFailure failed`, e),
    );
    await appendJobLog(job.id, `✗ Lỗi đoạn ${chunk.index + 1}: ${message}`, "error").catch(
      () => {},
    );
  }
}

/**
 * Wave-based concurrency (fetch up to N pending/retryable chunks, run them in
 * parallel, wait for the wave, repeat) rather than the client's stream-as-slots-
 * free scheduler — simpler to reason about against Firestore, and ticks already
 * chain rapidly so waiting on a wave's slowest chunk costs little in practice.
 */
async function processAvailableWork(
  job: TranslationJobDoc & { id: string },
  deadline: number,
): Promise<void> {
  const params: EngineParams = {
    provider: job.provider,
    model: job.model,
    apiKey: job.apiKey,
    baseUrl: job.baseUrl,
    temperature: job.temperature,
    systemPrompt: job.systemPrompt,
    glossaryInstruction: job.glossaryInstruction,
  };

  while (Date.now() < deadline) {
    const latest = await getTranslationJob(job.id);
    if (!latest || latest.status !== "running") return;

    const batch = await getWorkBatch(job.id, job.concurrentRequests);
    if (batch.length === 0) return;

    await Promise.all(batch.map((chunk) => processOneChunk(job, chunk, params)));

    if (job.delayBetweenChunks > 0) {
      await new Promise((resolve) => setTimeout(resolve, job.delayBetweenChunks));
    }
  }
}

async function finalizeJob(job: TranslationJobDoc & { id: string }): Promise<void> {
  const orderedTexts = await getOrderedChunkTexts(job.id, job.totalChunks);
  const finalText = buildFinalTextFromChunks(orderedTexts);
  const progress = await getJobProgress(job.id);

  await saveTranslationServer(job.uid, finalText, {
    fileName: job.fileName,
    model: job.model,
    provider: job.provider,
    totalChunks: job.totalChunks,
    promptTokens: progress.promptTokens,
    completionTokens: progress.completionTokens,
    cost: progress.cost,
  });

  await updateTranslationJob(job.id, { status: "completed" });
  await appendJobLog(job.id, "🎉 Hoàn thành!", "success").catch(() => {});
}

export async function runJobTick(jobId: string): Promise<void> {
  const claimed = await claimJobLease(jobId);
  if (!claimed) return;

  try {
    const job = await getTranslationJob(jobId);
    if (!job || job.status !== "running") return;

    // Serverless function instances don't share memory with the browser, so
    // the client's own pricing refresh (see ProviderAndModel.tsx) never
    // reaches this runtime — each warm instance needs its own refresh. Fire
    // and forget (not awaited): this fetch has no timeout of its own, and a
    // slow/hung request must never block chunk processing or the self-chain.
    // The 12h TTL makes it a no-op after the first tick per warm instance.
    if (job.provider === "openrouter") {
      void ensureOpenRouterPricingLoaded().catch(() => {});
    }

    const deadline = Date.now() + TICK_BUDGET_MS;
    await processAvailableWork(job, deadline);

    const stillHasWork = await hasRemainingWork(jobId);
    const latest = await getTranslationJob(jobId);
    if (!latest) return;

    if (latest.status === "stopping") {
      await updateTranslationJob(jobId, { status: "stopped" });
      await appendJobLog(jobId, "Đã dừng bởi người dùng.", "warning").catch(() => {});
      return;
    }

    if (!stillHasWork) {
      await finalizeJob(latest);
      return;
    }

    if (latest.status === "running") {
      scheduleNextTick(jobId);
    }
  } catch (err) {
    await updateTranslationJob(jobId, {
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
  } finally {
    await releaseJobLease(jobId).catch(() => {});
  }
}
