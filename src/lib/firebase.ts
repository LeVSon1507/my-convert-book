import { FirebaseApp, getApps, initializeApp } from "firebase/app";
import {
  Auth,
  EmailAuthProvider,
  GoogleAuthProvider,
  User,
  createUserWithEmailAndPassword,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  reload,
  sendEmailVerification,
  sendPasswordResetEmail,
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  signInWithEmailAndPassword,
  signOut,
  updateEmail,
  updateProfile,
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
const TRANSLATION_SETTINGS_DOC = "translation_settings";
const ACCOUNT_PROFILE_DOC = "account_profile";
export const MAX_CUSTOM_MODELS_PER_PROVIDER = 30;

const CLOUD_SPEED_PRESET_VALUES = [
  "turbo",
  "balanced",
  "safe",
  "economy",
] as const;

type CloudExecutionMode = "background" | "direct";
type CloudSpeedPreset = (typeof CLOUD_SPEED_PRESET_VALUES)[number];

let app: FirebaseApp | null = null;
let authInstance: Auth | null = null;
let dbInstance: Firestore | null = null;

export function initFirebase(
  config: FirebaseConfig | null | undefined,
): boolean {
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

export type CloudAccountProfile = {
  email: string | null;
  emailVerified: boolean;
  fullName: string;
  username: string;
};

export type RegisterAccountParams = {
  email: string;
  password: string;
  fullName: string;
  username: string;
};

function normalizeAccountEmail(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizeAccountFullName(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeAccountUsername(value: string): string {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 32);
}

function normalizeEmailUsernameBase(email: string | null): string {
  const normalizedEmail = normalizeAccountEmail(email || "");
  const emailPrefix = normalizedEmail.split("@")[0] || "user";
  const usernameBase = normalizeAccountUsername(emailPrefix);
  if (usernameBase.length >= 3) {
    return usernameBase;
  }
  return `user_${usernameBase || "account"}`;
}

function createAuthCodeError(code: string): Error & { code: string } {
  const authError = new Error(code) as Error & { code: string };
  authError.code = code;
  return authError;
}

function accountProfileDoc(uid: string) {
  if (!dbInstance) throw new Error("Firestore chưa được khởi tạo.");
  return doc(dbInstance, "users", uid, "settings", ACCOUNT_PROFILE_DOC);
}

function isPermissionDeniedError(error: unknown): boolean {
  const errorCode = (error as { code?: string } | null)?.code;
  return (
    errorCode === "permission-denied" ||
    errorCode === "firestore/permission-denied"
  );
}

function validateNormalizedUsername(username: string): void {
  if (!username || !/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw createAuthCodeError("auth/invalid-username");
  }
}

function buildAccountProfileFallback(
  user: User | null,
  overrides?: Partial<CloudAccountProfile>,
): CloudAccountProfile {
  return {
    email: overrides?.email ?? user?.email ?? null,
    emailVerified: overrides?.emailVerified ?? Boolean(user?.emailVerified),
    fullName:
      overrides?.fullName ?? normalizeAccountFullName(user?.displayName || ""),
    username:
      overrides?.username ?? normalizeEmailUsernameBase(user?.email || null),
  };
}

async function upsertAccountProfileForUser(user: User): Promise<void> {
  const profileSnapshot = await getDoc(accountProfileDoc(user.uid));
  const profileData = profileSnapshot.exists() ? profileSnapshot.data() : {};
  const currentUsername = normalizeCloudString(
    (profileData as Record<string, unknown>).username,
  );
  const currentFullName = normalizeCloudString(
    (profileData as Record<string, unknown>).fullName,
  );

  const username = currentUsername || normalizeEmailUsernameBase(user.email);
  const fullName =
    currentFullName || normalizeAccountFullName(user.displayName || "");

  await setDoc(
    accountProfileDoc(user.uid),
    {
      email: normalizeAccountEmail(user.email || "") || null,
      emailVerified: Boolean(user.emailVerified),
      fullName,
      username,
      updatedAt: serverTimestamp(),
      createdAt: profileSnapshot.exists()
        ? profileData.createdAt
        : serverTimestamp(),
    },
    { merge: true },
  );
}

export function subscribeToAuthChanges(
  callback: (user: User | null) => void,
): () => void {
  if (!authInstance) return () => {};
  return onAuthStateChanged(authInstance, callback);
}

/** ID token for authenticating requests to server routes (e.g. /api/translate/jobs/*). */
export async function getCurrentIdToken(): Promise<string | null> {
  const user = authInstance?.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    return null;
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  if (!authInstance)
    throw new Error("Firebase chưa được khởi tạo. Tải lại trang và thử lại.");
  await signInWithEmailAndPassword(authInstance, email, password);
}

export async function signUp(params: RegisterAccountParams): Promise<void> {
  if (!authInstance)
    throw new Error("Firebase chưa được khởi tạo. Tải lại trang và thử lại.");

  const normalizedEmail = normalizeAccountEmail(params.email);
  const normalizedFullName = normalizeAccountFullName(params.fullName);
  const normalizedUsername = normalizeAccountUsername(params.username);
  validateNormalizedUsername(normalizedUsername);

  const credential = await createUserWithEmailAndPassword(
    authInstance,
    normalizedEmail,
    params.password,
  );

  if (normalizedFullName) {
    await updateProfile(credential.user, { displayName: normalizedFullName });
  }

  try {
    await setDoc(
      accountProfileDoc(credential.user.uid),
      {
        email: normalizedEmail,
        emailVerified: credential.user.emailVerified,
        fullName: normalizedFullName,
        username: normalizedUsername,
        updatedAt: serverTimestamp(),
        createdAt: serverTimestamp(),
      },
      { merge: true },
    );
  } catch (error) {
    if (!isPermissionDeniedError(error)) {
      throw error;
    }
  }

  await sendEmailVerification(credential.user);
}

export async function signInWithGoogleAccount(): Promise<void> {
  if (!authInstance)
    throw new Error("Firebase chưa được khởi tạo. Tải lại trang và thử lại.");

  const googleProvider = new GoogleAuthProvider();
  googleProvider.setCustomParameters({ prompt: "select_account" });

  const credential = await signInWithPopup(authInstance, googleProvider);
  try {
    await upsertAccountProfileForUser(credential.user);
  } catch (error) {
    if (!isPermissionDeniedError(error)) {
      throw error;
    }
  }
}

export async function signOutUser(): Promise<void> {
  if (!authInstance) return;
  await signOut(authInstance);
}

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  "auth/user-not-found": "Email không tồn tại.",
  "auth/wrong-password": "Mật khẩu không đúng.",
  "auth/invalid-credential": "Email hoặc mật khẩu không đúng.",
  "auth/invalid-login-credentials": "Email hoặc mật khẩu không đúng.",
  "auth/email-already-in-use": "Email đã được sử dụng.",
  "auth/invalid-email": "Email không hợp lệ.",
  "permission-denied":
    "Không đủ quyền truy cập Firestore. Kiểm tra lại Firestore Rules.",
  "firestore/permission-denied":
    "Không đủ quyền truy cập Firestore. Kiểm tra lại Firestore Rules.",
  "auth/popup-closed-by-user": "Bạn đã đóng cửa sổ đăng nhập Google.",
  "auth/cancelled-popup-request": "Yêu cầu đăng nhập Google đã bị hủy.",
  "auth/popup-blocked":
    "Trình duyệt chặn popup đăng nhập Google. Vui lòng cho phép popup.",
  "auth/weak-password": "Mật khẩu quá yếu.",
  "auth/requires-recent-login":
    "Vui lòng đăng nhập lại để thay đổi thông tin bảo mật.",
  "auth/too-many-requests": "Thử lại sau ít phút.",
  "auth/username-already-in-use": "Username đã tồn tại.",
  "auth/invalid-username": "Username không hợp lệ.",
  "auth/invalid-display-name": "Tên hiển thị không hợp lệ.",
  "auth/missing-password": "Vui lòng nhập mật khẩu hiện tại để xác thực.",
  "auth/unsupported-provider":
    "Nhà cung cấp đăng nhập hiện tại không hỗ trợ đổi email trực tiếp.",
  "auth/no-password-provider":
    "Email này đang dùng đăng nhập Google, không có mật khẩu để đặt lại.",
  "auth/password-reset-check-failed":
    "Không thể kiểm tra email lúc này. Vui lòng thử lại sau.",
};

export function firebaseAuthMessage(code: string): string {
  return AUTH_ERROR_MESSAGES[code] || `Lỗi: ${code}`;
}

async function verifyPasswordResetEmail(email: string): Promise<void> {
  const response = await fetch("/api/auth/password-reset/check", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
  });

  if (response.ok) {
    return;
  }

  let errorCode = "auth/password-reset-check-failed";
  try {
    const errorBody = (await response.json()) as { code?: unknown };
    if (typeof errorBody.code === "string" && errorBody.code.trim()) {
      errorCode = errorBody.code;
    }
  } catch {
    errorCode = "auth/password-reset-check-failed";
  }

  throw createAuthCodeError(errorCode);
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
  const nextList = [
    modelId,
    ...existingList.filter((item) => item !== modelId),
  ].slice(0, MAX_CUSTOM_MODELS_PER_PROVIDER);
  await setDoc(
    settingsDoc(uid, CUSTOM_MODELS_DOC),
    { [provider]: nextList, updatedAt: serverTimestamp() },
    { merge: true },
  );
  return nextList;
}

export async function saveApiKey(
  uid: string,
  provider: string,
  apiKey: string,
): Promise<void> {
  await setDoc(
    settingsDoc(uid, API_KEYS_DOC),
    { [provider]: apiKey, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

export async function loadApiKey(
  uid: string,
  provider: string,
): Promise<string> {
  const snap = await getDoc(settingsDoc(uid, API_KEYS_DOC));
  if (!snap.exists()) return "";
  return String(snap.data()?.[provider] ?? "");
}

export type ProviderPrompts = {
  systemPrompt: string;
  glossaryInput: string;
  plotDirection: string;
};

export type CloudProviderTranslationSettings = {
  modelSelectValue: string;
  customModelName: string;
  openrouterGroup: string;
  chunkSize: number;
  concurrentRequests: number;
  temperature: number;
  delayBetweenChunks: number;
  scopePercent: number;
  enableChapterSplit: boolean;
  enableAutoGlossary: boolean;
  selectedSkill: string | null;
  executionMode: CloudExecutionMode;
  activeSpeedPreset: CloudSpeedPreset | null;
};

export type CloudTranslationSettings = {
  preferredProvider: string | null;
  providers: Record<string, CloudProviderTranslationSettings>;
};

function clampNumber(
  value: unknown,
  minValue: number,
  maxValue: number,
  fallbackValue: number,
): number {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return fallbackValue;
  return Math.max(minValue, Math.min(maxValue, numericValue));
}

function normalizeCloudExecutionMode(value: unknown): CloudExecutionMode {
  return value === "direct" ? "direct" : "background";
}

function normalizeCloudSpeedPreset(value: unknown): CloudSpeedPreset | null {
  if (typeof value !== "string") return null;
  const speedPreset = CLOUD_SPEED_PRESET_VALUES.find(
    (presetValue) => presetValue === value,
  );
  return speedPreset ?? null;
}

function normalizeCloudSkillId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const skillId = value.trim();
  return skillId || null;
}

function normalizeCloudString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCloudProviderTranslationSettings(
  value: unknown,
): CloudProviderTranslationSettings | null {
  if (!value || typeof value !== "object") return null;

  const settings = value as Record<string, unknown>;
  const modelSelectValue = normalizeCloudString(settings.modelSelectValue);
  if (!modelSelectValue) return null;

  return {
    modelSelectValue,
    customModelName: normalizeCloudString(settings.customModelName),
    openrouterGroup: normalizeCloudString(settings.openrouterGroup),
    chunkSize: Math.round(clampNumber(settings.chunkSize, 500, 20000, 8000)),
    concurrentRequests: Math.round(
      clampNumber(settings.concurrentRequests, 1, 200, 12),
    ),
    temperature: clampNumber(settings.temperature, 0, 1, 0.25),
    delayBetweenChunks: Math.round(
      clampNumber(settings.delayBetweenChunks, 0, 10000, 0),
    ),
    scopePercent: Math.round(clampNumber(settings.scopePercent, 5, 100, 100)),
    enableChapterSplit: Boolean(settings.enableChapterSplit),
    enableAutoGlossary: Boolean(settings.enableAutoGlossary),
    selectedSkill: normalizeCloudSkillId(settings.selectedSkill),
    executionMode: normalizeCloudExecutionMode(settings.executionMode),
    activeSpeedPreset: normalizeCloudSpeedPreset(settings.activeSpeedPreset),
  };
}

function normalizeCloudProviderSettingsMap(
  value: unknown,
): Record<string, CloudProviderTranslationSettings> {
  if (!value || typeof value !== "object") return {};

  const providers = value as Record<string, unknown>;
  const normalizedProviders: Record<string, CloudProviderTranslationSettings> =
    {};
  Object.entries(providers).forEach(([providerKey, providerValue]) => {
    const normalizedSettings =
      normalizeCloudProviderTranslationSettings(providerValue);
    if (!normalizedSettings) return;
    normalizedProviders[providerKey] = normalizedSettings;
  });
  return normalizedProviders;
}

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

export async function saveTranslationSettings(
  uid: string,
  provider: string,
  settings: CloudProviderTranslationSettings,
): Promise<void> {
  const providerKey = String(provider || "").trim();
  if (!providerKey) return;

  await setDoc(
    settingsDoc(uid, TRANSLATION_SETTINGS_DOC),
    {
      preferredProvider: providerKey,
      providers: {
        [providerKey]: {
          ...settings,
          updatedAt: serverTimestamp(),
        },
      },
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function loadTranslationSettings(
  uid: string,
): Promise<CloudTranslationSettings | null> {
  const snap = await getDoc(settingsDoc(uid, TRANSLATION_SETTINGS_DOC));
  if (!snap.exists()) return null;

  const data = snap.data() ?? {};
  const providers = normalizeCloudProviderSettingsMap(
    (data as Record<string, unknown>).providers,
  );
  const preferredProviderRaw = (data as Record<string, unknown>)
    .preferredProvider;
  const preferredProvider =
    typeof preferredProviderRaw === "string" && preferredProviderRaw.trim()
      ? preferredProviderRaw.trim()
      : null;

  if (Object.keys(providers).length === 0 && !preferredProvider) {
    return null;
  }

  return {
    preferredProvider,
    providers,
  };
}

export async function loadAccountProfile(
  uid: string,
): Promise<CloudAccountProfile> {
  if (!authInstance) throw new Error("Firebase chưa được khởi tạo.");

  const currentUser = authInstance.currentUser;

  let profileSnapshot;
  try {
    profileSnapshot = await getDoc(accountProfileDoc(uid));
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      return buildAccountProfileFallback(currentUser);
    }
    throw error;
  }

  const profileData = profileSnapshot.exists() ? profileSnapshot.data() : {};
  const fullNameFallback =
    typeof currentUser?.displayName === "string" ? currentUser.displayName : "";
  const profileEmail =
    typeof currentUser?.email === "string"
      ? currentUser.email
      : normalizeCloudString((profileData as Record<string, unknown>).email) ||
        null;

  return {
    email: profileEmail,
    emailVerified: Boolean(currentUser?.emailVerified),
    fullName:
      normalizeCloudString((profileData as Record<string, unknown>).fullName) ||
      fullNameFallback,
    username: normalizeCloudString(
      (profileData as Record<string, unknown>).username,
    ),
  };
}

export async function saveAccountProfile(
  uid: string,
  fullName: string,
  username: string,
): Promise<CloudAccountProfile> {
  if (!authInstance) throw new Error("Firebase chưa được khởi tạo.");

  const currentUser = authInstance.currentUser;
  if (currentUser?.uid !== uid) {
    throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
  }

  const normalizedFullName = normalizeAccountFullName(fullName);
  const normalizedUsername = normalizeAccountUsername(username);

  if (normalizedFullName.length < 2) {
    throw createAuthCodeError("auth/invalid-display-name");
  }
  validateNormalizedUsername(normalizedUsername);
  await updateProfile(currentUser, { displayName: normalizedFullName });

  try {
    await setDoc(
      accountProfileDoc(uid),
      {
        email: currentUser.email,
        emailVerified: currentUser.emailVerified,
        fullName: normalizedFullName,
        username: normalizedUsername,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      return buildAccountProfileFallback(currentUser, {
        fullName: normalizedFullName,
        username: normalizedUsername,
      });
    }
    throw error;
  }

  return loadAccountProfile(uid);
}

export async function updateAccountEmail(
  uid: string,
  nextEmail: string,
  currentPassword: string,
): Promise<CloudAccountProfile> {
  if (!authInstance) throw new Error("Firebase chưa được khởi tạo.");

  const currentUser = authInstance.currentUser;
  if (currentUser?.uid !== uid) {
    throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.");
  }

  const currentEmail = normalizeAccountEmail(currentUser.email || "");
  const normalizedNextEmail = normalizeAccountEmail(nextEmail);
  const providerIds = new Set(
    currentUser.providerData
      .map((providerProfile) => providerProfile.providerId)
      .filter(Boolean),
  );
  const hasPasswordProvider = providerIds.has("password");
  const hasGoogleProvider = providerIds.has("google.com");

  if (hasPasswordProvider) {
    if (!currentEmail || !currentPassword.trim()) {
      throw createAuthCodeError("auth/missing-password");
    }

    const emailCredential = EmailAuthProvider.credential(
      currentEmail,
      currentPassword,
    );
    await reauthenticateWithCredential(currentUser, emailCredential);
  } else if (hasGoogleProvider) {
    const googleProvider = new GoogleAuthProvider();
    googleProvider.setCustomParameters({ prompt: "select_account" });
    await reauthenticateWithPopup(currentUser, googleProvider);
  } else {
    throw createAuthCodeError("auth/unsupported-provider");
  }

  await updateEmail(currentUser, normalizedNextEmail);
  await sendEmailVerification(currentUser);

  try {
    await setDoc(
      accountProfileDoc(uid),
      {
        email: normalizedNextEmail,
        emailVerified: false,
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      return buildAccountProfileFallback(currentUser, {
        email: normalizedNextEmail,
        emailVerified: false,
      });
    }
    throw error;
  }

  return loadAccountProfile(uid);
}

export async function sendVerificationEmailToCurrentUser(): Promise<void> {
  if (!authInstance) throw new Error("Firebase chưa được khởi tạo.");
  const currentUser = authInstance.currentUser;
  if (!currentUser)
    throw new Error("Bạn cần đăng nhập để thực hiện thao tác này.");
  await sendEmailVerification(currentUser);
}

export async function sendPasswordResetForEmail(email: string): Promise<void> {
  if (!authInstance) throw new Error("Firebase chưa được khởi tạo.");
  const normalizedEmail = normalizeAccountEmail(email);
  if (!normalizedEmail) throw createAuthCodeError("auth/invalid-email");
  await verifyPasswordResetEmail(normalizedEmail);
  await sendPasswordResetEmail(authInstance, normalizedEmail);
}

export async function refreshCurrentUserSession(): Promise<User | null> {
  const currentUser = authInstance?.currentUser;
  if (!currentUser) return null;
  await reload(currentUser);
  return authInstance?.currentUser ?? null;
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
      setDoc(
        doc(
          dbInstance!,
          "users",
          uid,
          "translations",
          docId,
          subcollection,
          String(idx),
        ),
        {
          text: chunk,
        },
      ),
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
      getDoc(
        doc(
          dbInstance!,
          "users",
          uid,
          "translations",
          docId,
          subcollection,
          String(i),
        ),
      ),
    ),
  );
  return snaps
    .map((snap) => (snap.exists() ? String(snap.data()?.text ?? "") : ""))
    .join("");
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
  const parts = [
    fileHash || "nofile",
    provider || "na",
    model || "na",
    chunkSize || 0,
    scopePercent || 100,
  ];
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
  const {
    fileHash,
    provider,
    model,
    chunkSize,
    scopePercent,
    translatedChunks,
  } = options;
  if (!fileHash || !options.totalChunks) return;

  const docId = buildProgressDocId(
    fileHash,
    provider,
    model,
    chunkSize,
    scopePercent,
  );
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
    writeLargeTextSubcollection(
      uid,
      docId,
      "checkpoint_chunks",
      checkpointPayload,
    ),
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
  const docId = buildProgressDocId(
    fileHash,
    provider,
    model,
    chunkSize,
    scopePercent,
  );
  const snap = await getDoc(translationDoc(uid, docId));
  if (!snap.exists()) return null;

  const data = snap.data() ?? {};
  const completedChunks = Number(data.completedChunks) || 0;
  const totalChunks = Number(data.totalChunks) || 0;
  if (!completedChunks || completedChunks >= totalChunks) return null;

  return {
    id: docId,
    ...data,
    completedChunks,
    totalChunks,
  } as ResumeCandidate;
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
  const raw = await readLargeTextSubcollection(
    uid,
    docId,
    "checkpoint_chunks",
    checkpointChunkCount,
  );
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
  return snap.docs.map(
    (d) => ({ id: d.id, ...d.data() }) as TranslationHistoryEntry,
  );
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
      deleteDoc(
        doc(dbInstance!, "users", uid, "translations", id, "chunks", String(i)),
      ),
    ),
    ...Array.from({ length: checkpointChunkCount || 0 }, (_, i) =>
      deleteDoc(
        doc(
          dbInstance!,
          "users",
          uid,
          "translations",
          id,
          "checkpoint_chunks",
          String(i),
        ),
      ),
    ),
  ];
  await Promise.all(deletions);
  await deleteDoc(translationDoc(uid, id));
}
