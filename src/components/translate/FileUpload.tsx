"use client";

import Image from "next/image";
import { type ChangeEvent, type DragEvent, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useTranslationStore } from "@/store/translationStore";

type FileUploadProps = Readonly<{
  isPrimaryFocus?: boolean;
}>;

export function FileUpload({ isPrimaryFocus = false }: FileUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSourcePreviewVisible, setIsSourcePreviewVisible] = useState(true);
  const fileName = useTranslationStore((s) => s.fileName);
  const fileSizeBytes = useTranslationStore((s) => s.fileSizeBytes);
  const fileContent = useTranslationStore((s) => s.fileContent);
  const chunkSize = useTranslationStore((s) => s.chunkSize);
  const isRunning = useTranslationStore((s) => s.isRunning);
  const loadFile = useTranslationStore((s) => s.loadFile);
  const stopTranslation = useTranslationStore((s) => s.stopTranslation);
  const updateSettings = useTranslationStore((s) => s.updateSettings);
  const costPreview = useTranslationStore(
    useShallow((translationState) => translationState.estimateCostPreview()),
  );

  const sizeMB = (fileSizeBytes / 1024 / 1024).toFixed(2);
  const charCount = fileContent.length.toLocaleString("vi-VN");
  const estimatedSegmentCount = Math.max(
    1,
    Math.ceil(fileContent.length / Math.max(chunkSize, 1)),
  ).toLocaleString("vi-VN");
  const extensionLabel = fileName.includes(".")
    ? fileName.split(".").pop()?.toUpperCase() || "TEXT"
    : "TEXT";
  const sourcePreviewText = fileContent.slice(0, 3200);
  const isSourcePreviewTruncated =
    sourcePreviewText.length < fileContent.length;
  const previewCost = costPreview?.totalCost ?? 0;
  const previewCostDigits = previewCost < 0.01 ? 4 : 2;
  const formattedPreviewCost = `$${previewCost.toFixed(previewCostDigits)}`;

  function handleOpenPicker() {
    fileInputRef.current?.click();
  }

  function handleDragOver(dragEvent: DragEvent<HTMLButtonElement>) {
    dragEvent.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function handleDrop(dragEvent: DragEvent<HTMLButtonElement>) {
    dragEvent.preventDefault();
    setIsDragOver(false);
    const droppedFile = dragEvent.dataTransfer.files[0];
    if (!droppedFile) {
      return;
    }
    void loadFile(droppedFile).then(() => {
      setIsSourcePreviewVisible(true);
    });
  }

  function handleInputChange(changeEvent: ChangeEvent<HTMLInputElement>) {
    const selectedFile = changeEvent.target.files?.[0];
    if (!selectedFile) {
      return;
    }
    void loadFile(selectedFile).then(() => {
      setIsSourcePreviewVisible(true);
    });
  }

  function handleToggleSourcePreview() {
    setIsSourcePreviewVisible((previewVisible) => !previewVisible);
  }

  async function handleClearFile() {
    if (isRunning) {
      await stopTranslation();
    }
    updateSettings({
      fileName: "",
      fileContent: "",
      fileSizeBytes: 0,
      currentFileHash: "",
      totalChunks: 0,
      completedChunks: 0,
      translatedChunks: [],
      resultText: "",
      resultVisible: false,
      progressVisible: false,
      error: "",
      activeJobId: null,
      pendingResumeCheckpoint: null,
      usageStats: { promptTokens: 0, completionTokens: 0, totalCost: 0 },
      logs: [],
      cacheHits: 0,
      cacheMisses: 0,
      startTime: null,
      isRunning: false,
      isStopped: false,
    });
    setIsSourcePreviewVisible(false);
  }

  return (
    <div
      className={`card upload-card ${isPrimaryFocus ? "upload-card-primary" : ""}`}
    >
      <div className="card-title">
        <span className="icon">📂</span> Chọn file truyện
      </div>

      {!fileName ? (
        <button
          type="button"
          className={`drop-zone ${isDragOver ? "drag-over" : ""}`}
          onClick={handleOpenPicker}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <Image
            src="/undraw-img/undraw-upload-empty.svg"
            alt="Upload empty illustration"
            className="illustration upload-empty-illustration"
            width={120}
            height={90}
            priority={false}
          />
          <span className="drop-icon">📄</span>
          <div className="drop-title">Kéo thả file vào đây</div>
          <div className="drop-subtitle">
            <span className="drop-subtitle-desktop">
              hoặc click để chọn file · Hỗ trợ .txt, .md, .text
            </span>
            <span className="drop-subtitle-mobile">
              Chạm để chọn file từ máy hoặc iCloud · Hỗ trợ .txt, .md, .text
            </span>
          </div>
        </button>
      ) : (
        <div className="file-summary-card">
          <div className="file-summary-main">
            <span className="file-extension-badge">.{extensionLabel}</span>
            <div className="file-summary-content">
              <div className="file-summary-title" title={fileName}>
                {fileName}
              </div>
              <div className="file-summary-meta">
                {sizeMB} MB · {charCount} ký tự · {estimatedSegmentCount} đoạn
                ước tính
              </div>
            </div>
          </div>

          <div className="file-summary-toolbar">
            <div className="file-summary-cost-pill">
              <span>Chi phí dự kiến</span>
              <strong>{formattedPreviewCost}</strong>
            </div>
          </div>

          <div className="file-summary-actions">
            <button
              className="btn btn-secondary btn-sm file-summary-action"
              onClick={handleOpenPicker}
              type="button"
            >
              Tải lại file khác
            </button>
            <button
              className="btn btn-danger-ghost btn-sm file-summary-action file-summary-action-danger"
              onClick={() => void handleClearFile()}
              type="button"
            >
              Xóa file
            </button>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.text"
        style={{ display: "none" }}
        onChange={handleInputChange}
      />

      {fileName && (
        <div className="card source-preview-card">
          <button
            className="source-preview-accordion-trigger"
            onClick={handleToggleSourcePreview}
            type="button"
            aria-expanded={isSourcePreviewVisible}
            aria-controls="sourcePreviewBody"
          >
            <span className="card-title">
              <span className="icon">🧾</span> Xem trước nội dung gốc
            </span>
            <span className="source-preview-accordion-icon" aria-hidden="true">
              {isSourcePreviewVisible ? "▴" : "▾"}
            </span>
          </button>

          {isSourcePreviewVisible && (
            <div
              id="sourcePreviewBody"
              className="source-preview-accordion-body"
            >
              <pre className="source-preview-content">{sourcePreviewText}</pre>
              {isSourcePreviewTruncated && (
                <p className="source-preview-footnote">
                  Preview đang hiển thị 3.200 ký tự đầu tiên để bạn kiểm tra
                  nhanh nội dung.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
