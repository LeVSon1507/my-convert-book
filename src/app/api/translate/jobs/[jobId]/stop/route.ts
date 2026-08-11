import { NextResponse } from "next/server";
import { authorizeJobAccess, isNextResponse } from "@/lib/translateJobsApi";
import { appendJobLog, updateTranslationJob } from "@/lib/translationJobs";

/**
 * Hard-stop request: mark the job as "stopped" immediately so the UI can reflect
 * the state right away. In-flight chunks may still be finishing their current API
 * calls, but the worker ignores their writes once status is no longer "running".
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = await authorizeJobAccess(request, jobId);
  if (isNextResponse(job)) return job;

  if (job.status === "running" || job.status === "stopping") {
    await updateTranslationJob(jobId, { status: "stopped" });
    await appendJobLog(jobId, "Đã dừng bởi người dùng.", "warning").catch(
      () => {},
    );
  }
  return NextResponse.json({ ok: true });
}
