import { create } from "zustand";
import { requestChatCompletions } from "@/lib/chatApi";
import { getCachedTranslation, setCacheTranslation } from "@/lib/cache";
import { buildTranslationPrompt, type SkillId } from "@/lib/skills";
import {
  ChapterMapEntry,
  splitIntoChapterChunks,
  splitIntoChunks,
} from "@/lib/chunking";
import {
  applyTranslationScope,
  estimateCost,
  estimateTokenCount,
} from "@/lib/cost";
import { exportAs, ExportFormat } from "@/lib/export";
import { saveTranslation, saveTranslationProgress } from "@/lib/firebase";
import {
  PROVIDER_CONFIGS,
  OPENROUTER_MODEL_GROUPS,
  ProviderId,
  extractAssistantText,
  getOllamaEffectiveConcurrency,
  getRequestTimeoutMs,
  hashContent,
  shouldSkipTranslation,
} from "@/lib/providers";
import {
  buildFinalTextFromChunks,
  buildTranslationUserPrompt,
  hasSevereRepetition,
  hasSevereSourceEcho,
  hasTruncatedOutput,
  postProcessTranslationOutput,
  splitChunkForContextRetry,
} from "@/lib/quality";
import type { RuntimeConfig } from "@/lib/runtimeConfig";
import { useAuthStore } from "@/store/authStore";

export type SpeedPresetId = "turbo" | "balanced" | "safe" | "economy";

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
const AUTO_GLOSSARY_SAMPLE_INPUT_CHARS = (350 + 3000) * 3;
const AUTO_GLOSSARY_SAMPLE_OUTPUT_CHARS = 600 * 3 * 3;

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
  glossaryPrePassInputTokens: number;
  glossaryPrePassOutputTokens: number;
  glossaryPrePassCost: number;
  grandTotalCost: number;
};

function parseGlossaryInput(
  rawGlossaryText: string,
): { source: string; target: string }[] {
  return String(rawGlossaryText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => {
      let arrow: string | null = null;
      if (line.includes("=>")) {
        arrow = "=>";
      } else if (line.includes("->")) {
        arrow = "->";
      }

      if (!arrow) return [];
      const [source, ...rest] = line.split(arrow);
      const target = rest.join(arrow).trim();
      return source.trim() && target ? [{ source: source.trim(), target }] : [];
    });
}

