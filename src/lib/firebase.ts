import { FirebaseApp, getApps, initializeApp } from "firebase/app";
import {
  Auth,
  User,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import {
  Firestore,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
} from "firebase/firestore";

/**
 * Firestore data layer ported from public/scripts/cloud.js. Collection/doc paths and
 * field names are kept identical so existing users' data (API keys, prompts, saved
 * translations, in-progress checkpoints) keeps working after the Next.js cutover.
 */

export type FirebaseConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  messagingSenderId: string;
  appId: string;
};

const FIRESTORE_CHUNK_SIZE = 600000;
const CLOUD_PROGRESS_PREFIX = "progress_";
const CUSTOM_MODELS_DOC = "custom_models";
const PROMPTS_DOC = "prompts";
const API_KEYS_DOC = "api_keys";
export const MAX_CUSTOM_MODELS_PER_PROVIDER = 30;

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

export function initFirebase(config: FirebaseConfig | null | undefined): boolean {
  if (!config?.apiKey) return false;
  app = getApps().length ? getApps()[0] : initializeApp(config);
  authInstance = getAuth(app);
  dbInstance = getFirestore(app);
  return true;
}

export function getAuthInstance(): Auth | null {
  return authInstance;
}

export function getDb(): Firestore | null {
  return dbInstance;
}

export function subscribeToAuthChanges(callback: (user: User | null) => void): () => void {
  if (!authInstance) return () => {};
  return onAuthStateChanged(authInstance, callback);
}

export async function signIn(email: string, password: string): Promise<void> {
  if (!authInstance) throw new Error("Firebase chưa được khởi tạo. Tải lại trang và thử lại.");
  await signInWithEmailAndPassword(authInstance, email, password);
}

export async function signUp(email: string, password: string): Promise<void> {
  if (!authInstance) throw new Error("Firebase chưa được khởi tạo. Tải lại trang và thử lại.");
  await createUserWithEmailAndPassword(authInstance, email, password);
}

export async function signOutUser(): Promise<void> {
  if (!authInstance) return;
  await signOut(authInstance);
}

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  "auth/user-not-found": "Email không tồn tại.",
  "auth/wrong-password": "Mật khẩu không đúng.",
  "auth/invalid-credential": "Email hoặc mật khẩu không đúng.",
  "auth/email-already-in-use": "Email đã được sử dụng.",
  "auth/invalid-email": "Email không hợp lệ.",
  "auth/weak-password": "Mật khẩu quá yếu.",
  "auth/too-many-requests": "Thử lại sau ít phút.",
};

export function firebaseAuthMessage(code: string): string {
  return AUTH_ERROR_MESSAGES[code] || `Lỗi: ${code}`;
}

function settingsDoc(uid: string, docId: string) {
  if (!dbInstance) throw new Error("Firestore chưa được khởi tạo.");
  return doc(dbInstance, "users", uid, "settings", docId);
}

function translationDoc(uid: string, docId?: string) {
  if (!dbInstance) throw new Error("Firestore chưa được khởi tạo.");
  return docId
    ? doc(dbInstance, "users", uid, "translations", docId)
    : doc(collection(dbInstance, "users", uid, "translations"));
}

export function normalizeCustomModelList(values: unknown): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  (Array.isArray(values) ? values : []).forEach((item) => {
    const modelId = String(item ?? "").trim();
    if (!modelId || modelId === "__custom__" || seen.has(modelId)) return;
    seen.add(modelId);
    normalized.push(modelId);
  });
  return normalized.slice(0, MAX_CUSTOM_MODELS_PER_PROVIDER);
}

export async function loadAccountCustomModels(
  uid: string,
): Promise<Record<string, string[]>> {
  const snap = await getDoc(settingsDoc(uid, CUSTOM_MODELS_DOC));
  if (!snap.exists()) return {};

  const data = snap.data() ?? {};
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "updatedAt") continue;
    const values = normalizeCustomModelList(value);
    if (values.length > 0) result[key] = values;
  }
  return result;
}

export async function rememberCustomModelForAccount(
  uid: string,
  provider: string,
  modelId: string,
  existingList: string[],
): Promise<string[]> {
  const nextList = [modelId, ...existingList.filter((item) => item !== modelId)].slice(
    0,
    MAX_CUSTOM_MODELS_PER_PROVIDER,
  );
  await setDoc(
    settingsDoc(uid, CUSTOM_MODELS_DOC),
    { [provider]: nextList, updatedAt: serverTimestamp() },
    { merge: true },
  );
  return nextList;
}

