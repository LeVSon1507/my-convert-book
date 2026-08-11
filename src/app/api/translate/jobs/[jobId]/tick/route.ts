import { NextResponse } from "next/server";
import { authorizeJobAccess, isNextResponse } from "@/lib/translateJobsApi";
import { runJobTick } from "@/lib/translationJobRunner";

// Each tick does a bounded batch of work (~45s) then self-schedules its own
// continuation — see src/lib/translationJobRunner.ts. maxDuration is set well
// above that budget purely as headroom, not because ticks are expected to run
// this long: short, frequent ticks react to a Stop request faster and write
// progress more often than one long-lived invocation would.
export const maxDuration = 60;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  const authResult = await authorizeJobAccess(request, jobId);
  if (isNextResponse(authResult)) return authResult;

  await runJobTick(jobId);
  return NextResponse.json({ ok: true });
}
