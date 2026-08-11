import { NextResponse } from "next/server";
import type { Timestamp } from "firebase-admin/firestore";
import { getUidFromAuthHeader } from "@/lib/firebaseAdmin";
import { getTranslationJob, type TranslationJobDoc } from "@/lib/translationJobs";

/** Shared request-handling helpers for the /api/translate/jobs/* route handlers. */

export async function requireUid(
  request: Request,
): Promise<string | NextResponse> {
  const uid = await getUidFromAuthHeader(request);
  if (!uid) {
    return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });
  }
  return uid;
}

function isInternalRequest(request: Request): boolean {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const secret = process.env.INTERNAL_JOB_SECRET;
  return Boolean(secret) && token === secret;
}

export type OwnedJob = TranslationJobDoc & { id: string };

/**
 * Authorizes either an internal caller (self-chain tick / cron sweep, using
 * INTERNAL_JOB_SECRET — there's no user session in that context) or the job's
 * owning user (a signed-in browser tab explicitly nudging/checking/stopping its
 * own job). Every job-scoped route (status, tick, stop, text) goes through this
 * so a user can never read or influence another user's job.
 */
export async function authorizeJobAccess(
  request: Request,
  jobId: string,
): Promise<OwnedJob | NextResponse> {
  const job = await getTranslationJob(jobId);
  if (!job) {
    return NextResponse.json({ error: "Không tìm thấy job." }, { status: 404 });
  }

  if (isInternalRequest(request)) return job;

  const uid = await getUidFromAuthHeader(request);
  if (!uid || uid !== job.uid) {
    return NextResponse.json({ error: "Không có quyền truy cập job này." }, { status: 403 });
  }
  return job;
}

export function isNextResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}

/**
 * Never leak the stored provider API key back to the client, and convert the
 * Firestore Timestamp fields to plain millis — relying on JSON.stringify's
 * incidental `{_seconds,_nanoseconds}` shape for a Timestamp would tie client code
 * to an SDK internal representation that isn't a documented contract.
 */
export function toPublicJob(job: OwnedJob) {
  const { apiKey: _apiKey, leaseExpiresAt: _leaseExpiresAt, createdAt, updatedAt, ...rest } = job;
  void _apiKey;
  void _leaseExpiresAt;
  return {
    ...rest,
    createdAtMs: (createdAt as Timestamp).toMillis(),
    updatedAtMs: (updatedAt as Timestamp).toMillis(),
  };
}
