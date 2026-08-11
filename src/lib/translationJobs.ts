import { AggregateField, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";
import type { ProviderId } from "@/lib/providers";
import type { ChapterMapEntry } from "@/lib/chunking";

// Kept as an independent duplicate of the client store's LogEntry shape (rather than
// importing from src/store/translationStore.ts) so this server-only module never pulls
// the Zustand store — and transitively the Firebase client SDK it imports — into API
// route bundles. Field names must stay in sync with TranslateWorkspace.tsx's rendering.
export type LogEntry = { timestamp: string; message: string; type: string };

/**
 * Server-only Firestore access for backend translation jobs. Top-level
 * `translationJobs/{jobId}` collection (not nested under users/{uid}) because every
 * read/write here goes through firebase-admin from our own API routes — the client
 * SDK never touches this collection directly, so there's no need for a path-based
 * security-rule shape; each route does its own uid ownership check instead.
 *
 * Progress (completed/failed counts, token usage) is deliberately NOT denormalized
 * onto the job doc — it's computed on demand from the chunks subcollection via
 * Firestore aggregate queries (count/sum), which cost one read regardless of chunk
 * count. That avoids atomic-increment bookkeeping and keeps chunk docs the single
 * source of truth.
 */

export type TranslationJobStatus =
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "error";

export type ChunkStatus = "pending" | "done" | "failed";

const JOBS_COLLECTION = "translationJobs";
const CHUNKS_SUBCOLLECTION = "chunks";
// Deliberately much longer than the tick's ~45s internal work budget (see
// TICK_BUDGET_MS in translationJobRunner.ts): the budget only stops new work from
// being *launched*, but an in-flight wave (translateChunkWithRetry, with its own
// 429 backoff up to ~30s per attempt) can legitimately run past it. A lease that
// expired while a wave is still finishing would let a second trigger — self-chain,
// client nudge, or cron — claim the job and double-process chunks concurrently.
const LEASE_MS = 120_000;
export const MAX_CHUNK_RETRIES = 3;
const MAX_LOG_ENTRIES = 50;

export type TranslationJobDoc = {
  uid: string;
  fileName: string;
  fileHash: string;
  provider: ProviderId;
  model: string;
  baseUrl: string;
  apiKey: string;
  chunkSize: number;
  concurrentRequests: number;
  temperature: number;
  delayBetweenChunks: number;
  scopePercent: number;
  systemPrompt: string;
  glossaryInstruction: string;
  totalChunks: number;
  status: TranslationJobStatus;
  logs: LogEntry[];
  chapterMap: ChapterMapEntry[];
  error: string;
  /** Epoch-zero (never a real `null`) means "no active lease" — Firestore's `<`
   *  inequality filter never matches `null`, so the stale-job sweep in
   *  listStaleRunningJobIds() would silently skip a job whose first tick never
   *  fired if this were nullable. */
  leaseExpiresAt: Timestamp;
  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
};

export type CreateTranslationJobInput = {
  uid: string;
  fileName: string;
  fileHash: string;
  provider: ProviderId;
  model: string;
  baseUrl: string;
  apiKey: string;
  chunkSize: number;
  concurrentRequests: number;
  temperature: number;
  delayBetweenChunks: number;
  scopePercent: number;
  systemPrompt: string;
  glossaryInstruction: string;
  chunks: string[];
  chapterMap: ChapterMapEntry[];
};

export type JobProgress = {
  done: number;
  permanentlyFailed: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
};

function jobsCollection() {
  return getAdminDb().collection(JOBS_COLLECTION);
}

function chunksCollection(jobId: string) {
  return jobsCollection().doc(jobId).collection(CHUNKS_SUBCOLLECTION);
}

export async function createTranslationJob(
  input: CreateTranslationJobInput,
): Promise<string> {
  const db = getAdminDb();
  const jobRef = jobsCollection().doc();

  const jobDoc: TranslationJobDoc = {
    uid: input.uid,
    fileName: input.fileName,
    fileHash: input.fileHash,
    provider: input.provider,
    model: input.model,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    chunkSize: input.chunkSize,
    concurrentRequests: input.concurrentRequests,
    temperature: input.temperature,
    delayBetweenChunks: input.delayBetweenChunks,
    scopePercent: input.scopePercent,
    systemPrompt: input.systemPrompt,
    glossaryInstruction: input.glossaryInstruction,
    totalChunks: input.chunks.length,
    status: "running",
    logs: [],
    chapterMap: input.chapterMap,
    error: "",
    leaseExpiresAt: Timestamp.fromMillis(0),
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  await jobRef.set(jobDoc);

  const bulkWriter = db.bulkWriter();
  input.chunks.forEach((source, index) => {
    bulkWriter.set(chunksCollection(jobRef.id).doc(String(index)), {
      source,
      translated: null,
      status: "pending" satisfies ChunkStatus,
      retryCount: 0,
      error: "",
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
    });
  });
  await bulkWriter.close();

  return jobRef.id;
}

export async function getTranslationJob(
  jobId: string,
): Promise<(TranslationJobDoc & { id: string }) | null> {
  const snap = await jobsCollection().doc(jobId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...(snap.data() as TranslationJobDoc) };
}

export async function listUserTranslationJobs(
  uid: string,
  status?: TranslationJobStatus,
): Promise<(TranslationJobDoc & { id: string })[]> {
  // uid+status is pure equality on two fields — Firestore covers that with its
  // automatic single-field indexes (no composite index needed). uid+orderBy is
  // filter+sort on different fields, which DOES need a composite index; see
  // firestore.indexes.json (uid ASC, updatedAt DESC) for that one.
  const query = status
    ? jobsCollection().where("uid", "==", uid).where("status", "==", status).limit(20)
    : jobsCollection().where("uid", "==", uid).orderBy("updatedAt", "desc").limit(20);
  const snap = await query.get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as TranslationJobDoc) }));
}

