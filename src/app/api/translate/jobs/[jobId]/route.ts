import { NextResponse } from "next/server";
import { authorizeJobAccess, isNextResponse, toPublicJob } from "@/lib/translateJobsApi";
import { getJobProgress } from "@/lib/translationJobs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const job = await authorizeJobAccess(request, jobId);
  if (isNextResponse(job)) return job;

  const progress = await getJobProgress(jobId);
  return NextResponse.json({ job: toPublicJob(job), progress });
}