function buildGlossaryInstruction(
  pairs: { source: string; target: string }[],
): string {
  if (!pairs.length) return "";
  const rows = pairs
    .map((pair) => `- ${pair.source} => ${pair.target}`)
    .join("\n");
  return `\n\nGLOSSARY BẮT BUỘC — dùng đúng mapping sau, không được tự ý đổi tên riêng:\n${rows}\n- TUYỆT ĐỐI dùng đúng tên ở trên, giữ nguyên mọi đoạn.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTranslatedChunk(value: string | null): value is string {
  return Boolean(value);
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

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  stopTranslation: () => void;
  resumeFromCheckpoint: (checkpoint: TranslationResumeCheckpoint) => void;
  ignoreResumeCheckpoint: () => void;
  selectSkill: (skillId: SkillId | null) => void;
  downloadResult: (format: ExportFormat) => Promise<void>;
  downloadPartial: (format: ExportFormat) => Promise<void>;
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

function getStartTranslationConfig(
  state: TranslationState,
): StartTranslationConfig | { error: string } {
  const provider = state.provider;
  const modelName = state.getSelectedModel();
  const baseUrl = state.baseUrl.trim();
  const apiKey = state.apiKey.trim();

  if (provider !== "ollama" && !apiKey) {
    return { error: "Vui lòng nhập API key." };
  }
  if (!modelName) return { error: "Vui lòng chọn hoặc nhập tên model." };
  if (!baseUrl) return { error: "Vui lòng nhập Base URL." };
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

  const splitResult = splitIntoChapterChunks(state.fileContent, state.chunkSize);
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

function prepareTranslationRun(
  state: TranslationState,
  resumeTranslatedChunks: (string | null)[],
  get: TranslationGetter,
  set: TranslationSetter,
): PreparedTranslationRun {
  const { fullChunks, chapterMap } = splitSourceForTranslation(state, get, set);
  const chunks = applyTranslationScope(fullChunks, state.scopePercent);
  const initialResults =
    resumeTranslatedChunks.length === chunks.length ? resumeTranslatedChunks : [];

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
      parseGlossaryInput(state.glossaryInput),
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
  addLogEntry(get, set, `Model: ${config.modelName} @ ${config.baseUrl}`, "info");
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
  await saveCloudTranslationIfSignedIn(completedState, config, finalText, get, set);
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

export const useTranslationStore = create<TranslationState>((set, get) => ({
  provider: "openrouter",
  baseUrl: PROVIDER_CONFIGS.openrouter.baseUrl,
  apiKey: "",
  runtimeApiKeys: {},
  modelSelectValue: PROVIDER_CONFIGS.openrouter.defaultModel,
  customModelName: "",
  openrouterGroup: "mistral_translation",

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

  setProvider(provider) {
    const config = PROVIDER_CONFIGS[provider];
    set({
      provider,
      baseUrl: config.baseUrl,
      modelSelectValue: config.defaultModel,
      customModelName: "",
    });
  },

  setModelSelectValue(value) {
    set({ modelSelectValue: value });
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
    } else if (isProviderId(config.defaultProvider)) {
      patch.modelSelectValue =
        PROVIDER_CONFIGS[config.defaultProvider].defaultModel;
      patch.customModelName = "";
    }

    const runtimeKey = runtimeApiKeys[nextProvider];
    if (nextProvider !== "ollama" && runtimeKey) patch.apiKey = runtimeKey;

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
    const retryBufferFactor = 1.08;
    const outputExpansionFactor = 1.1;

    let estimatedInputChars = 0;
    let estimatedOutputChars = 0;
    chunks.forEach((chunk) => {
      estimatedInputChars += chunk.length + promptOverheadChars;
      estimatedOutputChars += Math.ceil(chunk.length * outputExpansionFactor);
    });
    estimatedInputChars = Math.ceil(estimatedInputChars * retryBufferFactor);
    estimatedOutputChars = Math.ceil(estimatedOutputChars * retryBufferFactor);

    const totalCost =
      estimateCost(estimatedInputChars, model, true) +
      estimateCost(estimatedOutputChars, model, false);
    const glossaryPrePassInputTokens = state.enableAutoGlossary
      ? estimateTokenCount(AUTO_GLOSSARY_SAMPLE_INPUT_CHARS)
      : 0;
    const glossaryPrePassOutputTokens = state.enableAutoGlossary
      ? estimateTokenCount(AUTO_GLOSSARY_SAMPLE_OUTPUT_CHARS)
      : 0;
    const glossaryPrePassCost = state.enableAutoGlossary
      ? estimateCost(AUTO_GLOSSARY_SAMPLE_INPUT_CHARS, model, true) +
        estimateCost(AUTO_GLOSSARY_SAMPLE_OUTPUT_CHARS, model, false)
      : 0;

    return {
      totalChunks: chunks.length,
      totalInputTokens: estimateTokenCount(estimatedInputChars),
      totalOutputTokens: estimateTokenCount(estimatedOutputChars),
      totalCost,
      glossaryPrePassInputTokens,
      glossaryPrePassOutputTokens,
      glossaryPrePassCost,
      grandTotalCost: totalCost + glossaryPrePassCost,
    };
  },

  async startTranslation() {
    const state = get();
    const config = getStartTranslationConfig(state);
    if ("error" in config) return set({ error: config.error });

    const resumeError = getResumeMismatchError(state);
    if (resumeError) return set({ error: resumeError });

    const resumeTranslatedChunks = getResumeTranslatedChunks(
      state.pendingResumeCheckpoint,
    );
    resetTranslationRun(set, resumeTranslatedChunks);

    const preparedRun = prepareTranslationRun(
      state,
      resumeTranslatedChunks,
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

  stopTranslation() {
    set({ isStopped: true });
    addLogEntry(
      get,
      set,
      "Đang dừng... (hoàn thành các yêu cầu đang chạy)",
      "warning",
    );
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
    const { translatedChunks, fileName } = get();
    const baseName = fileName.replace(/\.[^.]+$/, "");
    const savedName = await exportAs(
      translatedChunks,
      `${baseName}_vietnamese`,
      format,
    );
    addLogEntry(get, set, `⬇ Đã tải file: ${savedName}`, "success");
  },

  async downloadPartial(format) {
    const { translatedChunks, fileName } = get();
    const doneChunks = translatedChunks.filter(isTranslatedChunk);
    if (!doneChunks.length) return;
    const baseName = fileName.replace(/\.[^.]+$/, "");
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

type ChatCompletionResponse = {
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    cost?: unknown;
  };
  message?: {
    content?: unknown;
  };
  choices?: unknown;
  output_text?: unknown;
};

type AttemptErrorResolution =
  | { action: "retry" }
  | { action: "split"; text: string };

function buildChatPayload(
  chunk: string,
  strictRetryMode: boolean,
  ctx: PipelineContext,
): object {
  const temperature = ctx.get().temperature;
  const messages = [
    { role: "system", content: `${ctx.get().systemPrompt}${ctx.glossaryInstruction}` },
    {
      role: "user",
      content: buildTranslationUserPrompt(chunk, strictRetryMode, true, {
        glossaryInstruction: ctx.glossaryInstruction,
      }),
    },
  ];

  if (ctx.provider === "ollama") {
    return {
      model: ctx.model,
      stream: false,
      keep_alive: "30m",
      options: {
        temperature,
        top_p: 0.9,
        repeat_penalty: strictRetryMode ? 1.18 : 1.12,
      },
      messages,
    };
  }

  return {
    model: ctx.model,
    temperature,
    frequency_penalty: strictRetryMode ? 0.4 : 0.2,
    presence_penalty: 0,
    messages,
  };
}

async function requestChunkTranslation(
  payload: object,
  requestTimeoutMs: number,
  ctx: PipelineContext,
): Promise<Response> {
  const controller = new AbortController();
  let didTimeout = false;
  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, requestTimeoutMs);

  try {
    return await requestChatCompletions(
      ctx.provider,
      ctx.baseUrl,
      ctx.apiKey,
      payload,
      controller.signal,
    );
  } catch (requestError) {
    if (didTimeout) {
      throw new Error(`Timeout sau ${(requestTimeoutMs / 1000).toFixed(0)}s`);
    }
    throw requestError;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readChatCompletionResponse(
  response: Response,
): Promise<ChatCompletionResponse> {
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorBody}`);
  }

  return (await response.json()) as ChatCompletionResponse;
}