export async function saveApiKey(uid: string, provider: string, apiKey: string): Promise<void> {
  await setDoc(
    settingsDoc(uid, API_KEYS_DOC),
    { [provider]: apiKey, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

export async function loadApiKey(uid: string, provider: string): Promise<string> {
  const snap = await getDoc(settingsDoc(uid, API_KEYS_DOC));
  if (!snap.exists()) return "";
  return String(snap.data()?.[provider] ?? "");
}

export type ProviderPrompts = {
  systemPrompt: string;
  glossaryInput: string;
  plotDirection: string;
};

export async function savePrompts(
  uid: string,
  provider: string,
  prompts: ProviderPrompts,
): Promise<void> {
  await setDoc(
    settingsDoc(uid, PROMPTS_DOC),
    {
      [provider]: {
        systemPrompt: prompts.systemPrompt.trim(),
        glossaryInput: prompts.glossaryInput.trim(),
        plotDirection: prompts.plotDirection.trim(),
        updatedAt: serverTimestamp(),
      },
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function loadPrompts(
  uid: string,
  provider: string,
): Promise<ProviderPrompts | null> {
  const snap = await getDoc(settingsDoc(uid, PROMPTS_DOC));
  if (!snap.exists()) return null;
  const providerPrompts = snap.data()?.[provider];
  if (!providerPrompts || typeof providerPrompts !== "object") return null;
  return {
    systemPrompt: String(providerPrompts.systemPrompt ?? ""),
    glossaryInput: String(providerPrompts.glossaryInput ?? ""),
    plotDirection: String(providerPrompts.plotDirection ?? ""),
  };
}

function splitIntoFirestoreChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += FIRESTORE_CHUNK_SIZE) {
    chunks.push(text.slice(i, i + FIRESTORE_CHUNK_SIZE));
  }
  return chunks.length ? chunks : [""];
}

async function writeLargeTextSubcollection(
  uid: string,
  docId: string,
  subcollection: string,
  text: string,
): Promise<number> {
  if (!dbInstance) throw new Error("Firestore chưa được khởi tạo.");
  const chunks = splitIntoFirestoreChunks(text);
  await Promise.all(
    chunks.map((chunk, idx) =>
      setDoc(doc(dbInstance!, "users", uid, "translations", docId, subcollection, String(idx)), {
        text: chunk,
      }),
    ),
  );
  return chunks.length;
}

async function readLargeTextSubcollection(
  uid: string,
  docId: string,
  subcollection: string,
  chunkCount: number,
): Promise<string> {
  if (!dbInstance) throw new Error("Firestore chưa được khởi tạo.");
  const safeCount = Math.max(0, Number(chunkCount) || 0);
  if (safeCount === 0) return "";
  const snaps = await Promise.all(
    Array.from({ length: safeCount }, (_, i) =>
      getDoc(doc(dbInstance!, "users", uid, "translations", docId, subcollection, String(i))),
    ),
  );
  return snaps.map((snap) => (snap.exists() ? String(snap.data()?.text ?? "") : "")).join("");
}

export type SaveTranslationParams = {
  fileName: string;
  model: string;
  provider: string;
  totalChunks: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
};

export async function saveTranslation(
  uid: string,
  translatedText: string,
  params: SaveTranslationParams,
): Promise<string> {
  const docRef = translationDoc(uid);
  const textChunkCount = await writeLargeTextSubcollection(
    uid,
    docRef.id,
    "chunks",
    translatedText,
  );

  await setDoc(docRef, {
    fileName: params.fileName || "unknown.txt",
    completedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    charCount: translatedText.length,
    model: params.model,
    provider: params.provider,
    totalChunks: params.totalChunks,
    completedChunks: params.totalChunks,
    status: "completed",
    textChunkCount,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    cost: params.cost,
  });

  return docRef.id;
}

function sanitizeDocId(value: string): string {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 180);
}

export function buildProgressDocId(
  fileHash: string,
  provider: string,
  model: string,
  chunkSize: number,
  scopePercent: number,
): string {
  const parts = [fileHash || "nofile", provider || "na", model || "na", chunkSize || 0, scopePercent || 100];
  return CLOUD_PROGRESS_PREFIX + sanitizeDocId(parts.join("_"));
}

export type SaveTranslationProgressOptions = {
  fileHash: string;
  fileName?: string;
  provider: string;
  model: string;
  chunkSize: number;
  scopePercent: number;
  totalChunks: number;
  translatedChunks: (string | null)[];
  status?: "in_progress" | "completed";
};

export async function saveTranslationProgress(
  uid: string,
  options: SaveTranslationProgressOptions,
): Promise<void> {
  const { fileHash, provider, model, chunkSize, scopePercent, translatedChunks } = options;
  if (!fileHash || !options.totalChunks) return;

  const docId = buildProgressDocId(fileHash, provider, model, chunkSize, scopePercent);
  const doneCount = translatedChunks.filter(Boolean).length;
  const partialText = translatedChunks.filter(Boolean).join("\n\n");
  const checkpointPayload = JSON.stringify({
    translatedChunks,
    totalChunks: options.totalChunks,
    fileName: options.fileName || "unknown.txt",
    fileHash,
  });
  const status = options.status ?? "in_progress";

  const [textChunkCount, checkpointChunkCount] = await Promise.all([
    writeLargeTextSubcollection(uid, docId, "chunks", partialText),
    writeLargeTextSubcollection(uid, docId, "checkpoint_chunks", checkpointPayload),
  ]);

  await setDoc(
    translationDoc(uid, docId),
    {
      fileName: options.fileName || "unknown.txt",
      fileHash,
      provider,
      model,
      chunkSize,
      scopePercent,
      totalChunks: options.totalChunks,
      completedChunks: doneCount,
      status,
      charCount: partialText.length,
      textChunkCount,
      checkpointChunkCount,
      updatedAt: serverTimestamp(),
      completedAt: status === "completed" ? serverTimestamp() : null,
    },
    { merge: true },
  );
}

export type ResumeCandidate = {
  id: string;
  completedChunks: number;
  totalChunks: number;
  checkpointChunkCount: number;
  [key: string]: unknown;
};

export async function findResumeCandidate(
  uid: string,
  fileHash: string,
  provider: string,
  model: string,
  chunkSize: number,
  scopePercent: number,
): Promise<ResumeCandidate | null> {
  const docId = buildProgressDocId(fileHash, provider, model, chunkSize, scopePercent);
  const snap = await getDoc(translationDoc(uid, docId));
  if (!snap.exists()) return null;

  const data = snap.data() ?? {};
  const completedChunks = Number(data.completedChunks) || 0;
  const totalChunks = Number(data.totalChunks) || 0;
  if (!completedChunks || completedChunks >= totalChunks) return null;

  return { id: docId, ...data, completedChunks, totalChunks } as ResumeCandidate;
}

export type ResumeCheckpoint = {
  translatedChunks: (string | null)[];
  totalChunks: number;
  fileName?: string;
  fileHash?: string;
};

export async function loadResumeCheckpoint(
  uid: string,
  docId: string,
  checkpointChunkCount: number,
): Promise<ResumeCheckpoint | null> {
  const raw = await readLargeTextSubcollection(uid, docId, "checkpoint_chunks", checkpointChunkCount);
  if (!raw) return null;

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed?.translatedChunks)) return null;
  return {
    translatedChunks: parsed.translatedChunks,
    totalChunks: Number(parsed.totalChunks) || parsed.translatedChunks.length,
    fileName: typeof parsed.fileName === "string" ? parsed.fileName : undefined,
    fileHash: typeof parsed.fileHash === "string" ? parsed.fileHash : undefined,
  };
}

export type TranslationHistoryEntry = {
  id: string;
  fileName?: string;
  status?: string;
  totalChunks?: number;
  completedChunks?: number;
  textChunkCount?: number;
  checkpointChunkCount?: number;
  [key: string]: unknown;
};

export async function loadCloudHistory(
  uid: string,
  max = 50,
): Promise<TranslationHistoryEntry[]> {
  if (!dbInstance) throw new Error("Firestore chưa được khởi tạo.");
  const snap = await getDocs(
    query(
      collection(dbInstance, "users", uid, "translations"),
      orderBy("updatedAt", "desc"),
      limit(max),
    ),
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as TranslationHistoryEntry);
}

export async function downloadCloudFileText(
  uid: string,
  id: string,
  chunkCount: number,
): Promise<string> {
  return readLargeTextSubcollection(uid, id, "chunks", chunkCount || 1);
}

export async function deleteCloudFile(
  uid: string,
  id: string,
  chunkCount: number,
  checkpointChunkCount: number,
): Promise<void> {
  if (!dbInstance) throw new Error("Firestore chưa được khởi tạo.");
  const deletions = [
    ...Array.from({ length: chunkCount || 0 }, (_, i) =>
      deleteDoc(doc(dbInstance!, "users", uid, "translations", id, "chunks", String(i))),
    ),
    ...Array.from({ length: checkpointChunkCount || 0 }, (_, i) =>
      deleteDoc(doc(dbInstance!, "users", uid, "translations", id, "checkpoint_chunks", String(i))),
    ),
  ];
  await Promise.all(deletions);
  await deleteDoc(translationDoc(uid, id));
}
