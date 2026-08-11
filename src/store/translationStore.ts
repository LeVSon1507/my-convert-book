import { create } from "zustand";
import { requestChatCompletions } from "@/lib/chatApi";
import { getCachedTranslation, setCacheTranslation } from "@/lib/cache";
import { buildTranslationPrompt, type SkillId } from "@/lib/skills";
import { buildGlossaryInstruction, parseGlossaryInput } from "@/lib/glossary";
import { extractAutoGlossary } from "@/lib/hanvietDict";
import {
  ChapterMapEntry,
  splitIntoChapterChunks,
  splitIntoChunks,
} from "@/lib/chunking";
import {
  applyTranslationScope,
  costFromTokens,
  estimateTokenCount,
  estimateTokenCountForText,
} from "@/lib/cost";
import { exportAs, ExportFormat } from "@/lib/export";
import {
  getCurrentIdToken,
  saveTranslation,
  saveTranslationProgress,
} from "@/lib/firebase";
import {
  PROVIDER_CONFIGS,
  OPENROUTER_MODEL_GROUPS,
  ProviderId,
  getOllamaEffectiveConcurrency,
  hashContent,
  shouldSkipTranslation,
} from "@/lib/providers";
import {
  buildFinalTextFromChunks,
  buildTranslationUserPrompt,
} from "@/lib/quality";
import {
  sleep,
  translateChunkWithRetry,
  type EngineParams,
  type UsageDelta,
} from "@/lib/translationEngine";
import type { RuntimeConfig } from "@/lib/runtimeConfig";
import { useAuthStore } from "@/store/authStore";

export type SpeedPresetId = "turbo" | "balanced" | "safe" | "economy";
export type TranslationExecutionMode = "background" | "direct";

export const SPEED_PRESETS: Record<
  SpeedPresetId,
  { concurrent: number; delay: number; chunkSize: number; temperature: number }
> = {
  turbo: { concurrent: 30, delay: 0, chunkSize: 12000, temperature: 0.2 },
  balanced: { concurrent: 12, delay: 50, chunkSize: 8000, temperature: 0.25 },
  safe: { concurrent: 4, delay: 600, chunkSize: 5000, temperature: 0.2 },
  economy: { concurrent: 2, delay: 1200, chunkSize: 6000, temperature: 0.2 },
};

const FAILED_MARKER = "[LỖI DỊCH ĐOẠN";
const TRANSLATION_HISTORY_KEY = "translation_history_v1";
const TRANSLATION_CHECKPOINT_PREFIX = "translation_checkpoint_v1:";
const COMPLETED_TRANSLATION_PREFIX = "translation_completed_v1:";
const EXECUTION_MODE_STORAGE_KEY = "translation_execution_mode_v1";
const ACTIVE_BACKEND_JOB_STORAGE_KEY = "translation_active_backend_job_v1";

export type LogEntry = { timestamp: string; message: string; type: string };

export type UsageStats = {
  promptTokens: number;
  completionTokens: number;
  totalCost: number;
};

type LocalHistoryRecord = {
  historyId: string;
  checkpointKey?: string;
  completedTextKey?: string;
  fileHash: string;
  fileName: string;
  provider: ProviderId;
  model: string;
  chunkSize: number;
  scopePercent: number;
  totalChunks: number;
  completedChunks: number;
  status: "in_progress" | "completed";
  completedAt: number;
  updatedAt: number;
};

export type TranslationResumeCheckpoint = {
  translatedChunks: (string | null)[];
  totalChunks: number;
  fileName?: string;
  fileHash?: string;
};

export type TranslationCostPreview = {
  totalChunks: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
};

function isTranslatedChunk(value: string | null): value is string {
  return Boolean(value);
}

function isTranslationExecutionMode(
  value: unknown,
): value is TranslationExecutionMode {
  return value === "background" || value === "direct";
}

function readPersistedExecutionMode(): TranslationExecutionMode | null {
  if (globalThis.window === undefined) return null;
  try {
    const raw = localStorage.getItem(EXECUTION_MODE_STORAGE_KEY);
    return isTranslationExecutionMode(raw) ? raw : null;
  } catch {
    return null;
  }
}

function persistExecutionMode(mode: TranslationExecutionMode): void {
  if (globalThis.window === undefined) return;
  try {
    localStorage.setItem(EXECUTION_MODE_STORAGE_KEY, mode);
  } catch {
    // Persistence is best-effort in restricted/private browser contexts.
  }
}

function readPersistedActiveBackendJobId(): string | null {
  if (globalThis.window === undefined) return null;
  try {
    const rawValue = localStorage.getItem(ACTIVE_BACKEND_JOB_STORAGE_KEY);
    return rawValue?.trim() ? rawValue : null;
  } catch {
    return null;
  }
}

function persistActiveBackendJobId(jobId: string | null): void {
  if (globalThis.window === undefined) return;
  try {
    if (!jobId) {
      localStorage.removeItem(ACTIVE_BACKEND_JOB_STORAGE_KEY);
      return;
    }
    localStorage.setItem(ACTIVE_BACKEND_JOB_STORAGE_KEY, jobId);
  } catch {
    // Persistence is best-effort in restricted/private browser contexts.
  }
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && value in PROVIDER_CONFIGS;
}

function normalizeRuntimeApiKeys(
  keys: RuntimeConfig["keys"],
): Partial<Record<ProviderId, string>> {
  const normalized: Partial<Record<ProviderId, string>> = {};
  if (!keys) return normalized;

  Object.entries(keys).forEach(([provider, key]) => {
    if (!isProviderId(provider) || typeof key !== "string" || !key.trim())
      return;
    normalized[provider] = key.trim();
  });

  return normalized;
}

function modelPatchForProvider(
  provider: ProviderId,
  modelId: string,
): Pick<Partial<TranslationState>, "modelSelectValue" | "customModelName"> {
  const model = modelId.trim();
  if (!model) return {};

  const providerModels =
    provider === "openrouter"
      ? Object.values(OPENROUTER_MODEL_GROUPS).flatMap((group) => group.models)
      : PROVIDER_CONFIGS[provider].models;
  const isKnownModel = providerModels.some((option) => option.id === model);

  return isKnownModel
    ? { modelSelectValue: model, customModelName: "" }
    : { modelSelectValue: "__custom__", customModelName: model };
}

function findOpenRouterGroupForModel(modelId: string): string | null {
  if (!modelId || modelId === "__custom__") return null;

  const matchingGroupEntry = Object.entries(OPENROUTER_MODEL_GROUPS).find(
    ([, group]) =>
      group.models.some((modelOption) => modelOption.id === modelId),
  );
  return matchingGroupEntry ? matchingGroupEntry[0] : null;
}

function getTranslationHistoryId(
  fileHash: string,
  provider: ProviderId,
  model: string,
  chunkSize: number,
  scopePercent: number,
): string {
  if (!fileHash || !provider || !model || !chunkSize) return "";
  return `${fileHash}:${provider}:${model}:${chunkSize}:${scopePercent || 100}`;
}

function getTranslationCheckpointKey(
  fileHash: string,
  provider: ProviderId,
  model: string,
  chunkSize: number,
  scopePercent: number,
): string {
  if (!fileHash || !provider || !model || !chunkSize) return "";
  return `${TRANSLATION_CHECKPOINT_PREFIX}${fileHash}:${provider}:${model}:${chunkSize}:${scopePercent || 100}`;
}

