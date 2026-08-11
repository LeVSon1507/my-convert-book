import { NextResponse } from "next/server";
import { authorizeJobAccess, isNextResponse } from "@/lib/translateJobsApi";
import { getOrderedChunkTexts } from "@/lib/translationJobs";
import { buildFinalTextFromChunks, normalizeTranslatedChunks } from "@/lib/quality";

/**
 * Full translated text for the result view / export buttons. Deliberately not
 * included in the lightweight status poll (GET /api/translate/jobs/[jobId]) — that
 * fires every ~3s while a job runs and shouldn't re-fetch a whole book's worth of
 * text each time.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = await authorizeJobAccess(request, jobId);
  if (isNextResponse(job)) return job;

  const orderedTexts = await getOrderedChunkTexts(jobId, job.totalChunks);
  const doneChunks = normalizeTranslatedChunks(orderedTexts);
  return NextResponse.json({
    text: buildFinalTextFromChunks(orderedTexts),
    chunks: doneChunks,
  });
}