function addUsageStatsFromResponse(
  responseData: ChatCompletionResponse,
  ctx: PipelineContext,
): void {
  const usage = responseData.usage;
  if (!usage || typeof usage !== "object") return;

  const promptTokens = Number(usage.prompt_tokens) || 0;
  const completionTokens = Number(usage.completion_tokens) || 0;
  const cost = Number(usage.cost) || 0;
  if (promptTokens <= 0 && completionTokens <= 0 && cost <= 0) return;

  const prev = ctx.get().usageStats;
  ctx.set({
    usageStats: {
      promptTokens: prev.promptTokens + Math.max(promptTokens, 0),
      completionTokens: prev.completionTokens + Math.max(completionTokens, 0),
      totalCost: prev.totalCost + Math.max(cost, 0),
    },
  });
}

function extractRawTranslationOutput(
  responseData: ChatCompletionResponse,
  provider: ProviderId,
): string {
  return provider === "ollama" && typeof responseData.message?.content === "string"
    ? responseData.message.content
    : extractAssistantText(responseData);
}

async function translateChunkOnce(
  chunk: string,
  strictRetryMode: boolean,
  requestTimeoutMs: number,
  ctx: PipelineContext,
): Promise<string> {
  const payload = buildChatPayload(chunk, strictRetryMode, ctx);
  const response = await requestChunkTranslation(payload, requestTimeoutMs, ctx);
  const responseData = await readChatCompletionResponse(response);

  addUsageStatsFromResponse(responseData, ctx);

  const translatedText = postProcessTranslationOutput(
    extractRawTranslationOutput(responseData, ctx.provider),
    chunk,
    strictRetryMode,
    true,
  );
  if (!translatedText) throw new Error("Phản hồi API không hợp lệ");

  return translatedText;
}