function pushLocalHistory(record: LocalHistoryRecord): void {
  if (globalThis.window === undefined) return;
  try {
    const parsed = JSON.parse(
      localStorage.getItem(TRANSLATION_HISTORY_KEY) || "[]",
    );
    const list = Array.isArray(parsed) ? (parsed as unknown[]) : [];
    const existingIndex = list.findIndex((item) => {
      if (!item || typeof item !== "object") return false;
      return (item as { historyId?: unknown }).historyId === record.historyId;
    });
    if (existingIndex >= 0) list.splice(existingIndex, 1);
    localStorage.setItem(
      TRANSLATION_HISTORY_KEY,
      JSON.stringify([record, ...list].slice(0, 40)),
    );
  } catch {
    // Local history is a best-effort browser cache.
  }
}

function saveCompletedTranslationLocal(
  state: TranslationState,
  model: string,
  text: string,
): void {
  if (globalThis.window === undefined || !state.currentFileHash) return;
  try {
    const historyId = getTranslationHistoryId(
      state.currentFileHash,
      state.provider,
      model,
      state.chunkSize,
      state.scopePercent,
    );
    if (!historyId) return;
    const completedTextKey = `${COMPLETED_TRANSLATION_PREFIX}${historyId}`;
    const checkpointKey = getTranslationCheckpointKey(
      state.currentFileHash,
      state.provider,
      model,
      state.chunkSize,
      state.scopePercent,
    );
    if (checkpointKey) localStorage.removeItem(checkpointKey);
    localStorage.setItem(completedTextKey, text);
    const now = Date.now();
    pushLocalHistory({
      historyId,
      completedTextKey,
      fileHash: state.currentFileHash,
      fileName: state.fileName || "unknown.txt",
      provider: state.provider,
      model,
      chunkSize: state.chunkSize,
      scopePercent: state.scopePercent,
      totalChunks: state.totalChunks,
      completedChunks: state.translatedChunks.filter(isTranslatedChunk).length,
      status: "completed",
      completedAt: now,
      updatedAt: now,
    });
  } catch {
    // Ignore localStorage quota or private browsing failures.
  }
}

function saveTranslationCheckpointLocal(
  state: TranslationState,
  model: string,
): void {
  if (
    globalThis.window === undefined ||
    !state.currentFileHash ||
    !state.totalChunks
  )
    return;
  try {
    const checkpointKey = getTranslationCheckpointKey(
      state.currentFileHash,
      state.provider,
      model,
      state.chunkSize,
      state.scopePercent,
    );
    const historyId = getTranslationHistoryId(
      state.currentFileHash,
      state.provider,
      model,
      state.chunkSize,
      state.scopePercent,
    );
    if (!checkpointKey || !historyId) return;

    const translatedChunks = state.translatedChunks.slice();
    const doneCount = translatedChunks.filter(isTranslatedChunk).length;
    localStorage.setItem(
      checkpointKey,
      JSON.stringify({
        __v: 2,
        translatedChunks,
        totalChunks: state.totalChunks,
        chapterMap: state.chapterMap,
        updatedAt: Date.now(),
        fileName: state.fileName,
        fileHash: state.currentFileHash,
      }),
    );
    const now = Date.now();
    pushLocalHistory({
      historyId,
      checkpointKey,
      fileHash: state.currentFileHash,
      fileName: state.fileName || "unknown.txt",
      provider: state.provider,
      model,
      chunkSize: state.chunkSize,
      scopePercent: state.scopePercent,
      totalChunks: state.totalChunks,
      completedChunks: doneCount,
      status: "in_progress",
      completedAt: now,
      updatedAt: now,
    });
  } catch {
    // Local checkpointing is best-effort and must not interrupt translation.
  }
}

function saveTranslationCheckpointCloud(
  state: TranslationState,
  model: string,
): void {
  const user = useAuthStore.getState().user;
  if (!user || !state.currentFileHash || !state.totalChunks) return;

  void saveTranslationProgress(user.uid, {
    fileHash: state.currentFileHash,
    fileName: state.fileName || "unknown.txt",
    provider: state.provider,
    model,
    chunkSize: state.chunkSize,
    scopePercent: state.scopePercent,
    totalChunks: state.totalChunks,
    translatedChunks: state.translatedChunks,
    status: "in_progress",
  }).then(() => {
    void useAuthStore.getState().refreshCloudHistory();
  });
}

function persistTranslationCheckpoint(
  state: TranslationState,
  model: string,
): void {
  saveTranslationCheckpointLocal(state, model);
  saveTranslationCheckpointCloud(state, model);
}

type TranslationState = {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  runtimeApiKeys: Partial<Record<ProviderId, string>>;
  modelSelectValue: string;
  customModelName: string;
  openrouterGroup: string;

  fileName: string;
  fileContent: string;
  fileSizeBytes: number;
  currentFileHash: string;

  chunkSize: number;
  concurrentRequests: number;
  temperature: number;
  delayBetweenChunks: number;
  scopePercent: number;
  enableChapterSplit: boolean;
  enableAutoGlossary: boolean;
  glossaryInput: string;
  selectedSkill: SkillId | null;
  executionMode: TranslationExecutionMode;
  systemPrompt: string;
  activeSpeedPreset: SpeedPresetId | null;

  isRunning: boolean;
  isStopped: boolean;
  totalChunks: number;
  completedChunks: number;
  translatedChunks: (string | null)[];
  chapterMap: ChapterMapEntry[];
  startTime: number | null;
  cacheHits: number;
  cacheMisses: number;
  usageStats: UsageStats;
  logs: LogEntry[];
  error: string;
  resultText: string;
  resultVisible: boolean;
  progressVisible: boolean;
  pendingResumeCheckpoint: TranslationResumeCheckpoint | null;
  /** Non-null while a backend translation job (see src/app/api/translate/jobs) is
   *  running for a signed-in user — translation keeps going server-side even if
   *  this tab closes. Null means the legacy fully-client-side pipeline below owns
   *  the run instead (Ollama, or no signed-in user). */
  activeJobId: string | null;

  setProvider: (provider: ProviderId) => void;
  setModelSelectValue: (value: string) => void;
  setCustomModelName: (value: string) => void;
  setApiKey: (value: string) => void;
  setBaseUrl: (value: string) => void;
  setOpenrouterGroup: (value: string) => void;
  updateSettings: (partial: Partial<TranslationState>) => void;
  applyRuntimeConfig: (config: RuntimeConfig) => void;
  getSelectedModel: () => string;

  loadFile: (file: File) => Promise<void>;
  applySpeedPreset: (preset: SpeedPresetId) => void;
  estimateCostPreview: () => TranslationCostPreview | null;

  startTranslation: () => Promise<void>;
  stopTranslation: () => Promise<void>;
  resumeFromCheckpoint: (checkpoint: TranslationResumeCheckpoint) => void;
  ignoreResumeCheckpoint: () => void;
  selectSkill: (skillId: SkillId | null) => void;
  downloadResult: (format: ExportFormat) => Promise<void>;
  downloadPartial: (format: ExportFormat) => Promise<void>;
  /** Reattaches to a still-running backend job after sign-in or a page reload —
   *  this is what makes "tắt màn hình vẫn dịch tiếp được" visible to the user. */
  resumeActiveBackendJob: () => Promise<void>;
  /** Same reattachment as resumeActiveBackendJob, but for a specific job id —
   *  used by HistoryWorkspace's "Đang chạy trên server" list so a job started
   *  earlier is reachable even if the auto-reconnect-on-mount didn't fire
   *  (wrong tab on reload, multiple running jobs, etc). */
  attachToBackendJob: (jobId: string) => Promise<void>;
};

