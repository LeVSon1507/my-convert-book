"use client";

import Image from "next/image";
import {
  useCallback,
  type ChangeEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { FileUpload } from "@/components/translate/FileUpload";
import { ProviderAndModel } from "@/components/translate/ProviderAndModel";
import { ExportFormat } from "@/lib/export";
import type { CloudProviderTranslationSettings } from "@/lib/firebase";
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

type FocusedReaderPanel = "source" | "result";

type TranslationStickyControlBarProps = Readonly<{
  className?: string;
}>;

function TranslationStickyControlBar({
  className,
}: TranslationStickyControlBarProps) {
  const fileContent = useTranslationStore(
    (translationState) => translationState.fileContent,
  );
  const isRunning = useTranslationStore(
    (translationState) => translationState.isRunning,
  );
  const startTranslation = useTranslationStore(
    (translationState) => translationState.startTranslation,
  );
  const stopTranslation = useTranslationStore(
    (translationState) => translationState.stopTranslation,
  );
  const costPreview = useTranslationStore(
    useShallow((translationState) => translationState.estimateCostPreview()),
  );

  if (!fileContent) return null;

  return (
    <div className={`translation-sticky-bar ${className ?? ""}`.trim()}>
      <div className="translation-sticky-meta">
        <span className="translation-sticky-label">Chi phí dự kiến</span>
        <strong>
          {costPreview ? formatCurrency(costPreview.totalCost) : "$0.00"}
        </strong>
      </div>
      <div className="translation-sticky-actions">
        <button
          className="btn btn-primary"
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
    </div>
  );
}

type MobileSettingsLauncherProps = Readonly<{
  onOpenSettings: () => void;
}>;

type DraggableLauncherPosition = {
  left: number;
  top: number;
};

type DraggableLauncherBounds = {
  maxLeft: number;
  maxTop: number;
  minLeft: number;
  minTop: number;
};

type DragSession = {
  originLeft: number;
  originTop: number;
  pointerId: number | null;
  startX: number;
  startY: number;
  wasDrag: boolean;
};

function clampValue(value: number, minValue: number, maxValue: number): number {
  return Math.max(minValue, Math.min(maxValue, value));
}

function getLogTypeIcon(logType: string): string {
  if (logType === "success") return "✓";
  if (logType === "warning") return "⚠";
  if (logType === "error") return "✕";
  if (logType === "accent") return "◈";
  return "•";
}

function MobileSettingsLauncher({
  onOpenSettings,
}: MobileSettingsLauncherProps) {
  const launcherRef = useRef<HTMLButtonElement>(null);
  const dragSessionRef = useRef<DragSession>({
    originLeft: 0,
    originTop: 0,
    pointerId: null,
    startX: 0,
    startY: 0,
    wasDrag: false,
  });
  const suppressClickRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const [launcherPosition, setLauncherPosition] =
    useState<DraggableLauncherPosition>(() => {
      if (typeof window === "undefined") {
        return { left: 16, top: 96 };
      }

      const viewportPadding = 12;
      const estimatedButtonWidth = 152;
      return {
        left: Math.max(
          viewportPadding,
          window.innerWidth - estimatedButtonWidth - viewportPadding,
        ),
        top: 96,
      };
    });

  const getLauncherBounds = useCallback(
    function getLauncherBounds(): DraggableLauncherBounds {
      const launcherRect = launcherRef.current?.getBoundingClientRect();
      const launcherWidth = launcherRect?.width ?? 136;
      const launcherHeight = launcherRect?.height ?? 40;
      const viewportPadding = 12;
      const minTop = 72;

      return {
        minLeft: viewportPadding,
        maxLeft: Math.max(
          viewportPadding,
          window.innerWidth - launcherWidth - viewportPadding,
        ),
        minTop,
        maxTop: Math.max(
          minTop,
          window.innerHeight - launcherHeight - viewportPadding,
        ),
      };
    },
    [],
  );

  const clampLauncherPosition = useCallback(
    function clampLauncherPosition(
      position: DraggableLauncherPosition,
    ): DraggableLauncherPosition {
      const bounds = getLauncherBounds();
      return {
        left: clampValue(position.left, bounds.minLeft, bounds.maxLeft),
        top: clampValue(position.top, bounds.minTop, bounds.maxTop),
      };
    },
    [getLauncherBounds],
  );

  const snapLauncherToNearestEdge = useCallback(
    function snapLauncherToNearestEdge(
      position: DraggableLauncherPosition,
    ): DraggableLauncherPosition {
      const bounds = getLauncherBounds();
      const distanceToLeft = Math.abs(position.left - bounds.minLeft);
      const distanceToRight = Math.abs(bounds.maxLeft - position.left);
      const snappedLeft =
        distanceToLeft <= distanceToRight ? bounds.minLeft : bounds.maxLeft;

      return {
        left: snappedLeft,
        top: clampValue(position.top, bounds.minTop, bounds.maxTop),
      };
    },
    [getLauncherBounds],
  );

  useEffect(() => {
    function handleViewportResize() {
      setLauncherPosition((currentPosition) =>
        clampLauncherPosition(currentPosition),
      );
    }

    handleViewportResize();
    window.addEventListener("resize", handleViewportResize);
    return () => {
      window.removeEventListener("resize", handleViewportResize);
    };
  }, [clampLauncherPosition]);

  function handleLauncherPointerDown(
    pointerEvent: React.PointerEvent<HTMLButtonElement>,
  ) {
    if (pointerEvent.button !== 0) return;

    const session = dragSessionRef.current;
    session.pointerId = pointerEvent.pointerId;
    session.startX = pointerEvent.clientX;
    session.startY = pointerEvent.clientY;
    session.originLeft = launcherPosition.left;
    session.originTop = launcherPosition.top;
    session.wasDrag = false;
    pointerEvent.currentTarget.setPointerCapture(pointerEvent.pointerId);
  }

  function handleLauncherPointerMove(
    pointerEvent: React.PointerEvent<HTMLButtonElement>,
  ) {
    const session = dragSessionRef.current;
    if (session.pointerId !== pointerEvent.pointerId) return;

    const offsetX = pointerEvent.clientX - session.startX;
    const offsetY = pointerEvent.clientY - session.startY;
    if (!session.wasDrag && Math.hypot(offsetX, offsetY) > 5) {
      session.wasDrag = true;
      setIsDragging(true);
    }
    if (!session.wasDrag) return;

    setLauncherPosition(
      clampLauncherPosition({
        left: session.originLeft + offsetX,
        top: session.originTop + offsetY,
      }),
    );
  }

  function handleLauncherPointerUp(
    pointerEvent: React.PointerEvent<HTMLButtonElement>,
  ) {
    const session = dragSessionRef.current;
    if (session.pointerId !== pointerEvent.pointerId) return;

    pointerEvent.currentTarget.releasePointerCapture(pointerEvent.pointerId);

    if (session.wasDrag) {
      suppressClickRef.current = true;
      setLauncherPosition((currentPosition) =>
        snapLauncherToNearestEdge(currentPosition),
      );
    }

    session.pointerId = null;
    session.wasDrag = false;
    setIsDragging(false);
  }

  function handleLauncherPointerCancel(
    pointerEvent: React.PointerEvent<HTMLButtonElement>,
  ) {
    const session = dragSessionRef.current;
    if (session.pointerId !== pointerEvent.pointerId) return;
    session.pointerId = null;
    session.wasDrag = false;
    setIsDragging(false);
  }

  function handleLauncherClick() {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onOpenSettings();
  }

  return (
    <button
      ref={launcherRef}
      className={`btn btn-secondary mobile-settings-launcher draggable-config-btn ${
        isDragging ? "dragging" : ""
      }`}
      onClick={handleLauncherClick}
      onPointerCancel={handleLauncherPointerCancel}
      onPointerDown={handleLauncherPointerDown}
      onPointerMove={handleLauncherPointerMove}
      onPointerUp={handleLauncherPointerUp}
      type="button"
      style={{
        left: launcherPosition.left,
        top: launcherPosition.top,
        transition: isDragging ? "none" : "left 0.2s ease, top 0.2s ease",
      }}
    >
      ⚙️ Cấu hình
    </button>
  );
}

function TranslationConsoleDrawer() {
  const [isConsoleExpanded, setIsConsoleExpanded] = useState(false);
  const logs = useTranslationStore((translationState) => translationState.logs);
  const completedChunks = useTranslationStore(
    (translationState) => translationState.completedChunks,
  );
  const totalChunks = useTranslationStore(
    (translationState) => translationState.totalChunks,
  );
  const isRunning = useTranslationStore(
    (translationState) => translationState.isRunning,
  );
  const error = useTranslationStore(
    (translationState) => translationState.error,
  );

  if (!isRunning && logs.length === 0 && !error) {
    return null;
  }

  const latestLogEntry = logs.at(-1);
  const latestLogType = latestLogEntry?.type ?? "info";
  const latestLog = latestLogEntry?.message ?? "Sẵn sàng";

  return (
    <div
      className={`translation-console-drawer ${isConsoleExpanded ? "expanded" : ""}`}
    >
      <button
        className="translation-console-toggle"
        onClick={() =>
          setIsConsoleExpanded((consoleExpanded) => !consoleExpanded)
        }
        type="button"
      >
        <span>
          {isRunning
            ? `Đang dịch ${completedChunks}/${totalChunks || "?"} đoạn`
            : `Hoàn thành ${completedChunks}/${totalChunks || "?"} đoạn`}
        </span>
        <span>{isConsoleExpanded ? "Thu gọn" : "Mở log"}</span>
      </button>

      <div className="translation-console-status">
        <span
          className={`translation-console-status-icon status-${latestLogType}`}
          aria-hidden="true"
        >
          {getLogTypeIcon(latestLogType)}
        </span>
        <span className="translation-console-status-text">{latestLog}</span>
      </div>
      {error && <div className="translation-console-error">{error}</div>}

      {isConsoleExpanded && (
        <div className="translation-console-log-body">
          {logs.length === 0 ? (
            <div className="log-entry info">Chưa có log.</div>
          ) : (
            logs.slice(-180).map((logEntry, logIndex) => (
              <div
                key={`${logEntry.timestamp}-${logIndex}`}
                className={`log-entry ${logEntry.type}`}
              >
                <span
                  className="translation-console-log-icon"
                  aria-hidden="true"
                >
                  {getLogTypeIcon(logEntry.type)}
                </span>
                <span className="translation-console-log-text">
                  [{logEntry.timestamp}] {logEntry.message}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function TranslationWorkbench() {
  const fileContent = useTranslationStore(
    (translationState) => translationState.fileContent,
  );
  const resultVisible = useTranslationStore(
    (translationState) => translationState.resultVisible,
  );
  const resultText = useTranslationStore(
    (translationState) => translationState.resultText,
  );
  const translatedChunks = useTranslationStore(
    (translationState) => translationState.translatedChunks,
  );
  const completedChunks = useTranslationStore(
    (translationState) => translationState.completedChunks,
  );
  const totalChunks = useTranslationStore(
    (translationState) => translationState.totalChunks,
  );
  const usageStats = useTranslationStore(
    (translationState) => translationState.usageStats,
  );
  const isRunning = useTranslationStore(
    (translationState) => translationState.isRunning,
  );
  const downloadResult = useTranslationStore(
    (translationState) => translationState.downloadResult,
  );
  const [isFocusMode, setIsFocusMode] = useState(false);
  const [focusedReaderPanel, setFocusedReaderPanel] =
    useState<FocusedReaderPanel>("source");

  const liveTranslatedText = resultVisible
    ? resultText
    : translatedChunks.filter(Boolean).join("\n\n");

  if (!fileContent) return null;

  const hasTranslatedOutput = Boolean(liveTranslatedText.trim());
  const idleResultMessage =
    "Bấm Bắt đầu dịch để tạo bản dịch và xem đối chiếu song song.";
  const loadingLineWidths = ["94%", "90%", "82%", "88%", "76%"];
  let translationResultBodyContent: ReactNode = idleResultMessage;

  if (hasTranslatedOutput) {
    translationResultBodyContent = liveTranslatedText;
  } else if (isRunning) {
    translationResultBodyContent = (
      <div
        className="translation-loading-placeholder"
        role="status"
        aria-live="polite"
      >
        <div className="translation-loading-lines">
          {loadingLineWidths.map((loadingLineWidth, lineOrder) => (
            <span
              key={`${loadingLineWidth}-${lineOrder}`}
              className="translation-loading-line"
              style={{ width: loadingLineWidth }}
            />
          ))}
        </div>
        <div className="translation-loading-meta">
          Đang dịch, bản thảo sẽ xuất hiện ngay khi hoàn tất đoạn đầu{" "}
          <span className="translation-loading-dots" aria-hidden="true" />
        </div>
      </div>
    );
  }

  function toggleFocusMode() {
    setIsFocusMode((focusModeEnabled) => !focusModeEnabled);
  }

  function activateSourceFocusPanel() {
    setFocusedReaderPanel("source");
  }

  function activateResultFocusPanel() {
    setFocusedReaderPanel("result");
  }

  return (
    <section
      className={`translation-workbench ${isFocusMode ? "focus-mode" : ""}`}
    >
      <div className="translation-workbench-header">
        <h3>Đối chiếu bản gốc và bản dịch</h3>
        <div className="translation-focus-actions">
          {isFocusMode && (
            <div
              className="translation-focus-switch"
              role="tablist"
              aria-label="Vùng đọc tập trung"
            >
              <button
                className={`btn btn-secondary btn-sm ${focusedReaderPanel === "source" ? "active" : ""}`}
                onClick={activateSourceFocusPanel}
                type="button"
              >
                Văn bản gốc
              </button>
              <button
                className={`btn btn-secondary btn-sm ${focusedReaderPanel === "result" ? "active" : ""}`}
                onClick={activateResultFocusPanel}
                type="button"
              >
                Bản dịch
              </button>
            </div>
          )}
          <button
            className="btn btn-secondary btn-sm"
            onClick={toggleFocusMode}
            type="button"
          >
            {isFocusMode ? "Thoát đọc tập trung" : "Đọc tập trung"}
          </button>
        </div>
      </div>

      <div className="translation-workbench-columns">
        <article
          className={`translation-reader-panel ${
            isFocusMode && focusedReaderPanel !== "source"
              ? "focus-hidden-panel"
              : ""
          }`}
        >
          <header className="translation-reader-panel-header">
            <span>Văn bản gốc</span>
            <small>{formatNumber(fileContent.length)} ký tự</small>
          </header>
          <div className="translation-reader-body source">{fileContent}</div>
        </article>

        <article
          className={`translation-reader-panel ${
            isFocusMode && focusedReaderPanel !== "result"
              ? "focus-hidden-panel"
              : ""
          }`}
        >
          <header className="translation-reader-panel-header">
            <span>Bản dịch</span>
            <div className="translation-stat-mini-bar">
              <span>
                {completedChunks}/{totalChunks || 0} đoạn
              </span>
              <span>{formatNumber(usageStats.promptTokens)} token in</span>
              <span>{formatCurrency(usageStats.totalCost)}</span>
            </div>
          </header>

          <div className="translation-reader-body result">
            {translationResultBodyContent}
          </div>

          {hasTranslatedOutput && (
            <div className="translation-export-row">
              {EXPORT_OPTIONS.map((exportOption, exportOptionIndex) => (
                <button
                  key={exportOption.format}
                  className={
                    exportOptionIndex === 0
                      ? "btn btn-primary"
                      : "btn btn-secondary export-outline-btn"
                  }
                  onClick={() => void downloadResult(exportOption.format)}
                  type="button"
                >
                  Tải {exportOption.label}
                </button>
              ))}
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("vi-VN");
}

type TooltipInfoProps = Readonly<{
  description: ReactNode;
  label: string;
}>;

type TooltipPosition = {
  left: number;
  top: number;
  maxWidth: number;
};

function TooltipInfo({ description, label }: TooltipInfoProps) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  const [tooltipPosition, setTooltipPosition] =
    useState<TooltipPosition | null>(null);

  function openTooltip() {
    setIsTooltipVisible(true);
  }

  function closeTooltip() {
    setIsTooltipVisible(false);
  }

  function updateTooltipPosition() {
    if (!triggerRef.current || !tooltipRef.current) return;

    const viewportPadding = 12;
    const triggerGap = 10;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const tooltipRect = tooltipRef.current.getBoundingClientRect();

    const maxWidth = Math.min(
      320,
      Math.max(220, window.innerWidth - viewportPadding * 2),
    );
    const tooltipWidth = Math.min(maxWidth, tooltipRect.width || maxWidth);

    let left = triggerRect.right + triggerGap;
    if (left + tooltipWidth > window.innerWidth - viewportPadding) {
      left = triggerRect.left - tooltipWidth - triggerGap;
    }
    left = Math.max(
      viewportPadding,
      Math.min(left, window.innerWidth - tooltipWidth - viewportPadding),
    );

    const tooltipHeight = tooltipRect.height;
    let top = triggerRect.top - 8;
    if (top + tooltipHeight > window.innerHeight - viewportPadding) {
      top = window.innerHeight - tooltipHeight - viewportPadding;
    }
    top = Math.max(viewportPadding, top);

    setTooltipPosition({ left, top, maxWidth });
  }

  useLayoutEffect(() => {
    if (!isTooltipVisible) return;

    updateTooltipPosition();

    function handleViewportChange() {
      updateTooltipPosition();
    }

    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [isTooltipVisible]);

  useEffect(() => {
    if (!isTooltipVisible) return;

    function handleEscapeKey(keyboardEvent: KeyboardEvent) {
      if (keyboardEvent.key === "Escape") {
        closeTooltip();
      }
    }

    window.addEventListener("keydown", handleEscapeKey);
    return () => {
      window.removeEventListener("keydown", handleEscapeKey);
    };
  }, [isTooltipVisible]);

  return (
    <>
      <span className="help-tooltip">
        <button
          ref={triggerRef}
          className="help-tooltip-trigger"
          type="button"
          aria-label={label}
          aria-describedby={isTooltipVisible ? tooltipId : undefined}
          onMouseEnter={openTooltip}
          onMouseLeave={closeTooltip}
          onFocus={openTooltip}
          onBlur={closeTooltip}
        >
          i
        </button>
      </span>

      {isTooltipVisible &&
        createPortal(
          <div
            id={tooltipId}
            ref={tooltipRef}
            className="help-tooltip-content help-tooltip-content-fixed"
            role="tooltip"
            style={{
              left: tooltipPosition?.left ?? 12,
              top: tooltipPosition?.top ?? 12,
              maxWidth: tooltipPosition?.maxWidth ?? 320,
              opacity: 1,
              transform: "translateY(0)",
              pointerEvents: "none",
            }}
          >
            {description}
          </div>,
          document.body,
        )}
    </>
  );
}

type ExpandedEditorField = "systemPrompt" | "glossaryInput";

function TranslationSettings() {
  const [promptHint, setPromptHint] = useState("");
  const [expandedEditorField, setExpandedEditorField] =
    useState<ExpandedEditorField | null>(null);
  const provider = useTranslationStore((s) => s.provider);
  const modelSelectValue = useTranslationStore((s) => s.modelSelectValue);
  const customModelName = useTranslationStore((s) => s.customModelName);
  const openrouterGroup = useTranslationStore((s) => s.openrouterGroup);
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
  const executionMode = useTranslationStore((s) => s.executionMode);
  const selectSkill = useTranslationStore((s) => s.selectSkill);
  const activeSpeedPreset = useTranslationStore((s) => s.activeSpeedPreset);
  const applySpeedPreset = useTranslationStore((s) => s.applySpeedPreset);
  const updateSettings = useTranslationStore((s) => s.updateSettings);
  const user = useAuthStore((s) => s.user);
  const savePrompts = useAuthStore((s) => s.savePrompts);
  const loadPrompts = useAuthStore((s) => s.loadPrompts);
  const saveTranslationSettings = useAuthStore(
    (authState) => authState.saveTranslationSettings,
  );
  const loadTranslationSettings = useAuthStore(
    (authState) => authState.loadTranslationSettings,
  );

  function getCloudLoadFingerprint(activeProvider: string): string {
    const currentState = useTranslationStore.getState();
    return [
      activeProvider,
      currentState.modelSelectValue,
      currentState.customModelName,
      currentState.openrouterGroup,
      currentState.systemPrompt,
      currentState.glossaryInput,
    ].join("::");
  }

  function buildCloudProviderSettingsSnapshot(): CloudProviderTranslationSettings {
    return {
      modelSelectValue,
      customModelName,
      openrouterGroup,
      chunkSize,
      concurrentRequests,
      temperature,
      delayBetweenChunks,
      scopePercent,
      enableChapterSplit,
      enableAutoGlossary,
      selectedSkill,
      executionMode,
      activeSpeedPreset,
    };
  }

  const applyCloudProviderSettings = useCallback(
    function applyCloudProviderSettings(
      savedSettings: CloudProviderTranslationSettings,
    ) {
      const matchedSkill = BUILTIN_SKILLS.find(
        (skillDefinition) => skillDefinition.id === savedSettings.selectedSkill,
      );
      selectSkill(matchedSkill?.id ?? null);

      updateSettings({
        modelSelectValue: savedSettings.modelSelectValue,
        customModelName: savedSettings.customModelName,
        openrouterGroup: savedSettings.openrouterGroup,
        chunkSize: savedSettings.chunkSize,
        concurrentRequests: savedSettings.concurrentRequests,
        temperature: savedSettings.temperature,
        delayBetweenChunks: savedSettings.delayBetweenChunks,
        scopePercent: savedSettings.scopePercent,
        enableChapterSplit: savedSettings.enableChapterSplit,
        enableAutoGlossary: savedSettings.enableAutoGlossary,
        executionMode: savedSettings.executionMode,
        activeSpeedPreset: savedSettings.activeSpeedPreset,
      });
    },
    [selectSkill, updateSettings],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadCloudPreferences() {
      if (!user) {
        setPromptHint("");
        return;
      }

      const providerAtLoadStart = provider;
      const loadFingerprintAtStart =
        getCloudLoadFingerprint(providerAtLoadStart);

      const [prompts, cloudSettings] = await Promise.all([
        loadPrompts(providerAtLoadStart),
        loadTranslationSettings(),
      ]);
      if (cancelled) return;

      const loadFingerprintAtEnd = getCloudLoadFingerprint(providerAtLoadStart);
      if (loadFingerprintAtStart !== loadFingerprintAtEnd) {
        setPromptHint(
          "Giữ cấu hình bạn vừa chỉnh tay, bỏ qua dữ liệu cloud cũ.",
        );
        return;
      }

      if (providerAtLoadStart !== useTranslationStore.getState().provider) {
        return;
      }

      const providerSettings = cloudSettings?.providers?.[providerAtLoadStart];
      if (providerSettings) {
        applyCloudProviderSettings(providerSettings);
      }

      if (prompts) {
        updateSettings({
          systemPrompt:
            prompts.systemPrompt || useTranslationStore.getState().systemPrompt,
          glossaryInput: prompts.glossaryInput || "",
        });
      }

      if (providerSettings || prompts) {
        setPromptHint(`Đã load cấu hình cloud cho ${providerAtLoadStart}.`);
      }
    }

    void loadCloudPreferences();
    return () => {
      cancelled = true;
    };
  }, [
    loadPrompts,
    loadTranslationSettings,
    provider,
    applyCloudProviderSettings,
    selectSkill,
    updateSettings,
    user,
  ]);

  async function saveCloudPrompts() {
    const ok = await savePrompts(provider, {
      systemPrompt,
      glossaryInput,
      plotDirection: "",
    });
    setPromptHint(
      ok ? "Đã lưu prompt vào account." : "Không lưu được prompt lên account.",
    );
  }

  async function saveCloudTranslationSettings() {
    const ok = await saveTranslationSettings(
      provider,
      buildCloudProviderSettingsSnapshot(),
    );
    setPromptHint(
      ok
        ? "Đã lưu setting vào account."
        : "Không lưu được setting lên account.",
    );
  }

  function openExpandedEditor(editorField: ExpandedEditorField) {
    setExpandedEditorField(editorField);
  }

  function closeExpandedEditor() {
    setExpandedEditorField(null);
  }

  function updateExpandedEditorValue(nextValue: string) {
    if (expandedEditorField === "systemPrompt") {
      updateSettings({ systemPrompt: nextValue });
      return;
    }
    if (expandedEditorField === "glossaryInput") {
      updateSettings({ glossaryInput: nextValue });
    }
  }

  const expandedEditorTitle =
    expandedEditorField === "systemPrompt"
      ? "System prompt"
      : "Glossary tên riêng/địa danh";
  const expandedEditorValue =
    expandedEditorField === "systemPrompt" ? systemPrompt : glossaryInput;

  function handleMobileSkillSelectChange(
    changeEvent: ChangeEvent<HTMLSelectElement>,
  ) {
    const selectedSkillValue = changeEvent.target.value;
    if (selectedSkillValue === "__custom__") {
      selectSkill(null);
      return;
    }

    const selectedSkillOption = BUILTIN_SKILLS.find(
      (skillDefinition) => skillDefinition.id === selectedSkillValue,
    );
    if (selectedSkillOption) {
      selectSkill(selectedSkillOption.id);
    }
  }

  function activateDirectExecutionMode() {
    updateSettings({ executionMode: "direct" });
  }

  function activateBackgroundExecutionMode() {
    updateSettings({ executionMode: "background" });
  }

  return (
    <div className="card">
      <div className="card-title">
        <span className="icon">⚙️</span> Thiết lập dịch
      </div>

      {user && provider !== "ollama" && (
        <div className="form-group execution-mode-group">
          <div className="label-with-tooltip-row execution-mode-label-row">
            <span className="execution-mode-field-label">Chế độ chạy</span>
            <TooltipInfo
              label="Giải thích chế độ chạy Browser và Cloud Server"
              description={
                <span className="execution-mode-tooltip-content">
                  <span className="execution-mode-tooltip-row">
                    <span className="execution-mode-pill browser">
                      💻 Browser trực tiếp
                    </span>
                    <span>
                      Gửi request thẳng từ tab hiện tại, tốc độ thường nhanh hơn
                      vì không qua Firestore job. Cần giữ tab mở đến khi hoàn
                      tất.
                    </span>
                  </span>
                  <span className="execution-mode-tooltip-row">
                    <span className="execution-mode-pill cloud">
                      ☁️ Cloud server
                    </span>
                    <span>
                      Chạy job nền trên server, bền vững khi đóng tab hoặc tắt
                      màn hình. Có thêm overhead đồng bộ nên thường chậm hơn.
                    </span>
                  </span>
                </span>
              }
            />
          </div>

          <div className="execution-mode-option-grid">
            <div
              className={`execution-mode-option ${
                executionMode === "direct" ? "active" : ""
              }`}
            >
              <button
                className="execution-mode-option-main"
                onClick={activateDirectExecutionMode}
                type="button"
                aria-pressed={executionMode === "direct"}
              >
                <span
                  className={`execution-mode-check ${
                    executionMode === "direct" ? "checked" : ""
                  }`}
                  aria-hidden="true"
                >
                  ✓
                </span>
                <span className="execution-mode-option-copy">
                  <strong>💻 Browser trực tiếp</strong>
                  <span>Nhanh hơn, nhưng cần giữ tab mở để chạy liên tục.</span>
                </span>
              </button>
              <TooltipInfo
                label="Chi tiết Browser trực tiếp"
                description="Phù hợp khi bạn cần tốc độ tối đa cho file nhỏ và vừa. Không tạo job server, không có bước polling trạng thái."
              />
            </div>

            <div
              className={`execution-mode-option ${
                executionMode === "background" ? "active" : ""
              }`}
            >
              <button
                className="execution-mode-option-main"
                onClick={activateBackgroundExecutionMode}
                type="button"
                aria-pressed={executionMode === "background"}
              >
                <span
                  className={`execution-mode-check ${
                    executionMode === "background" ? "checked" : ""
                  }`}
                  aria-hidden="true"
                >
                  ✓
                </span>
                <span className="execution-mode-option-copy">
                  <strong>☁️ Cloud server nền</strong>
                  <span>
                    Chạy bền hơn khi rời trang, nhưng có overhead nên chậm hơn.
                  </span>
                </span>
              </button>
              <TooltipInfo
                label="Chi tiết Cloud server nền"
                description="Phù hợp khi dịch file dài hoặc bạn cần rời tab. Job được lưu server-side và có thể nối lại sau khi tải lại trang."
              />
            </div>
          </div>
        </div>
      )}

      <div className="button-row speed-preset-row" style={{ marginBottom: 16 }}>
        {(Object.keys(SPEED_PRESETS) as SpeedPresetId[]).map(
          (speedPresetId) => (
            <button
              key={speedPresetId}
              className={`btn btn-secondary speed-preset-btn ${
                activeSpeedPreset === speedPresetId ? "active" : ""
              }`}
              onClick={() => applySpeedPreset(speedPresetId)}
              type="button"
            >
              {SPEED_LABELS[speedPresetId]}
            </button>
          ),
        )}
      </div>

      <div
        className="card-subtitle skill-chip-desktop"
        style={{ marginBottom: 8, fontSize: 13, color: "var(--text-muted)" }}
      >
        Kỹ năng dịch
      </div>
      <div className="form-group skill-select-mobile">
        <label htmlFor="mobileSkillSelect">Kỹ năng dịch</label>
        <select
          id="mobileSkillSelect"
          value={selectedSkill ?? "__custom__"}
          onChange={handleMobileSkillSelectChange}
        >
          <option value="__custom__">Tùy chỉnh</option>
          {BUILTIN_SKILLS.map((skillOption) => (
            <option key={skillOption.id} value={skillOption.id}>
              {skillOption.shortLabel}
            </option>
          ))}
        </select>
      </div>
      <div
        className="skill-chip-row skill-chip-desktop"
        style={{ marginBottom: 16 }}
      >
        <button
          className={`btn btn-secondary speed-preset-btn skill-chip-btn ${selectedSkill === null ? "active" : ""}`}
          onClick={() => selectSkill(null)}
          type="button"
          title="Dùng prompt mặc định hoặc tự soạn"
        >
          Tùy chỉnh
        </button>
        {BUILTIN_SKILLS.map((skillItem) => (
          <button
            key={skillItem.id}
            className={`btn btn-secondary speed-preset-btn skill-chip-btn ${selectedSkill === skillItem.id ? "active" : ""}`}
            onClick={() => selectSkill(skillItem.id)}
            type="button"
            title={skillItem.description}
          >
            {skillItem.shortLabel}
          </button>
        ))}
      </div>

      <div className="input-row">
        <div className="form-group">
          <div className="label-with-tooltip-row">
            <label htmlFor="chunkSize">Kích thước mỗi đoạn</label>
            <TooltipInfo
              label="Giải thích kích thước mỗi đoạn"
              description="Nên để 8000-12000 ký tự mỗi đoạn để cân bằng tốc độ và độ ổn định. Đặt quá cao có thể khiến output bị cắt."
            />
          </div>
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
          <div className="label-with-tooltip-row">
            <label htmlFor="concurrentRequests">Yêu cầu song song</label>
            <TooltipInfo
              label="Giải thích yêu cầu song song"
              description="Số request gửi đồng thời. Tăng số này giúp nhanh hơn nhưng có thể dễ chạm rate limit hoặc timeout ở model yếu."
            />
          </div>
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
                {scope === 100
                  ? "100% (toàn bộ truyện)"
                  : `${scope}% đầu truyện`}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <div className="label-with-tooltip-row">
            <label htmlFor="delayBetweenChunks">Delay giữa đoạn</label>
            <TooltipInfo
              label="Giải thích delay giữa đoạn"
              description="Khoảng nghỉ giữa hai đoạn dịch (ms). Tăng delay khi API dễ lỗi 429/rate limit để chạy ổn định hơn."
            />
          </div>
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
        <div className="label-with-tooltip-row">
          <label htmlFor="temperature">
            Temperature:{" "}
            <span className="slider-value">{temperature.toFixed(2)}</span>
          </label>
          <TooltipInfo
            label="Giải thích temperature"
            description="Temperature thấp cho văn phong ổn định, ít sáng tạo. Temperature cao cho câu chữ đa dạng hơn nhưng dễ lệch tone/chất lượng."
          />
        </div>
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
        <div className="checkbox-with-tooltip-row">
          <label className="format-option">
            <input
              type="checkbox"
              checked={enableChapterSplit}
              onChange={(changeEvent) =>
                updateSettings({
                  enableChapterSplit: changeEvent.target.checked,
                })
              }
            />
            <span>Chia theo chương tự động</span>
          </label>
          <TooltipInfo
            label="Giải thích chia theo chương tự động"
            description="Bật để cắt file theo mốc chương trước khi dịch, giúp đọc dễ hơn và thuận tiện xuất bản. Tắt nếu muốn liền mạch toàn văn."
          />
        </div>
      </div>

      <div className="form-group">
        <div className="editor-label-row">
          <label htmlFor="systemPrompt">System prompt</label>
          <button
            className="editor-expand-btn"
            onClick={() => openExpandedEditor("systemPrompt")}
            type="button"
          >
            Mở rộng
          </button>
        </div>
        <textarea
          className="prompt-editor-textarea"
          id="systemPrompt"
          value={systemPrompt}
          onChange={(changeEvent) =>
            updateSettings({ systemPrompt: changeEvent.target.value })
          }
        />
      </div>

      <div className="form-group">
        <div className="editor-label-row">
          <label htmlFor="glossaryInput">Glossary tên riêng/địa danh</label>
          <button
            className="editor-expand-btn"
            onClick={() => openExpandedEditor("glossaryInput")}
            type="button"
          >
            Mở rộng
          </button>
        </div>
        <textarea
          className="prompt-editor-textarea"
          id="glossaryInput"
          placeholder="原名 => Tên Việt"
          value={glossaryInput}
          onChange={(changeEvent) =>
            updateSettings({ glossaryInput: changeEvent.target.value })
          }
        />
      </div>
      <div className="form-group">
        <div className="checkbox-with-tooltip-row">
          <label className="format-option">
            <input
              checked={enableAutoGlossary}
              onChange={(changeEvent) =>
                updateSettings({
                  enableAutoGlossary: changeEvent.target.checked,
                })
              }
              type="checkbox"
            />
            <span>Tự động thêm glossary từ từ điển Hán-Việt (miễn phí)</span>
          </label>
          <TooltipInfo
            label="Giải thích auto-glossary pre-pass"
            description="Bật để trước khi dịch, tự động dò tên riêng/thuật ngữ lặp lại trong truyện qua từ điển Hán-Việt (~294.000 mục) và thêm vào glossary — giúp tên riêng nhất quán hơn. Chạy cục bộ, không tốn API call nên không phát sinh chi phí."
          />
        </div>
      </div>
      {user && (
        <div className="format-row">
          <button
            className="btn btn-secondary btn-sm btn-inline-action"
            onClick={() => void saveCloudTranslationSettings()}
            type="button"
          >
            Lưu setting vào account
          </button>
          <button
            className="btn btn-secondary btn-sm btn-inline-action"
            onClick={() => void saveCloudPrompts()}
            type="button"
          >
            Lưu prompt vào account
          </button>
        </div>
      )}
      {promptHint && <div className="model-hint">{promptHint}</div>}

      {expandedEditorField && (
        <div className="editor-modal-root">
          <button
            className="editor-modal-dismiss"
            onClick={closeExpandedEditor}
            type="button"
            aria-label="Đóng cửa sổ chỉnh sửa"
          />
          <dialog
            open
            className="editor-modal-card"
            aria-label={expandedEditorTitle}
          >
            <div className="editor-modal-header">
              <h3>{expandedEditorTitle}</h3>
              <button
                className="btn btn-secondary btn-sm"
                onClick={closeExpandedEditor}
                type="button"
              >
                Đóng
              </button>
            </div>
            <textarea
              className="prompt-editor-textarea prompt-editor-textarea-fullscreen"
              value={expandedEditorValue}
              onChange={(changeEvent) =>
                updateExpandedEditorValue(changeEvent.target.value)
              }
              placeholder="Nhập nội dung..."
            />
          </dialog>
        </div>
      )}
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
    <div className="card cost-estimation-card inspector-cost-card">
      <div className="card-title">
        <span className="icon">💰</span> Ước tính chi phí
      </div>
      <div className="cost-estimation-content">
        <div className="cost-item">
          <span className="cost-label">Số đoạn</span>
          <span className="cost-value">
            {formatNumber(preview.totalChunks)}
          </span>
        </div>
        <div className="cost-item">
          <span className="cost-label">Input tokens</span>
          <span className="cost-value">
            {formatNumber(preview.totalInputTokens)}
          </span>
        </div>
        <div className="cost-item">
          <span className="cost-label">Output tokens</span>
          <span className="cost-value">
            {formatNumber(preview.totalOutputTokens)}
          </span>
        </div>
        <div className="cost-item">
          <span className="cost-label">Dự kiến</span>
          <span className="cost-value highlight">
            {formatCurrency(preview.totalCost)}
          </span>
        </div>
        {(cacheHits > 0 || cacheMisses > 0) && (
          <div className="cache-stats">
            <span className="cache-stat">
              Cache hit: {formatNumber(cacheHits)}
            </span>
            <span className="cache-stat">
              Miss: {formatNumber(cacheMisses)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function TranslationActions() {
  const activeJobId = useTranslationStore((s) => s.activeJobId);
  const completedChunks = useTranslationStore((s) => s.completedChunks);
  const pendingResumeCheckpoint = useTranslationStore(
    (s) => s.pendingResumeCheckpoint,
  );
  const ignoreResumeCheckpoint = useTranslationStore(
    (s) => s.ignoreResumeCheckpoint,
  );
  const downloadPartial = useTranslationStore((s) => s.downloadPartial);
  const resumeDoneCount =
    pendingResumeCheckpoint?.translatedChunks.filter(Boolean).length ?? 0;
  const resumeTotalChunks = pendingResumeCheckpoint?.totalChunks ?? 0;
  const resumeFileName = pendingResumeCheckpoint?.fileName;
  const activeJobLabel = activeJobId
    ? `Job ${activeJobId.slice(0, 8).toUpperCase()}`
    : null;

  const hasActionPanel =
    (pendingResumeCheckpoint && resumeDoneCount > 0) ||
    Boolean(activeJobId) ||
    completedChunks > 0;

  if (!hasActionPanel) return null;

  return (
    <div className="card">
      {pendingResumeCheckpoint && resumeDoneCount > 0 && (
        <div className="alert alert-warning visible">
          <span>
            Checkpoint đã nạp: {formatNumber(resumeDoneCount)}/
            {formatNumber(resumeTotalChunks)} đoạn
            {resumeFileName ? ` từ ${resumeFileName}` : ""}. Hãy tải đúng file
            nguồn trước khi bấm Bắt đầu dịch.
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
        <div className="alert alert-success visible background-job-alert">
          <Image
            src="/undraw-img/undraw-background-job.svg"
            alt="Background job illustration"
            className="illustration background-job-illustration"
            width={48}
            height={36}
            priority={false}
          />
          <span>
            Đang dịch nền trên server — bạn có thể đóng trình duyệt hoặc tắt màn
            hình, bản dịch vẫn tiếp tục. Mở lại trang này để xem tiến độ.{" "}
            {activeJobLabel && (
              <strong className="background-job-chip">{activeJobLabel}</strong>
            )}{" "}
            Nếu cần tìm lại sau khi reload, vào tab Lịch sử bản dịch và chọn mục
            đang chạy.
          </span>
        </div>
      )}
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
  const error = useTranslationStore((s) => s.error);
  const percent =
    totalChunks > 0 ? Math.round((completedChunks / totalChunks) * 100) : 0;

  if (!progressVisible && !error) return null;

  return (
    <div className="card progress-section progress-section-compact visible">
      {error && <TranslationSystemErrorPanel errorMessage={error} />}
      <div className="progress-header">
        <div className="progress-title-group">
          <Image
            src="/undraw-img/undraw-progress.svg"
            alt="Progress illustration"
            className="illustration progress-illustration"
            width={56}
            height={42}
            priority={false}
          />
          <span className="progress-label">Tiến độ dịch</span>
        </div>
        <span className="progress-stat">{percent}%</span>
      </div>
      <div className="progress-inline-detail">
        {totalChunks > 0
          ? `Đang xử lý đoạn ${completedChunks}/${totalChunks}`
          : "Đang khởi tạo tiến trình..."}
      </div>
      <div className="progress-bar-track">
        <div className="progress-bar-fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

type TranslationSystemErrorVisual = {
  description: string;
  imageAlt: string;
  imageSrc: string;
  title: string;
  tone: "warning" | "error";
};

function resolveTranslationErrorVisual(
  errorMessage: string,
): TranslationSystemErrorVisual {
  const normalizedError = errorMessage.toLowerCase();

  if (
    normalizedError.includes("api key") ||
    normalizedError.includes("thiếu cấu hình")
  ) {
    return {
      title: "Thiếu cấu hình API",
      description:
        "Hệ thống chưa có API key hợp lệ cho provider hiện tại. Vào mục Cấu hình API để nhập key rồi chạy lại.",
      imageSrc: "/system-img/warning-illustration.svg",
      imageAlt: "Warning illustration",
      tone: "warning",
    };
  }

  if (
    normalizedError.includes("model") ||
    normalizedError.includes("base url")
  ) {
    return {
      title: "Cấu hình model chưa hợp lệ",
      description:
        "Model hoặc Base URL hiện tại không hợp lệ với provider đang chọn. Kiểm tra lại phần cấu hình trước khi chạy.",
      imageSrc: "/system-img/model-config-illustration.svg",
      imageAlt: "Configuration review illustration",
      tone: "warning",
    };
  }

  if (
    normalizedError.includes("404") ||
    normalizedError.includes("không tìm thấy")
  ) {
    return {
      title: "Không tìm thấy tài nguyên (404)",
      description:
        "API hoặc job bạn đang gọi không còn tồn tại. Tải lại trang và thử chạy lại từ đầu hoặc mở lại job trong Lịch sử.",
      imageSrc: "/system-img/error-404-illustration.svg",
      imageAlt: "404 not found illustration",
      tone: "error",
    };
  }

  if (
    normalizedError.includes("http 5") ||
    normalizedError.includes("server") ||
    normalizedError.includes("hệ thống") ||
    normalizedError.includes("lỗi nghiêm trọng")
  ) {
    return {
      title: "Lỗi hệ thống tạm thời",
      description:
        "Server đang gặp sự cố hoặc quá tải. Bạn có thể thử lại sau ít phút hoặc đổi provider/model để tiếp tục.",
      imageSrc: "/system-img/server-error-illustration.svg",
      imageAlt: "Server error illustration",
      tone: "error",
    };
  }

  return {
    title: "Đã xảy ra lỗi khi dịch",
    description:
      "Hệ thống không thể tiếp tục ở bước hiện tại. Kiểm tra log bên dưới và cấu hình API/model trước khi chạy lại.",
    imageSrc: "/system-img/system-error-illustration.svg",
    imageAlt: "System error illustration",
    tone: "error",
  };
}

type TranslationSystemErrorPanelProps = Readonly<{
  errorMessage: string;
}>;

function TranslationSystemErrorPanel({
  errorMessage,
}: TranslationSystemErrorPanelProps) {
  const errorVisual = resolveTranslationErrorVisual(errorMessage);

  return (
    <div className={`system-error-panel ${errorVisual.tone}`}>
      <Image
        src={errorVisual.imageSrc}
        alt={errorVisual.imageAlt}
        className="system-error-panel-image"
        width={132}
        height={90}
        priority={false}
      />
      <div className="system-error-panel-copy">
        <strong>{errorVisual.title}</strong>
        <p>{errorVisual.description}</p>
        <span>{errorMessage}</span>
      </div>
    </div>
  );
}

export function TranslateWorkspace() {
  const user = useAuthStore((s) => s.user);
  const fileContent = useTranslationStore(
    (translationState) => translationState.fileContent,
  );
  const resumeActiveBackendJob = useTranslationStore(
    (s) => s.resumeActiveBackendJob,
  );
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isInspectorSheetOpen, setIsInspectorSheetOpen] = useState(false);
  const [isMobileExecutionPanelOpen, setIsMobileExecutionPanelOpen] =
    useState(false);
  const hasLoadedFile = Boolean(fileContent);
  const shouldRenderExecutionPanel =
    hasLoadedFile && (!isMobileViewport || isMobileExecutionPanelOpen);

  useEffect(() => {
    const mediaQueryList = globalThis.window.matchMedia("(max-width: 768px)");

    function applyViewportMode() {
      setIsMobileViewport(mediaQueryList.matches);
    }

    applyViewportMode();
    mediaQueryList.addEventListener("change", applyViewportMode);
    return () => {
      mediaQueryList.removeEventListener("change", applyViewportMode);
    };
  }, []);

  // Reattaches to a still-running backend job on load — this is what makes a
  // translation started earlier (then the tab closed or the screen locked) show
  // up as already-in-progress instead of looking like nothing ever happened.
  useEffect(() => {
    if (user) void resumeActiveBackendJob();
  }, [user, resumeActiveBackendJob]);

  return (
    <div className="translate-workspace">
      <div className="translate-workspace-layout">
        <section className="translate-main-column">
          <FileUpload isPrimaryFocus={!hasLoadedFile} />
          {!hasLoadedFile && (
            <div className="card translate-disclosure-note-card">
              <p className="translate-disclosure-note">
                Chọn file trước để bắt đầu quy trình dịch. Sau khi tải file, bạn
                có thể theo dõi tiến độ xử lý theo từng đoạn ngay tại cột làm
                việc này.
              </p>
            </div>
          )}
          {hasLoadedFile && isMobileViewport && (
            <div className="card mobile-execution-toggle-card">
              <button
                className="btn btn-secondary btn-full"
                onClick={() =>
                  setIsMobileExecutionPanelOpen(
                    (executionPanelOpen) => !executionPanelOpen,
                  )
                }
                type="button"
              >
                {isMobileExecutionPanelOpen
                  ? "Ẩn tiến độ và kết quả"
                  : "Xem tiến độ và kết quả"}
              </button>
            </div>
          )}
          {shouldRenderExecutionPanel && (
            <>
              <TranslationActions />
              <TranslationProgress />
              <TranslationWorkbench />
            </>
          )}
        </section>

        {!isMobileViewport && (
          <aside className="translate-inspector-column">
            <div className="translate-inspector-sticky">
              <ProviderAndModel />
              <TranslationSettings />
              <CostPreview />
            </div>
          </aside>
        )}
      </div>

      {isMobileViewport && (
        <MobileSettingsLauncher
          onOpenSettings={() => setIsInspectorSheetOpen(true)}
        />
      )}

      {isMobileViewport && isInspectorSheetOpen && (
        <div className="mobile-inspector-sheet-root">
          <button
            className="mobile-inspector-sheet-backdrop"
            onClick={() => setIsInspectorSheetOpen(false)}
            type="button"
            aria-label="Đóng cấu hình"
          />
          <div className="mobile-inspector-sheet-panel">
            <div className="mobile-inspector-sheet-header">
              <strong>Cấu hình dịch</strong>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setIsInspectorSheetOpen(false)}
                type="button"
              >
                Xong
              </button>
            </div>
            <ProviderAndModel />
            <TranslationSettings />
            <CostPreview />
          </div>
        </div>
      )}

      <TranslationStickyControlBar />
      <TranslationConsoleDrawer />
    </div>
  );
}