function getQualityRetryDelayMs(
  translatedText: string,
  sourceChunk: string,
  attempt: number,
  maxRetries: number,
): number | null {
  if (attempt >= maxRetries) return null;
  if (hasSevereSourceEcho(translatedText, sourceChunk)) return 600 * attempt;
  if (hasSevereRepetition(translatedText)) return 500 * attempt;
  if (hasTruncatedOutput(translatedText)) return 500 * attempt;
  return null;
}

function isContextLengthError(status: number | undefined, message: string): boolean {
  return Boolean(
    status === 400 &&
      (message.includes("context") ||
        message.includes("too long") ||
        message.includes("maximum")),
  );
}

async function splitAndTranslateChunk(
  chunk: string,
  chunkIndex: number,
  ctx: PipelineContext,
): Promise<string | null> {
  if (chunk.length <= 1000) return null;

  const splitPair = splitChunkForContextRetry(chunk);
  if (!splitPair) return null;

  const [left, right] = await Promise.all([
    translateChunkWithRetry(splitPair[0], chunkIndex, 2, null, ctx),
    translateChunkWithRetry(splitPair[1], chunkIndex, 2, null, ctx),
  ]);
  return [left, right].filter(Boolean).join("\n");
}

async function resolveTranslationAttemptError(
  translationError: unknown,
  attempt: number,
  maxRetries: number,
  chunk: string,
  chunkIndex: number,
  ctx: PipelineContext,
): Promise<AttemptErrorResolution> {
  const status = getErrorStatus(translationError);
  const message = getErrorMessage(translationError);

  if (status === 429 && attempt < maxRetries) {
    await sleep(Math.min(5000 * 2 ** attempt, 30000) + Math.random() * 1000);
    return { action: "retry" };
  }

  if (isContextLengthError(status, message) && attempt < maxRetries) {
    const splitText = await splitAndTranslateChunk(chunk, chunkIndex, ctx);
    if (splitText) return { action: "split", text: splitText };
  }

  if (attempt === maxRetries) throw translationError;

  await sleep(attempt * 2000);
  return { action: "retry" };
}

async function translateChunkWithRetry(
  chunk: string,
  chunkIndex: number,
  maxRetries: number,
  chunkHash: string | null,
  ctx: PipelineContext,
): Promise<string> {
  const requestTimeoutMs = getRequestTimeoutMs(ctx.provider);
  let strictRetryMode = false;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const translatedText = await translateChunkOnce(
        chunk,
        strictRetryMode,
        requestTimeoutMs,
        ctx,
      );
      const qualityRetryDelayMs = getQualityRetryDelayMs(
        translatedText,
        chunk,
        attempt,
        maxRetries,
      );
      if (qualityRetryDelayMs !== null) {
        strictRetryMode = true;
        await sleep(qualityRetryDelayMs);
        continue;
      }

      if (chunkHash) {
        setCacheTranslation(chunkHash, ctx.model, ctx.provider, translatedText);
      }
      return translatedText;
    } catch (translationError) {
      const resolution = await resolveTranslationAttemptError(
        translationError,
        attempt,
        maxRetries,
        chunk,
        chunkIndex,
        ctx,
      );
      if (resolution.action === "split") return resolution.text;
    }
  }

  throw new Error("Không thể dịch đoạn này");
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
              index,
              3,
              chunkHash,
              ctx,
            );
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
      index,
      2,
      null,
      options,
    );
    const next = options.get().translatedChunks.slice();
    next[index] = retranslated;
    options.set({ translatedChunks: next });
    addLogEntry(options.get, options.set, `  ✓ Đoạn ${index + 1} đã sửa!`, "success");
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