type TranslationGetter = () => TranslationState;
type TranslationSetter = (p: Partial<TranslationState>) => void;

function addLogEntry(
  get: TranslationGetter,
  set: TranslationSetter,
  message: string,
  type = "info",
) {
  const timestamp = new Date().toLocaleTimeString("vi-VN");
  set({ logs: [...get().logs, { timestamp, message, type }] });
}

type StartTranslationConfig = {
  provider: ProviderId;
  modelName: string;
  baseUrl: string;
  apiKey: string;
};

type PreparedTranslationRun = {
  chunks: string[];
  chapterMap: ChapterMapEntry[];
  glossaryInstruction: string;
  initialResults: (string | null)[];
};

function isValidBaseUrl(baseUrl: string): boolean {
  try {
    const parsedUrl = new URL(baseUrl);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
}

function isKnownModelSelection(state: TranslationState): boolean {
  const modelSelectValue = state.modelSelectValue;
  if (!modelSelectValue || modelSelectValue === "__custom__") return true;

  if (state.provider === "openrouter") {
    const openRouterModels =
      OPENROUTER_MODEL_GROUPS[state.openrouterGroup]?.models ?? [];
    return openRouterModels.some(
      (modelOption) => modelOption.id === modelSelectValue,
    );
  }

  return PROVIDER_CONFIGS[state.provider].models.some(
    (modelOption) => modelOption.id === modelSelectValue,
  );
}

function getStartTranslationConfig(
  state: TranslationState,
): StartTranslationConfig | { error: string } {
  const provider = state.provider;
  const modelName = state.getSelectedModel();
  const baseUrl = state.baseUrl.trim();
  const apiKey = state.apiKey.trim();

  if (provider !== "ollama" && !apiKey) {
    return {
      error:
        "Thiếu cấu hình API key. Vui lòng nhập API key trước khi bắt đầu dịch.",
    };
  }
  if (!modelName) {
    return {
      error: "Thiếu cấu hình model. Vui lòng chọn hoặc nhập tên model.",
    };
  }
  if (
    state.modelSelectValue === "__custom__" &&
    !state.customModelName.trim()
  ) {
    return {
      error: "Model tùy chỉnh đang trống. Vui lòng nhập Model ID hợp lệ.",
    };
  }
  if (!isKnownModelSelection(state)) {
    return {
      error:
        "Cấu hình model không hợp lệ cho provider hiện tại. Vui lòng chọn lại model.",
    };
  }
  if (!baseUrl) return { error: "Thiếu cấu hình Base URL." };
  if (!isValidBaseUrl(baseUrl)) {
    return {
      error:
        "Base URL không hợp lệ. Vui lòng dùng URL đầy đủ bắt đầu bằng http:// hoặc https://.",
    };
  }
  if (!state.fileContent) return { error: "Vui lòng chọn file cần dịch." };

  return { provider, modelName, baseUrl, apiKey };
}

function getResumeMismatchError(state: TranslationState): string | null {
  const checkpoint = state.pendingResumeCheckpoint;
  if (!checkpoint) return null;

  if (
    checkpoint.fileHash &&
    state.currentFileHash &&
    checkpoint.fileHash !== state.currentFileHash
  ) {
    return `Checkpoint thuộc file ${checkpoint.fileName || "khác"}. Hãy chọn đúng file nguồn rồi bấm Bắt đầu dịch lại.`;
  }

  if (
    !checkpoint.fileHash &&
    checkpoint.fileName &&
    state.fileName &&
    checkpoint.fileName !== state.fileName
  ) {
    return `Checkpoint thuộc file ${checkpoint.fileName}. Hãy chọn đúng file nguồn rồi bấm Bắt đầu dịch lại.`;
  }

  return null;
}

function getResumeTranslatedChunks(
  checkpoint: TranslationResumeCheckpoint | null,
): (string | null)[] {
  return Array.isArray(checkpoint?.translatedChunks)
    ? checkpoint.translatedChunks.slice()
    : [];
}

function resetTranslationRun(
  set: TranslationSetter,
  resumeTranslatedChunks: (string | null)[],
): void {
  set({
    error: "",
    isStopped: false,
    isRunning: true,
    usageStats: { promptTokens: 0, completionTokens: 0, totalCost: 0 },
    startTime: Date.now(),
    completedChunks: resumeTranslatedChunks.filter(isTranslatedChunk).length,
    translatedChunks: resumeTranslatedChunks,
    cacheHits: 0,
    cacheMisses: 0,
    logs: [],
    progressVisible: true,
    resultVisible: false,
  });
}

function splitSourceForTranslation(
  state: TranslationState,
  get: TranslationGetter,
  set: TranslationSetter,
): { fullChunks: string[]; chapterMap: ChapterMapEntry[] } {
  if (!state.enableChapterSplit) {
    return {
      fullChunks: splitIntoChunks(state.fileContent, state.chunkSize),
      chapterMap: [],
    };
  }

  const splitResult = splitIntoChapterChunks(
    state.fileContent,
    state.chunkSize,
  );
  const chapterCount = splitResult.chapterMap.length
    ? Math.max(...splitResult.chapterMap.map((entry) => entry.chapterIndex))
    : 0;
  if (chapterCount >= 2) {
    addLogEntry(
      get,
      set,
      `📖 Phát hiện ${chapterCount} chương — đang chia theo chương.`,
      "accent",
    );
  }

  return {
    fullChunks: splitResult.chunks,
    chapterMap: splitResult.chapterMap,
  };
}

/**
 * Appends dictionary-derived glossary lines (recurring Han-Viet terms found in the
 * source text) onto the user's manual glossary input — a free local stand-in for an
 * AI glossary pre-pass. No-op unless enableAutoGlossary is on. User-supplied mappings
 * always win over auto-detected ones for the same source term.
 */
async function buildEffectiveGlossaryInput(
  state: TranslationState,
): Promise<{ glossaryInput: string; autoCount: number }> {
  if (!state.enableAutoGlossary || !state.fileContent) {
    return { glossaryInput: state.glossaryInput, autoCount: 0 };
  }

  const userPairs = parseGlossaryInput(state.glossaryInput);
  const userSources = new Set(userPairs.map((pair) => pair.source));
  const autoPairs = (await extractAutoGlossary(state.fileContent)).filter(
    (pair) => !userSources.has(pair.source),
  );
  if (!autoPairs.length) {
    return { glossaryInput: state.glossaryInput, autoCount: 0 };
  }

  const autoLines = autoPairs
    .map((pair) => `${pair.source} => ${pair.target}`)
    .join("\n");
  const glossaryInput = state.glossaryInput
    ? `${state.glossaryInput}\n${autoLines}`
    : autoLines;
  return { glossaryInput, autoCount: autoPairs.length };
}

function prepareTranslationRun(
  state: TranslationState,
  resumeTranslatedChunks: (string | null)[],
  effectiveGlossaryInput: string,
  get: TranslationGetter,
  set: TranslationSetter,
): PreparedTranslationRun {
  const { fullChunks, chapterMap } = splitSourceForTranslation(state, get, set);
  const chunks = applyTranslationScope(fullChunks, state.scopePercent);
  const initialResults =
    resumeTranslatedChunks.length === chunks.length
      ? resumeTranslatedChunks
      : [];

  set({
    totalChunks: chunks.length,
    chapterMap,
    completedChunks: initialResults.filter(isTranslatedChunk).length,
    translatedChunks: initialResults,
  });

  return {
    chunks,
    chapterMap,
    initialResults,
    glossaryInstruction: buildGlossaryInstruction(
      parseGlossaryInput(effectiveGlossaryInput),
    ),
  };
}

function logPreparedTranslationRun(
  state: TranslationState,
  config: StartTranslationConfig,
  preparedRun: PreparedTranslationRun,
  get: TranslationGetter,
  set: TranslationSetter,
): void {
  const initialCompletedChunks =
    preparedRun.initialResults.filter(isTranslatedChunk).length;
  if (initialCompletedChunks > 0) {
    addLogEntry(
      get,
      set,
      `🧩 Tiếp tục từ checkpoint: đã có ${initialCompletedChunks}/${preparedRun.chunks.length} đoạn.`,
      "accent",
    );
  }
  addLogEntry(
    get,
    set,
    `Bắt đầu dịch ${state.scopePercent}%: ${preparedRun.chunks.length} đoạn · ${state.concurrentRequests} luồng song song`,
    "accent",
  );
  addLogEntry(
    get,
    set,
    `Model: ${config.modelName} @ ${config.baseUrl}`,
    "info",
  );
}

function logCompletionStatus(
  remainingErrors: number,
  get: TranslationGetter,
  set: TranslationSetter,
): void {
  if (remainingErrors > 0) {
    addLogEntry(
      get,
      set,
      `⚠️ Hoàn thành với ${remainingErrors} đoạn vẫn lỗi sau retry.`,
      "warning",
    );
    return;
  }

  addLogEntry(get, set, "🎉 Hoàn thành!", "success");
}

async function saveCloudTranslationIfSignedIn(
  completedState: TranslationState,
  config: StartTranslationConfig,
  finalText: string,
  get: TranslationGetter,
  set: TranslationSetter,
): Promise<void> {
  const authState = useAuthStore.getState();
  if (!authState.user) return;

  try {
    await saveTranslation(authState.user.uid, finalText, {
      fileName: completedState.fileName,
      model: config.modelName,
      provider: config.provider,
      totalChunks: completedState.totalChunks,
      promptTokens: completedState.usageStats.promptTokens,
      completionTokens: completedState.usageStats.completionTokens,
      cost: completedState.usageStats.totalCost,
    });
    await authState.refreshCloudHistory();
    addLogEntry(get, set, "Đã lưu bản dịch lên cloud.", "success");
  } catch (cloudError) {
    const message =
      cloudError instanceof Error ? cloudError.message : String(cloudError);
    addLogEntry(get, set, `Không lưu được cloud: ${message}`, "warning");
  }
}

async function completeTranslationRun(
  config: StartTranslationConfig,
  glossaryInstruction: string,
  get: TranslationGetter,
  set: TranslationSetter,
): Promise<void> {
  const remainingErrors = await retryFailedChunks({
    provider: config.provider,
    model: config.modelName,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    glossaryInstruction,
    maxRetryRounds: 3,
    get,
    set,
  });

  const finalText = buildFinalTextFromChunks(get().translatedChunks);
  logCompletionStatus(remainingErrors, get, set);
  set({ resultText: finalText, resultVisible: true });

  const completedState = get();
  saveCompletedTranslationLocal(completedState, config.modelName, finalText);
  addLogEntry(get, set, "Đã lưu bản dịch vào lịch sử local.", "success");
  await saveCloudTranslationIfSignedIn(
    completedState,
    config,
    finalText,
    get,
    set,
  );
}

async function executeTranslationRun(
  config: StartTranslationConfig,
  preparedRun: PreparedTranslationRun,
  get: TranslationGetter,
  set: TranslationSetter,
): Promise<void> {
  const results = await runChunkPipeline(preparedRun.chunks, {
    provider: config.provider,
    model: config.modelName,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    glossaryInstruction: preparedRun.glossaryInstruction,
    initialResults: preparedRun.initialResults,
    get,
    set,
  });
  set({ translatedChunks: results });

  if (get().isStopped) {
    addLogEntry(get, set, "Đã dừng bởi người dùng.", "warning");
    persistTranslationCheckpoint(get(), config.modelName);
    return;
  }

  await completeTranslationRun(
    config,
    preparedRun.glossaryInstruction,
    get,
    set,
  );
}

// ---------------------------------------------------------------------------
// Backend translation jobs (src/app/api/translate/jobs/*): the browser only
// starts a job and polls its status here — the actual chunk-by-chunk translation
// runs server-side via src/lib/translationJobRunner.ts, so it keeps going even if
// this tab closes or the screen locks. See resumeActiveBackendJob() above for how
// reopening the tab reattaches to a job that's still running.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3000;
const STALE_JOB_MS = 90_000;

let backendPollTimer: ReturnType<typeof setInterval> | null = null;

function getShortJobId(jobId: string): string {
  return jobId.slice(0, 8).toUpperCase();
}

function normalizeBackendLogTimestamp(timestampValue: string): string {
  const parsedTimestamp = Date.parse(timestampValue);
  if (Number.isNaN(parsedTimestamp)) return timestampValue;
  return new Date(parsedTimestamp).toLocaleTimeString("vi-VN");
}

function normalizeBackendLogs(jobLogs: LogEntry[]): LogEntry[] {
  return jobLogs.map((logEntry) => ({
    ...logEntry,
    timestamp: normalizeBackendLogTimestamp(logEntry.timestamp),
  }));
}

function buildBackendPollingStatusLog(
  jobId: string,
  job: BackendJobStatusResponse["job"],
  progress: BackendJobStatusResponse["progress"],
): LogEntry {
  const progressDoneCount = progress.done + progress.permanentlyFailed;
  const jobLabel = `Job ${getShortJobId(jobId)}`;

  if (job.status === "stopping") {
    return {
      timestamp: new Date().toLocaleTimeString("vi-VN"),
      message: `🛑 ${jobLabel} đang chờ dừng an toàn trên server...`,
      type: "warning",
    };
  }

  if (progressDoneCount === 0) {
    return {
      timestamp: new Date().toLocaleTimeString("vi-VN"),
      message: `⏳ Polling ${jobLabel}: đã tạo job, đang chờ server nhận lượt dịch đầu tiên...`,
      type: "info",
    };
  }

  return {
    timestamp: new Date().toLocaleTimeString("vi-VN"),
    message: `⏳ Polling ${jobLabel}: đã xong ${progressDoneCount}/${job.totalChunks} đoạn, đang tiếp tục lấy tiến độ mới...`,
    type: "info",
  };
}

function buildBackendLogsForUi(
  jobId: string,
  job: BackendJobStatusResponse["job"],
  progress: BackendJobStatusResponse["progress"],
): LogEntry[] {
  const normalizedLogs = normalizeBackendLogs(job.logs).slice(-179);
  if (job.status !== "running" && job.status !== "stopping") {
    return normalizedLogs;
  }

  const statusLog = buildBackendPollingStatusLog(jobId, job, progress);
  const latestServerLog = normalizedLogs.at(-1);
  if (latestServerLog?.message === statusLog.message) {
    return normalizedLogs;
  }
  return [...normalizedLogs, statusLog];
}

function stopBackendJobPolling(): void {
  if (backendPollTimer) {
    clearInterval(backendPollTimer);
    backendPollTimer = null;
  }
}

type BackendJobStatusResponse = {
  job: {
    id: string;
    status: "running" | "stopping" | "stopped" | "completed" | "error";
    totalChunks: number;
    fileName: string;
    logs: LogEntry[];
    error: string;
    updatedAtMs: number;
  };
  progress: {
    done: number;
    permanentlyFailed: number;
    promptTokens: number;
    completionTokens: number;
    cost: number;
  };
};

async function fetchBackendJobText(
  jobId: string,
): Promise<{ text: string; chunks: string[] } | null> {
  const idToken = await getCurrentIdToken();
  if (!idToken) return null;
  try {
    const response = await fetch(`/api/translate/jobs/${jobId}/text`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      text?: string;
      chunks?: string[];
    };
    if (typeof data.text !== "string" || !Array.isArray(data.chunks))
      return null;
    return { text: data.text, chunks: data.chunks };
  } catch {
    return null;
  }
}

async function fetchBackendJobChunks(jobId: string): Promise<string[] | null> {
  const result = await fetchBackendJobText(jobId);
  return result?.chunks ?? null;
}

async function finalizeBackendJob(
  status: "completed" | "stopped",
  jobId: string,
  get: TranslationGetter,
  set: TranslationSetter,
): Promise<void> {
  const result = await fetchBackendJobText(jobId);
  persistActiveBackendJobId(null);
  set({
    activeJobId: null,
    isRunning: false,
    translatedChunks: result?.chunks ?? [],
  });

  if (status === "completed" && result) {
    set({ resultText: result.text, resultVisible: true });
    addLogEntry(get, set, "🎉 Hoàn thành!", "success");
  } else {
    addLogEntry(get, set, "Đã dừng.", "warning");
  }
}

async function pollBackendJobOnce(
  jobId: string,
  get: TranslationGetter,
  set: TranslationSetter,
): Promise<void> {
  const idToken = await getCurrentIdToken();
  if (!idToken) return;

  let response: Response;
  try {
    response = await fetch(`/api/translate/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${idToken}` },
    });
  } catch {
    return; // transient network hiccup — the interval retries in 3s
  }
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      stopBackendJobPolling();
      persistActiveBackendJobId(null);
      set({
        isRunning: false,
        activeJobId: null,
        error:
          "Không tìm thấy job nền đang chạy. Vui lòng kiểm tra lại trong Lịch sử bản dịch.",
      });
    }
    return;
  }

  const { job, progress } = (await response.json()) as BackendJobStatusResponse;
  persistActiveBackendJobId(job.id);
  set({
    totalChunks: job.totalChunks,
    completedChunks: progress.done + progress.permanentlyFailed,
    usageStats: {
      promptTokens: progress.promptTokens,
      completionTokens: progress.completionTokens,
      totalCost: progress.cost,
    },
    logs: buildBackendLogsForUi(jobId, job, progress),
  });

  if (job.status === "completed" || job.status === "stopped") {
    stopBackendJobPolling();
    await finalizeBackendJob(job.status, jobId, get, set);
    return;
  }

  if (job.status === "error") {
    stopBackendJobPolling();
    persistActiveBackendJobId(null);
    set({
      isRunning: false,
      activeJobId: null,
      error: `Lỗi dịch: ${job.error}`,
    });
    return;
  }

  // Still running/stopping. Nudging the tick chain from here is a much faster
  // safety net than the once-a-day cron sweep Vercel Hobby allows (see
  // src/app/api/cron/resume-stalled-jobs) — active exactly when it's cheap to
  // check: whenever a tab happens to be open and polling.
  if (Date.now() - job.updatedAtMs > STALE_JOB_MS) {
    void fetch(`/api/translate/jobs/${jobId}/tick`, {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}` },
    }).catch(() => {});
  }
}

function startBackendJobPolling(
  jobId: string,
  get: TranslationGetter,
  set: TranslationSetter,
): void {
  stopBackendJobPolling();
  void pollBackendJobOnce(jobId, get, set);
  backendPollTimer = setInterval(
    () => void pollBackendJobOnce(jobId, get, set),
    POLL_INTERVAL_MS,
  );
}

async function attachToBackendJobId(
  jobId: string,
  get: TranslationGetter,
  set: TranslationSetter,
): Promise<void> {
  persistActiveBackendJobId(jobId);
  set({
    activeJobId: jobId,
    isRunning: true,
    isStopped: false,
    progressVisible: true,
    resultVisible: false,
    error: "",
  });
  addLogEntry(
    get,
    set,
    `🖥️ Đã kết nối lại Job ${getShortJobId(jobId)} — vẫn dịch tiếp khi bạn đóng tab trước đó.`,
    "accent",
  );
  startBackendJobPolling(jobId, get, set);
}

async function stopBackendJob(jobId: string): Promise<boolean> {
  const idToken = await getCurrentIdToken();
  if (!idToken) return false;
  try {
    const response = await fetch(`/api/translate/jobs/${jobId}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${idToken}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function startBackendTranslation(
  state: TranslationState,
  config: StartTranslationConfig,
  effectiveGlossaryInput: string,
  autoGlossaryCount: number,
  get: TranslationGetter,
  set: TranslationSetter,
): Promise<void> {
  set({
    error: "",
    isStopped: false,
    isRunning: true,
    usageStats: { promptTokens: 0, completionTokens: 0, totalCost: 0 },
    startTime: Date.now(),
    completedChunks: 0,
    translatedChunks: [],
    logs: [],
    progressVisible: true,
    resultVisible: false,
    activeJobId: null,
  });
  if (autoGlossaryCount > 0) {
    addLogEntry(
      get,
      set,
      `📚 Tự động thêm ${autoGlossaryCount} thuật ngữ Hán-Việt vào glossary.`,
      "accent",
    );
  }
  addLogEntry(get, set, "Đang tạo job dịch nền...", "accent");
  addLogEntry(
    get,
    set,
    `Cấu hình job nền: provider=${state.provider}, model=${config.modelName}`,
    "info",
  );

  try {
    const idToken = await getCurrentIdToken();
    if (!idToken) throw new Error("Không lấy được phiên đăng nhập.");

    const response = await fetch("/api/translate/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        fileName: state.fileName,
        fileContent: state.fileContent,
        fileHash: state.currentFileHash,
        provider: state.provider,
        model: config.modelName,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        chunkSize: state.chunkSize,
        concurrentRequests: state.concurrentRequests,
        temperature: state.temperature,
        delayBetweenChunks: state.delayBetweenChunks,
        scopePercent: state.scopePercent,
        enableChapterSplit: state.enableChapterSplit,
        systemPrompt: state.systemPrompt,
        glossaryInput: effectiveGlossaryInput,
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);

    set({ activeJobId: data.jobId });
    persistActiveBackendJobId(data.jobId);
    addLogEntry(
      get,
      set,
      `🖥️ Đang dịch nền trên server (${getShortJobId(data.jobId)}) — có thể đóng trình duyệt hoặc tắt màn hình.`,
      "success",
    );
    startBackendJobPolling(data.jobId, get, set);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    addLogEntry(get, set, `Lỗi tạo job dịch nền: ${message}`, "error");
    persistActiveBackendJobId(null);
    set({ error: `Lỗi dịch: ${message}`, isRunning: false });
  }
}

export const useTranslationStore = create<TranslationState>((set, get) => ({
  provider: "openrouter",
  baseUrl: PROVIDER_CONFIGS.openrouter.baseUrl,
  apiKey: "",
  runtimeApiKeys: {},
  modelSelectValue: OPENROUTER_MODEL_GROUPS.grok_budget.defaultModel,
  customModelName: "",
  openrouterGroup: "grok_budget",

  fileName: "",
  fileContent: "",
  fileSizeBytes: 0,
  currentFileHash: "",

  chunkSize: SPEED_PRESETS.turbo.chunkSize,
  concurrentRequests: SPEED_PRESETS.turbo.concurrent,
  temperature: SPEED_PRESETS.turbo.temperature,
  delayBetweenChunks: SPEED_PRESETS.turbo.delay,
  scopePercent: 100,
  enableChapterSplit: true,
  enableAutoGlossary: false,
  glossaryInput: "",
  selectedSkill: null,
  executionMode: readPersistedExecutionMode() ?? "background",
  systemPrompt: buildTranslationPrompt(null, null),
  activeSpeedPreset: "turbo",

  isRunning: false,
  isStopped: false,
  totalChunks: 0,
  completedChunks: 0,
  translatedChunks: [],
  chapterMap: [],
  startTime: null,
  cacheHits: 0,
  cacheMisses: 0,
  usageStats: { promptTokens: 0, completionTokens: 0, totalCost: 0 },
  logs: [],
  error: "",
  resultText: "",
  resultVisible: false,
  progressVisible: false,
  pendingResumeCheckpoint: null,
  activeJobId: null,

  setProvider(provider) {
    const config = PROVIDER_CONFIGS[provider];
    const modelSelectValue =
      provider === "openrouter"
        ? (OPENROUTER_MODEL_GROUPS[get().openrouterGroup]?.defaultModel ??
          config.defaultModel)
        : config.defaultModel;
    set({
      provider,
      baseUrl: config.baseUrl,
      modelSelectValue,
      customModelName: "",
    });
  },

  setModelSelectValue(value) {
    if (get().provider !== "openrouter") {
      set({ modelSelectValue: value });
      return;
    }

    const patch: Partial<TranslationState> = {
      modelSelectValue: value,
      customModelName: value === "__custom__" ? get().customModelName : "",
    };
    const openRouterGroup = findOpenRouterGroupForModel(value);
    if (openRouterGroup) {
      patch.openrouterGroup = openRouterGroup;
    }

    set(patch);
  },

  setCustomModelName(value) {
    set({ customModelName: value });
  },

  setApiKey(value) {
    set({ apiKey: value });
  },

  setBaseUrl(value) {
    set({ baseUrl: value });
  },

  setOpenrouterGroup(value) {
    const group = OPENROUTER_MODEL_GROUPS[value];
    set({
      openrouterGroup: value,
      modelSelectValue: group?.defaultModel ?? get().modelSelectValue,
      customModelName: "",
    });
  },

  updateSettings(partial) {
    if (isTranslationExecutionMode(partial.executionMode)) {
      persistExecutionMode(partial.executionMode);
    }
    set(partial);
  },

  applyRuntimeConfig(config) {
    const runtimeApiKeys = normalizeRuntimeApiKeys(config.keys);
    const patch: Partial<TranslationState> = { runtimeApiKeys };
    const nextProvider = isProviderId(config.defaultProvider)
      ? config.defaultProvider
      : get().provider;

    if (isProviderId(config.defaultProvider)) {
      patch.provider = config.defaultProvider;
      patch.baseUrl = PROVIDER_CONFIGS[config.defaultProvider].baseUrl;
    }

    if (typeof config.defaultModel === "string" && config.defaultModel.trim()) {
      Object.assign(
        patch,
        modelPatchForProvider(nextProvider, config.defaultModel),
      );

      if (nextProvider === "openrouter") {
        const openRouterGroup = findOpenRouterGroupForModel(
          config.defaultModel.trim(),
        );
        if (openRouterGroup) {
          patch.openrouterGroup = openRouterGroup;
        }
      }
    } else if (isProviderId(config.defaultProvider)) {
      patch.modelSelectValue =
        PROVIDER_CONFIGS[config.defaultProvider].defaultModel;
      patch.customModelName = "";
    }

    set(patch);
  },

  getSelectedModel() {
    const { modelSelectValue, customModelName } = get();
    return modelSelectValue === "__custom__"
      ? customModelName.trim()
      : modelSelectValue;
  },

  async loadFile(file) {
    const fileContent = await file.text();
    const currentFileHash = await hashContent(fileContent).catch(() => "");
    set({
      fileName: file.name,
      fileContent,
      fileSizeBytes: file.size,
      currentFileHash,
      resultVisible: false,
      progressVisible: false,
      error: "",
      pendingResumeCheckpoint: null,
    });
  },

  selectSkill(skillId) {
    const prompt = buildTranslationPrompt(skillId, null);
    set({ selectedSkill: skillId, systemPrompt: prompt });
  },

  applySpeedPreset(preset) {
    const settings = SPEED_PRESETS[preset];
    const { completedChunks, isStopped } = get();
    const patch: Partial<TranslationState> = {
      concurrentRequests: settings.concurrent,
      delayBetweenChunks: settings.delay,
      temperature: settings.temperature,
      activeSpeedPreset: preset,
    };
    if (!isStopped && completedChunks === 0) {
      patch.chunkSize = settings.chunkSize;
    }
    set(patch);
  },

  estimateCostPreview() {
    const state = get();
    if (!state.fileContent) return null;

    const model = state.getSelectedModel();
    const fullChunks = splitIntoChunks(state.fileContent, state.chunkSize);
    const chunks = applyTranslationScope(fullChunks, state.scopePercent);
    const glossaryInstruction = buildGlossaryInstruction(
      parseGlossaryInput(state.glossaryInput),
    );

    const promptOverheadChars =
      (state.systemPrompt + glossaryInstruction).length +
      buildTranslationUserPrompt("[CHUNK]", false, true).length;
    const promptOverheadTokens = estimateTokenCount(promptOverheadChars);
    const retryBufferFactor = 1.08;
    // Vietnamese output runs notably longer than the Chinese source in raw
    // character count — Han characters are logographic and pack more meaning
    // per glyph than Vietnamese's Latin-alphabet-plus-diacritics prose.
    const outputExpansionFactor = 2.2;

    let estimatedInputTokens = 0;
    let estimatedOutputTokens = 0;
    chunks.forEach((chunk) => {
      estimatedInputTokens +=
        estimateTokenCountForText(chunk) + promptOverheadTokens;
      estimatedOutputTokens += estimateTokenCount(
        Math.ceil(chunk.length * outputExpansionFactor),
      );
    });
    estimatedInputTokens = Math.ceil(estimatedInputTokens * retryBufferFactor);
    estimatedOutputTokens = Math.ceil(
      estimatedOutputTokens * retryBufferFactor,
    );

    const totalCost =
      costFromTokens(estimatedInputTokens, model, true) +
      costFromTokens(estimatedOutputTokens, model, false);

    return {
      totalChunks: chunks.length,
      totalInputTokens: estimatedInputTokens,
      totalOutputTokens: estimatedOutputTokens,
      totalCost,
    };
  },

  async startTranslation() {
    const state = get();
    const config = getStartTranslationConfig(state);
    if ("error" in config) {
      addLogEntry(get, set, config.error, "error");
      return set({ error: config.error, progressVisible: true });
    }

    const { glossaryInput: effectiveGlossaryInput, autoCount } =
      await buildEffectiveGlossaryInput(state);

    const resumeError = getResumeMismatchError(state);
    if (resumeError) return set({ error: resumeError });
    const resumeTranslatedChunks = getResumeTranslatedChunks(
      state.pendingResumeCheckpoint,
    );
    const hasResumeCheckpoint = resumeTranslatedChunks.some(isTranslatedChunk);

    // Signed-in users can choose backend mode (survives tab close / screen off)
    // or direct mode (lower overhead, usually faster perceived throughput).
    const shouldUseBackendJob =
      Boolean(useAuthStore.getState().user) &&
      state.provider !== "ollama" &&
      state.executionMode === "background" &&
      !hasResumeCheckpoint;
    if (shouldUseBackendJob) {
      return startBackendTranslation(
        state,
        config,
        effectiveGlossaryInput,
        autoCount,
        get,
        set,
      );
    }

    if (
      hasResumeCheckpoint &&
      Boolean(useAuthStore.getState().user) &&
      state.provider !== "ollama" &&
      state.executionMode === "background"
    ) {
      addLogEntry(
        get,
        set,
        "⚡ Đang tiếp tục từ checkpoint nên dùng chế độ trực tiếp để giữ nguyên tiến độ đã có.",
        "accent",
      );
    }

    if (useAuthStore.getState().user && state.provider !== "ollama") {
      addLogEntry(
        get,
        set,
        "⚡ Chế độ dịch trực tiếp: nhanh hơn nhưng cần giữ tab mở đến khi hoàn tất.",
        "accent",
      );
    }

    resetTranslationRun(set, resumeTranslatedChunks);
    if (autoCount > 0) {
      addLogEntry(
        get,
        set,
        `📚 Tự động thêm ${autoCount} thuật ngữ Hán-Việt vào glossary.`,
        "accent",
      );
    }

    const preparedRun = prepareTranslationRun(
      state,
      resumeTranslatedChunks,
      effectiveGlossaryInput,
      get,
      set,
    );
    logPreparedTranslationRun(state, config, preparedRun, get, set);

    try {
      await executeTranslationRun(config, preparedRun, get, set);
    } catch (fatalError) {
      const message =
        fatalError instanceof Error ? fatalError.message : String(fatalError);
      addLogEntry(get, set, `Lỗi nghiêm trọng: ${message}`, "error");
      set({ error: `Lỗi dịch: ${message}` });
    } finally {
      set({ isRunning: false });
    }
  },

  async stopTranslation() {
    const activeJobId = get().activeJobId;
    if (activeJobId) {
      set({ isStopped: true });
      addLogEntry(get, set, "Đang gửi lệnh dừng job dịch nền...", "warning");
      const stopRequested = await stopBackendJob(activeJobId);
      if (!stopRequested) {
        addLogEntry(
          get,
          set,
          "Không gửi được lệnh dừng. Vui lòng thử lại.",
          "error",
        );
        set({ isStopped: false });
        return;
      }

      await pollBackendJobOnce(activeJobId, get, set);
      return;
    }

    set({ isStopped: true });
    addLogEntry(
      get,
      set,
      "Đang dừng... (hoàn thành các yêu cầu đang chạy)",
      "warning",
    );
  },

  async resumeActiveBackendJob() {
    const user = useAuthStore.getState().user;
    if (!user || get().activeJobId || get().isRunning) return;

    const idToken = await getCurrentIdToken();
    if (!idToken) return;

    try {
      const response = await fetch("/api/translate/jobs?status=running", {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!response.ok) return;
      const data = (await response.json()) as {
        jobs?: { id: string; updatedAtMs?: number }[];
      };
      const runningJobs = Array.isArray(data.jobs) ? data.jobs.slice() : [];
      runningJobs.sort(
        (firstJob, secondJob) =>
          (secondJob.updatedAtMs ?? 0) - (firstJob.updatedAtMs ?? 0),
      );
      const freshestRunningJob = runningJobs[0];
      if (freshestRunningJob) {
        await attachToBackendJobId(freshestRunningJob.id, get, set);
        return;
      }

      const persistedJobId = readPersistedActiveBackendJobId();
      if (!persistedJobId) return;
      await attachToBackendJobId(persistedJobId, get, set);
    } catch {
      // Best-effort reconnect — the job keeps running server-side regardless.
    }
  },

  async attachToBackendJob(jobId) {
    if (get().activeJobId || get().isRunning) return;
    await attachToBackendJobId(jobId, get, set);
  },

  resumeFromCheckpoint(checkpoint) {
    const translatedChunks = Array.isArray(checkpoint.translatedChunks)
      ? checkpoint.translatedChunks.slice()
      : [];
    const totalChunks =
      Number(checkpoint.totalChunks) || translatedChunks.length;
    const completedChunks = translatedChunks.filter(isTranslatedChunk).length;
    set({
      pendingResumeCheckpoint: {
        translatedChunks,
        totalChunks,
        fileName: checkpoint.fileName,
        fileHash: checkpoint.fileHash,
      },
      translatedChunks,
      totalChunks,
      completedChunks,
      progressVisible: true,
      resultVisible: false,
      error: "",
    });
    addLogEntry(
      get,
      set,
      `Đã nạp checkpoint ${completedChunks}/${totalChunks} đoạn.`,
      "accent",
    );
  },

  ignoreResumeCheckpoint() {
    set({ pendingResumeCheckpoint: null });
  },

  async downloadResult(format) {
    const { activeJobId, fileName } = get();
    const baseName = fileName.replace(/\.[^.]+$/, "");
    // A completed/stopped backend job already gets its text copied into local
    // state by the poller (see finalizeBackendJob below) and clears activeJobId,
    // so this only actually hits the network while a job is still running.
    const translatedChunks = activeJobId
      ? await fetchBackendJobChunks(activeJobId)
      : get().translatedChunks;
    if (!translatedChunks) return;

    const savedName = await exportAs(
      translatedChunks,
      `${baseName}_vietnamese`,
      format,
    );
    addLogEntry(get, set, `⬇ Đã tải file: ${savedName}`, "success");
  },

  async downloadPartial(format) {
    const { activeJobId, fileName } = get();
    const baseName = fileName.replace(/\.[^.]+$/, "");
    const translatedChunks = activeJobId
      ? await fetchBackendJobChunks(activeJobId)
      : get().translatedChunks;
    if (!translatedChunks) return;

    const doneChunks = translatedChunks.filter(isTranslatedChunk);
    if (!doneChunks.length) return;
    const savedName = await exportAs(
      doneChunks,
      `${baseName}_partial_${doneChunks.length}chunks_vietnamese`,
      format,
    );
    addLogEntry(get, set, `⬇ Tải tiến độ: ${savedName}`, "success");
  },
}));

type PipelineContext = {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl: string;
  glossaryInstruction: string;
  initialResults?: (string | null)[];
  get: TranslationGetter;
  set: TranslationSetter;
};

/**
 * Builds engine params fresh from live store state on every call (rather than once
 * per run) so a mid-run edit to temperature/system prompt — nothing in the UI
 * disables those inputs while isRunning is true — still applies to chunks that
 * haven't started yet, matching the pre-refactor behavior where buildChatPayload
 * read straight from the live Zustand store.
 */
function buildEngineParams(ctx: PipelineContext): EngineParams {
  const state = ctx.get();
  return {
    provider: ctx.provider,
    model: ctx.model,
    apiKey: ctx.apiKey,
    baseUrl: ctx.baseUrl,
    glossaryInstruction: ctx.glossaryInstruction,
    temperature: state.temperature,
    systemPrompt: state.systemPrompt,
  };
}

function addUsageDelta(ctx: PipelineContext, delta: UsageDelta): void {
  const prev = ctx.get().usageStats;
  ctx.set({
    usageStats: {
      promptTokens: prev.promptTokens + delta.promptTokens,
      completionTokens: prev.completionTokens + delta.completionTokens,
      totalCost: prev.totalCost + delta.cost,
    },
  });
}

async function runChunkPipeline(
  chunks: string[],
  ctx: PipelineContext,
): Promise<(string | null)[]> {
  const { provider, model, get, set } = ctx;
  const results: (string | null)[] =
    ctx.initialResults?.length === chunks.length
      ? ctx.initialResults.slice()
      : new Array(chunks.length).fill(null);
  let nextChunkIndex = 0;
  let activeRequests = 0;

  return new Promise((resolve) => {
    function maybeResolve(): boolean {
      if (
        (get().isStopped || nextChunkIndex >= chunks.length) &&
        activeRequests === 0
      ) {
        resolve(results);
        return true;
      }
      return false;
    }

    async function launchChunk(index: number) {
      const chunk = chunks[index];
      activeRequests++;
      try {
        if (shouldSkipTranslation(chunk)) {
          results[index] = chunk;
          set({ translatedChunks: results.slice() });
          set({ completedChunks: get().completedChunks + 1 });
          addLogEntry(
            get,
            set,
            `↷ Bỏ qua đoạn ${index + 1} (không cần dịch)`,
            "info",
          );
        } else {
          const chunkHash = await hashContent(chunk);
          const cached = getCachedTranslation(chunkHash, model, provider);
          if (cached) {
            set({ cacheHits: get().cacheHits + 1 });
            results[index] = cached;
            set({ translatedChunks: results.slice() });
            addLogEntry(get, set, `✓ [CACHE] Đoạn ${index + 1}`, "success");
          } else {
            set({ cacheMisses: get().cacheMisses + 1 });
            addLogEntry(
              get,
              set,
              `▶ Đang dịch đoạn ${index + 1}/${chunks.length}...`,
              "info",
            );
            const translatedText = await translateChunkWithRetry(
              chunk,
              3,
              buildEngineParams(ctx),
              requestChatCompletions,
              (delta) => addUsageDelta(ctx, delta),
            );
            setCacheTranslation(chunkHash, model, provider, translatedText);
            results[index] = translatedText;
            set({ translatedChunks: results.slice() });
            addLogEntry(get, set, `✓ Hoàn thành đoạn ${index + 1}`, "success");
          }
          set({ completedChunks: get().completedChunks + 1 });
        }

        const doneCount = results.filter(isTranslatedChunk).length;
        if (
          doneCount > 0 &&
          (doneCount % 3 === 0 || doneCount === chunks.length)
        ) {
          persistTranslationCheckpoint(get(), model);
        }

        const delayMs = get().delayBetweenChunks;
        if (delayMs > 0 && !get().isStopped) await sleep(delayMs);
      } catch (chunkError) {
        const message =
          chunkError instanceof Error ? chunkError.message : String(chunkError);
        results[index] =
          `${FAILED_MARKER} ${index + 1}: ${message}]\n\n${chunk}`;
        set({ translatedChunks: results.slice() });
        set({ completedChunks: get().completedChunks + 1 });
        addLogEntry(get, set, `✗ Lỗi đoạn ${index + 1}: ${message}`, "error");
      } finally {
        activeRequests--;
        schedule();
      }
    }

    function schedule() {
      if (maybeResolve()) return;

      while (nextChunkIndex < chunks.length && results[nextChunkIndex]) {
        nextChunkIndex++;
      }

      const desiredConcurrency = get().concurrentRequests;
      const effectiveConcurrency =
        provider === "ollama"
          ? getOllamaEffectiveConcurrency(
              desiredConcurrency,
              get().completedChunks,
            )
          : desiredConcurrency;

      while (
        !get().isStopped &&
        activeRequests < effectiveConcurrency &&
        nextChunkIndex < chunks.length
      ) {
        const index = nextChunkIndex;
        nextChunkIndex++;
        while (nextChunkIndex < chunks.length && results[nextChunkIndex]) {
          nextChunkIndex++;
        }
        launchChunk(index);
      }

      maybeResolve();
    }

    schedule();
  });
}

function getFailedChunkIndices(chunks: (string | null)[]): number[] {
  const failedIndices: number[] = [];
  chunks.forEach((chunkText, index) => {
    if (chunkText?.startsWith(FAILED_MARKER)) failedIndices.push(index);
  });
  return failedIndices;
}

function getOriginalChunkFromFailure(failedContent: string): string | null {
  const originalTextStart = failedContent.indexOf("\n\n");
  if (originalTextStart === -1) return null;

  const originalChunkText = failedContent.slice(originalTextStart + 2);
  return originalChunkText.trim() ? originalChunkText : null;
}

function logRetryRound(
  round: number,
  maxRetryRounds: number,
  failedCount: number,
  get: TranslationGetter,
  set: TranslationSetter,
): void {
  addLogEntry(
    get,
    set,
    `🔄 Retry vòng ${round}/${maxRetryRounds}: ${failedCount} đoạn lỗi`,
    "accent",
  );
}

async function retryFailedChunkAtIndex(
  index: number,
  options: PipelineContext,
): Promise<void> {
  const failedContent = options.get().translatedChunks[index] ?? "";
  const originalChunkText = getOriginalChunkFromFailure(failedContent);
  if (!originalChunkText) return;

  try {
    const retranslated = await translateChunkWithRetry(
      originalChunkText,
      2,
      buildEngineParams(options),
      requestChatCompletions,
      (delta) => addUsageDelta(options, delta),
    );
    const next = options.get().translatedChunks.slice();
    next[index] = retranslated;
    options.set({ translatedChunks: next });
    addLogEntry(
      options.get,
      options.set,
      `  ✓ Đoạn ${index + 1} đã sửa!`,
      "success",
    );
  } catch (retryError) {
    const message =
      retryError instanceof Error ? retryError.message : String(retryError);
    addLogEntry(
      options.get,
      options.set,
      `  ✗ Đoạn ${index + 1} vẫn lỗi: ${message}`,
      "error",
    );
  }
}

async function retryFailedChunkBatch(
  failedIndices: number[],
  options: PipelineContext,
): Promise<void> {
  for (const index of failedIndices) {
    if (options.get().isStopped) return;
    await retryFailedChunkAtIndex(index, options);
    await sleep(1500);
  }
}

function countRemainingFailedChunks(chunks: (string | null)[]): number {
  return chunks.filter((chunkText) => chunkText?.startsWith(FAILED_MARKER))
    .length;
}

async function retryFailedChunks(
  options: PipelineContext & { maxRetryRounds: number },
): Promise<number> {
  const { get, set, maxRetryRounds } = options;

  for (let round = 1; round <= maxRetryRounds; round++) {
    if (get().isStopped) break;

    const failedIndices = getFailedChunkIndices(get().translatedChunks);
    if (!failedIndices.length) break;

    logRetryRound(round, maxRetryRounds, failedIndices.length, get, set);
    await sleep(round * 3000);
    await retryFailedChunkBatch(failedIndices, options);
  }

  return countRemainingFailedChunks(get().translatedChunks);
}
