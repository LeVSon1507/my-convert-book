import { NextResponse } from "next/server";
import { authorizeJobAccess, isNextResponse } from "@/lib/translateJobsApi";
import { updateTranslationJob } from "@/lib/translationJobs";

/**
 * Only flips the job to "stopping" — it doesn't stop synchronously. The next tick
 * (already in flight or the next self-chain hop) sees the status change, stops
 * launching new chunks, lets any in-flight ones finish, and flips to "stopped".
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = await authorizeJobAccess(request, jobId);
  if (isNextResponse(job)) return job;

  if (job.status === "running") {
    await updateTranslationJob(jobId, { status: "stopping" });
  }
  return NextResponse.json({ ok: true });
}