export async function updateTranslationJob(
  jobId: string,
  patch: Partial<TranslationJobDoc>,
): Promise<void> {
  await jobsCollection()
    .doc(jobId)
    .update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
}

export async function appendJobLog(
  jobId: string,
  message: string,
  type = "info",
): Promise<void> {
  const entry: LogEntry = { timestamp: new Date().toISOString(), message, type };
  const ref = jobsCollection().doc(jobId);
  await ref.update({
    logs: FieldValue.arrayUnion(entry),
    updatedAt: FieldValue.serverTimestamp(),
  });
  // Trim occasionally rather than every write — arrayUnion can't cap length itself.
  const snap = await ref.get();
  const logs = (snap.data()?.logs as LogEntry[] | undefined) ?? [];
  if (logs.length > MAX_LOG_ENTRIES) {
    await ref.update({ logs: logs.slice(-MAX_LOG_ENTRIES) });
  }
}

/**
 * Claims the processing lease for a job inside a transaction so overlapping
 * triggers (self-chain + client nudge + daily cron all firing close together)
 * become safe no-ops instead of double-processing chunks. Returns false if
 * another tick already holds a valid lease or the job isn't running.
 */
export async function claimJobLease(jobId: string): Promise<boolean> {
  const db = getAdminDb();
  const ref = jobsCollection().doc(jobId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const data = snap.data() as TranslationJobDoc;
    if (data.status !== "running") return false;

    const now = Date.now();
    const leaseExpiresAt = data.leaseExpiresAt?.toMillis?.() ?? 0;
    if (leaseExpiresAt > now) return false;

    tx.update(ref, {
      leaseExpiresAt: Timestamp.fromMillis(now + LEASE_MS),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

export async function releaseJobLease(jobId: string): Promise<void> {
  await jobsCollection().doc(jobId).update({ leaseExpiresAt: Timestamp.fromMillis(0) });
}

export type WorkItem = { index: number; source: string };

/**
 * Two properly-filtered queries rather than one `status in [...]` query filtered
 * client-side: a chunk that permanently exhausted retries would otherwise be able
 * to occupy a `limit()` slot and starve out real pending work sitting further down
 * in the collection.
 *
 * The `status=="failed" AND retryCount<N` query is equality+range on two different
 * fields, which Firestore's automatic single-field indexes do NOT cover — it needs
 * the (status ASC, retryCount ASC) composite index declared in firestore.indexes.json.
 */
export async function getWorkBatch(jobId: string, limit: number): Promise<WorkItem[]> {
  const pendingSnap = await chunksCollection(jobId)
    .where("status", "==", "pending")
    .limit(limit)
    .get();
  const items: WorkItem[] = pendingSnap.docs.map((d) => ({
    index: Number(d.id),
    source: String(d.data().source ?? ""),
  }));

  if (items.length < limit) {
    const retrySnap = await chunksCollection(jobId)
      .where("status", "==", "failed")
      .where("retryCount", "<", MAX_CHUNK_RETRIES)
      .limit(limit - items.length)
      .get();
    retrySnap.docs.forEach((d) => {
      items.push({ index: Number(d.id), source: String(d.data().source ?? "") });
    });
  }

  return items;
}

export async function hasRemainingWork(jobId: string): Promise<boolean> {
  const pendingSnap = await chunksCollection(jobId)
    .where("status", "==", "pending")
    .limit(1)
    .get();
  if (!pendingSnap.empty) return true;

  const retrySnap = await chunksCollection(jobId)
    .where("status", "==", "failed")
    .where("retryCount", "<", MAX_CHUNK_RETRIES)
    .limit(1)
    .get();
  return !retrySnap.empty;
}

export async function writeChunkSuccess(
  jobId: string,
  index: number,
  translated: string,
  usage: { promptTokens: number; completionTokens: number; cost: number },
): Promise<void> {
  await chunksCollection(jobId).doc(String(index)).update({
    translated,
    status: "done" satisfies ChunkStatus,
    error: "",
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cost: usage.cost,
  });
}

export async function writeChunkFailure(
  jobId: string,
  index: number,
  errorMessage: string,
): Promise<void> {
  await chunksCollection(jobId)
    .doc(String(index))
    .update({
      status: "failed" satisfies ChunkStatus,
      error: errorMessage,
      retryCount: FieldValue.increment(1),
    });
}

/**
 * The permanentFailedAgg query below reuses the same (status ASC, retryCount ASC)
 * composite index as getWorkBatch — a range filter on retryCount works against an
 * ascending index regardless of whether the comparison is `<` or `>=`.
 *
 * The doneAgg query needs its own composite index — Firestore requires one
 * covering the equality filter *and* every summed field, not just the filter
 * field: (status ASC, completionTokens ASC, cost ASC, promptTokens ASC), see
 * firestore.indexes.json.
 */
export async function getJobProgress(jobId: string): Promise<JobProgress> {
  const collection = chunksCollection(jobId);
  const [doneAgg, permanentFailedAgg] = await Promise.all([
    collection
      .where("status", "==", "done")
      .aggregate({
        count: AggregateField.count(),
        promptTokens: AggregateField.sum("promptTokens"),
        completionTokens: AggregateField.sum("completionTokens"),
        cost: AggregateField.sum("cost"),
      })
      .get(),
    collection
      .where("status", "==", "failed")
      .where("retryCount", ">=", MAX_CHUNK_RETRIES)
      .aggregate({ count: AggregateField.count() })
      .get(),
  ]);

  const doneData = doneAgg.data();
  return {
    done: doneData.count,
    permanentlyFailed: permanentFailedAgg.data().count,
    promptTokens: doneData.promptTokens ?? 0,
    completionTokens: doneData.completionTokens ?? 0,
    cost: doneData.cost ?? 0,
  };
}

/** Assembles the full translated text in chunk order for finalization/export. */
export async function getOrderedChunkTexts(
  jobId: string,
  totalChunks: number,
): Promise<(string | null)[]> {
  const snap = await chunksCollection(jobId).get();
  const byIndex = new Map<number, { translated: string | null; status: ChunkStatus }>();
  snap.docs.forEach((d) => {
    const data = d.data();
    byIndex.set(Number(d.id), {
      translated: (data.translated as string | null) ?? null,
      status: data.status as ChunkStatus,
    });
  });

  return Array.from({ length: totalChunks }, (_, index) => {
    const entry = byIndex.get(index);
    if (!entry) return null;
    if (entry.status === "done") return entry.translated;
    if (entry.status === "failed") return `[LỖI DỊCH ĐOẠN ${index + 1}]`;
    return null;
  });
}

/**
 * Equality+range on two different fields — needs the (status ASC, leaseExpiresAt
 * ASC) composite index declared in firestore.indexes.json, same caveat as
 * getWorkBatch above.
 */
export async function listStaleRunningJobIds(): Promise<string[]> {
  const now = Timestamp.fromMillis(Date.now());
  const snap = await jobsCollection()
    .where("status", "==", "running")
    .where("leaseExpiresAt", "<", now)
    .get();
  return snap.docs.map((d) => d.id);
}
