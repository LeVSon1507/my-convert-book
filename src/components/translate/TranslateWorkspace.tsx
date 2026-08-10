"use client";

import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FileUpload } from "@/components/translate/FileUpload";
import { ProviderAndModel } from "@/components/translate/ProviderAndModel";
import { ExportFormat } from "@/lib/export";
import { useAuthStore } from "@/store/authStore";
import {
  SPEED_PRESETS,
  SpeedPresetId,
  useTranslationStore,
} from "@/store/translationStore";
import { BUILTIN_SKILLS } from "@/lib/skills";

const SCOPE_OPTIONS = [100, 70, 50, 30, 20, 10, 5];

const SPEED_LABELS: Record<SpeedPresetId, string> = {
  turbo: "Turbo",
  balanced: "Cân bằng",
  safe: "An toàn",
  economy: "Tiết kiệm",
};

const EXPORT_OPTIONS: { format: ExportFormat; label: string }[] = [
  { format: "txt", label: "TXT" },
  { format: "docx", label: "DOCX" },
  { format: "epub", label: "EPUB" },
];

function formatCurrency(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("vi-VN");
}

function TranslationSettings() {
  const [promptHint, setPromptHint] = useState("");
  const provider = useTranslationStore((s) => s.provider);
  const chunkSize = useTranslationStore((s) => s.chunkSize);
  const concurrentRequests = useTranslationStore((s) => s.concurrentRequests);
  const delayBetweenChunks = useTranslationStore((s) => s.delayBetweenChunks);
  const temperature = useTranslationStore((s) => s.temperature);
  const scopePercent = useTranslationStore((s) => s.scopePercent);
  const enableChapterSplit = useTranslationStore((s) => s.enableChapterSplit);
  const enableAutoGlossary = useTranslationStore((s) => s.enableAutoGlossary);
  const glossaryInput = useTranslationStore((s) => s.glossaryInput);
  const systemPrompt = useTranslationStore((s) => s.systemPrompt);
  const selectedSkill = useTranslationStore((s) => s.selectedSkill);
  const selectSkill = useTranslationStore((s) => s.selectSkill);
  const activeSpeedPreset = useTranslationStore((s) => s.activeSpeedPreset);
  const applySpeedPreset = useTranslationStore((s) => s.applySpeedPreset);
  const updateSettings = useTranslationStore((s) => s.updateSettings);
  const user = useAuthStore((s) => s.user);
  const savePrompts = useAuthStore((s) => s.savePrompts);
  const loadPrompts = useAuthStore((s) => s.loadPrompts);

  useEffect(() => {
    let cancelled = false;

    async function loadCloudPrompts() {
      if (!user) {
        setPromptHint("");
        return;
      }
      const prompts = await loadPrompts(provider);
      if (cancelled || !prompts) return;
      updateSettings({
        systemPrompt: prompts.systemPrompt || useTranslationStore.getState().systemPrompt,
        glossaryInput: prompts.glossaryInput || "",
      });
      setPromptHint(`Đã load prompt cloud cho ${provider}.`);
    }

    void loadCloudPrompts();
    return () => {
      cancelled = true;
    };
  }, [loadPrompts, provider, updateSettings, user]);

  async function saveCloudPrompts() {
    const ok = await savePrompts(provider, {
      systemPrompt,
      glossaryInput,
      plotDirection: "",
    });
    setPromptHint(ok ? "Đã lưu prompt vào account." : "Không lưu được prompt lên account.");
  }

  return (
    <div className="card">
      <div className="card-title">
        <span className="icon">⚙️</span> Thiết lập dịch
      </div>

      <div className="button-row" style={{ marginBottom: 16 }}>
        {(Object.keys(SPEED_PRESETS) as SpeedPresetId[]).map((preset) => (
          <button
            key={preset}
            className={`btn btn-secondary speed-preset-btn ${
              activeSpeedPreset === preset ? "active" : ""
            }`}
            onClick={() => applySpeedPreset(preset)}
            type="button"
          >
            {SPEED_LABELS[preset]}
          </button>
        ))}
      </div>

      <div className="card-subtitle" style={{ marginBottom: 8, fontSize: 13, color: "var(--text-muted)" }}>
        Kỹ năng dịch
      </div>
      <div className="button-row" style={{ marginBottom: 16 }}>
        <button
          className={`btn btn-secondary speed-preset-btn ${selectedSkill === null ? "active" : ""}`}
          onClick={() => selectSkill(null)}
          type="button"
          title="Dùng prompt mặc định hoặc tự soạn"
        >
          Tùy chỉnh
        </button>
        {BUILTIN_SKILLS.map((skill) => (
          <button
            key={skill.id}
            className={`btn btn-secondary speed-preset-btn ${selectedSkill === skill.id ? "active" : ""}`}
            onClick={() => selectSkill(skill.id)}
            type="button"
            title={skill.description}
          >
            {skill.shortLabel}
          </button>
        ))}
      </div>


      <div className="input-row">
        <div className="form-group">
          <label htmlFor="chunkSize">Kích thước mỗi đoạn</label>
          <input
            id="chunkSize"
            type="number"
            min={500}
            max={20000}
            step={500}
            value={chunkSize}
            onChange={(e) =>
              updateSettings({
                chunkSize: Number.parseInt(e.target.value, 10) || 500,
                activeSpeedPreset: null,
              })
            }
          />
        </div>
        <div className="form-group">
          <label htmlFor="concurrentRequests">Yêu cầu song song</label>
          <input
            id="concurrentRequests"
            type="number"
            min={1}
            max={200}
            step={1}
            value={concurrentRequests}
            onChange={(e) =>
              updateSettings({
                concurrentRequests: Number.parseInt(e.target.value, 10) || 1,
                activeSpeedPreset: null,
              })
            }
          />
        </div>
      </div>

      <div className="input-row">
        <div className="form-group">
          <label htmlFor="translationScope">Phạm vi dịch</label>
          <select
            id="translationScope"
            value={scopePercent}
            onChange={(e) =>
              updateSettings({
                scopePercent: Number.parseInt(e.target.value, 10) || 100,
              })
            }
          >
            {SCOPE_OPTIONS.map((scope) => (
              <option key={scope} value={scope}>
                {scope === 100 ? "100% (toàn bộ truyện)" : `${scope}% đầu truyện`}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="delayBetweenChunks">Delay giữa đoạn</label>
          <input
            id="delayBetweenChunks"
            type="number"
            min={0}
            max={10000}
            step={100}
            value={delayBetweenChunks}
            onChange={(e) =>
              updateSettings({
                delayBetweenChunks: Number.parseInt(e.target.value, 10) || 0,
                activeSpeedPreset: null,
              })
            }
          />
        </div>
      </div>

      <div className="form-group">
        <label htmlFor="temperature">
          Temperature: <span className="slider-value">{temperature.toFixed(2)}</span>
        </label>
        <div className="slider-row">
          <input
            id="temperature"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={temperature}
            onChange={(e) =>
              updateSettings({
                temperature: Number.parseFloat(e.target.value),
                activeSpeedPreset: null,
              })
            }
          />
        </div>
      </div>

      <div className="form-group">
        <label className="format-option">
          <input
            type="checkbox"
            checked={enableChapterSplit}
            onChange={(e) => updateSettings({ enableChapterSplit: e.target.checked })}
          />
          <span>Chia theo chương tự động</span>
        </label>
      </div>

      <div className="form-group">
        <label htmlFor="systemPrompt">System prompt</label>
        <textarea
          id="systemPrompt"
          value={systemPrompt}
          onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
        />
      </div>

      <div className="form-group">
        <label htmlFor="glossaryInput">Glossary tên riêng/địa danh</label>
        <textarea
          id="glossaryInput"
          placeholder="原名 => Tên Việt"
          value={glossaryInput}
          onChange={(e) => updateSettings({ glossaryInput: e.target.value })}
        />
      </div>
      <div className="form-group">
        <label className="format-option">
          <input
            checked={enableAutoGlossary}
            onChange={(e) => updateSettings({ enableAutoGlossary: e.target.checked })}
            type="checkbox"
          />
          <span>Tính thêm chi phí auto-glossary pre-pass</span>
        </label>
      </div>
      {user && (
        <div className="format-row">
          <button className="btn btn-secondary btn-sm" onClick={() => void saveCloudPrompts()} type="button">
            Lưu prompt vào account
          </button>
        </div>
      )}
      {promptHint && <div className="model-hint">{promptHint}</div>}
    </div>
  );
}

function CostPreview() {
  const preview = useTranslationStore(
    useShallow((s) => s.estimateCostPreview()),
  );
  const cacheHits = useTranslationStore((s) => s.cacheHits);
  const cacheMisses = useTranslationStore((s) => s.cacheMisses);

  if (!preview) return null;

  return (
    <div className="card cost-estimation-card">
      <div className="card-title">
        <span className="icon">💰</span> Ước tính chi phí
      </div>
      <div className="cost-estimation-content">
        <div className="cost-item">
          <span className="cost-label">Số đoạn</span>
          <span className="cost-value">{formatNumber(preview.totalChunks)}</span>
        </div>
        <div className="cost-item">
          <span className="cost-label">Input tokens</span>
          <span className="cost-value">{formatNumber(preview.totalInputTokens)}</span>
        </div>
        <div className="cost-item">
          <span className="cost-label">Output tokens</span>
          <span className="cost-value">{formatNumber(preview.totalOutputTokens)}</span>
        </div>
        <div className="cost-item">
          <span className="cost-label">Dự kiến</span>
          <span className="cost-value highlight">{formatCurrency(preview.totalCost)}</span>
        </div>
        {preview.glossaryPrePassCost > 0 && (
          <>
            <div className="cost-item">
              <span className="cost-label">Glossary pre-pass input</span>
              <span className="cost-value">
                {formatNumber(preview.glossaryPrePassInputTokens)}
              </span>
            </div>
            <div className="cost-item">
              <span className="cost-label">Glossary pre-pass output</span>
              <span className="cost-value">
                {formatNumber(preview.glossaryPrePassOutputTokens)}
              </span>
            </div>
            <div className="cost-item">
              <span className="cost-label">Tổng gồm pre-pass</span>
              <span className="cost-value highlight">
                {formatCurrency(preview.grandTotalCost)}
              </span>
            </div>
          </>
        )}
        {(cacheHits > 0 || cacheMisses > 0) && (
          <div className="cache-stats">
            <span className="cache-stat">Cache hit: {formatNumber(cacheHits)}</span>
            <span className="cache-stat">Miss: {formatNumber(cacheMisses)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TranslationActions() {
  const fileContent = useTranslationStore((s) => s.fileContent);
  const isRunning = useTranslationStore((s) => s.isRunning);
  const activeJobId = useTranslationStore((s) => s.activeJobId);
  const completedChunks = useTranslationStore((s) => s.completedChunks);
  const pendingResumeCheckpoint = useTranslationStore((s) => s.pendingResumeCheckpoint);
  const startTranslation = useTranslationStore((s) => s.startTranslation);
  const stopTranslation = useTranslationStore((s) => s.stopTranslation);
  const ignoreResumeCheckpoint = useTranslationStore((s) => s.ignoreResumeCheckpoint);
  const downloadPartial = useTranslationStore((s) => s.downloadPartial);
  const resumeDoneCount = pendingResumeCheckpoint?.translatedChunks.filter(Boolean).length ?? 0;
  const resumeTotalChunks = pendingResumeCheckpoint?.totalChunks ?? 0;
  const resumeFileName = pendingResumeCheckpoint?.fileName;

  return (
    <div className="card">
      {pendingResumeCheckpoint && resumeDoneCount > 0 && (
        <div className="alert alert-warning visible">
          <span>
            Checkpoint đã nạp: {formatNumber(resumeDoneCount)}/
            {formatNumber(resumeTotalChunks)} đoạn
            {resumeFileName ? ` từ ${resumeFileName}` : ""}. Hãy tải đúng file nguồn
            trước khi bấm Bắt đầu dịch.
          </span>
          <button
            className="btn btn-secondary btn-sm"
            onClick={ignoreResumeCheckpoint}
            type="button"
          >
            Bỏ qua
          </button>
        </div>
      )}
      {activeJobId && (
        <div className="alert alert-success visible">
          <span>
            🖥️ Đang dịch nền trên server — bạn có thể đóng trình duyệt hoặc tắt màn
            hình, bản dịch vẫn tiếp tục. Mở lại trang này để xem tiến độ.
          </span>
        </div>
      )}
      <div className="button-row">
        <button
          className="btn btn-primary btn-lg"
          disabled={!fileContent || isRunning}
          onClick={() => void startTranslation()}
          type="button"
        >
          {isRunning ? <span className="spinner" /> : null}
          Bắt đầu dịch
        </button>
        <button
          className="btn btn-danger"
          disabled={!isRunning}
          onClick={() => void stopTranslation()}
          type="button"
        >
          Dừng
        </button>
      </div>
      {completedChunks > 0 && (
        <div className="format-row" style={{ marginTop: 12 }}>
          {EXPORT_OPTIONS.map(({ format, label }) => (
            <button
              key={format}
              className="btn btn-secondary btn-sm"
              onClick={() => void downloadPartial(format)}
              type="button"
            >
              Tải tạm {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TranslationProgress() {
  const progressVisible = useTranslationStore((s) => s.progressVisible);
  const completedChunks = useTranslationStore((s) => s.completedChunks);
  const totalChunks = useTranslationStore((s) => s.totalChunks);
  const usageStats = useTranslationStore((s) => s.usageStats);
  const logs = useTranslationStore((s) => s.logs);
  const error = useTranslationStore((s) => s.error);
  const percent = totalChunks > 0 ? Math.round((completedChunks / totalChunks) * 100) : 0;

  if (!progressVisible && !error && logs.length === 0) return null;

  return (
    <div className="card progress-section visible">
      {error && <div className="alert alert-error visible">{error}</div>}
      <div className="progress-header">
        <span className="progress-label">Tiến độ dịch</span>
        <span className="progress-stat">{percent}%</span>
      </div>
      <div className="progress-bar-track">
        <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="progress-stats">
        <div className="progress-stat-card">
          <div className="stat-value">{formatNumber(completedChunks)}</div>
          <div className="stat-label">Đã xong</div>
        </div>
        <div className="progress-stat-card">
          <div className="stat-value">{formatNumber(totalChunks)}</div>
          <div className="stat-label">Tổng đoạn</div>
        </div>
        <div className="progress-stat-card">
          <div className="stat-value">{formatNumber(usageStats.promptTokens)}</div>
          <div className="stat-label">Token đầu vào</div>
        </div>
        <div className="progress-stat-card">
          <div className="stat-value">{formatCurrency(usageStats.totalCost)}</div>
          <div className="stat-label">Chi phí</div>
        </div>
      </div>
      <div className="log-container">
        {logs.length === 0 ? (
          <div className="log-entry info">Chưa có log.</div>
        ) : (
          logs.slice(-120).map((entry, index) => (
            <div key={`${entry.timestamp}-${index}`} className={`log-entry ${entry.type}`}>
              [{entry.timestamp}] {entry.message}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function TranslationResult() {
  const resultVisible = useTranslationStore((s) => s.resultVisible);
  const resultText = useTranslationStore((s) => s.resultText);
  const downloadResult = useTranslationStore((s) => s.downloadResult);

  if (!resultVisible || !resultText) return null;

  return (
    <div className="card result-section visible">
      <div className="card-title">
        <span className="icon">✅</span> Bản dịch
      </div>
      <div className="result-preview">{resultText.slice(0, 4000)}</div>
      <div className="format-row format-row-lg" style={{ marginTop: 12 }}>
        {EXPORT_OPTIONS.map(({ format, label }) => (
          <button
            key={format}
            className="btn btn-success"
            onClick={() => void downloadResult(format)}
            type="button"
          >
            Tải {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function TranslateWorkspace() {
  const user = useAuthStore((s) => s.user);
  const resumeActiveBackendJob = useTranslationStore((s) => s.resumeActiveBackendJob);

  // Reattaches to a still-running backend job on load — this is what makes a
  // translation started earlier (then the tab closed or the screen locked) show
  // up as already-in-progress instead of looking like nothing ever happened.
  useEffect(() => {
    if (user) void resumeActiveBackendJob();
  }, [user, resumeActiveBackendJob]);

  return (
    <>
      <ProviderAndModel />
      <FileUpload />
      <TranslationSettings />
      <CostPreview />
      <TranslationActions />
      <TranslationProgress />
      <TranslationResult />
    </>
  );
}
