import { NextResponse } from "next/server";
import { listStaleRunningJobIds } from "@/lib/translationJobs";
import { runJobTick } from "@/lib/translationJobRunner";

/**
 * Safety net, not the primary mechanism — translation jobs normally keep moving via
 * the self-chaining tick (see translationJobRunner.ts) and the client's stale-poll
 * nudge (translationStore.ts). This only matters if BOTH of those fail (e.g. the
 * user never reopens the tab and a self-chain fetch got dropped). On Vercel Hobby,
 * cron can only run once/day (see vercel.json), so a fully broken chain can stall
 * up to ~24h before this recovers it — acceptable for a personal-project Hobby
 * deployment, and trivial to tighten to every few minutes on Pro.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const staleJobIds = await listStaleRunningJobIds();
  for (const jobId of staleJobIds) {
    await runJobTick(jobId).catch((e) =>
      console.error(`[cron] resume-stalled-jobs failed for ${jobId}`, e),
    );
  }

  return NextResponse.json({ resumed: staleJobIds.length });
}
