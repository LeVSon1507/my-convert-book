"use client";

import { useRef, useState } from "react";
import { useTranslationStore } from "@/store/translationStore";

export function FileUpload() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileName = useTranslationStore((s) => s.fileName);
  const fileSizeBytes = useTranslationStore((s) => s.fileSizeBytes);
  const fileContent = useTranslationStore((s) => s.fileContent);
  const loadFile = useTranslationStore((s) => s.loadFile);

  const sizeMB = (fileSizeBytes / 1024 / 1024).toFixed(2);
  const charCount = fileContent.length.toLocaleString("vi-VN");

  return (
    <div className="card">
      <div className="card-title">
        <span className="icon">📂</span> Chọn file truyện
      </div>

      <div
        className={`drop-zone ${fileName ? "has-file" : ""} ${isDragOver ? "drag-over" : ""}`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          const file = e.dataTransfer.files[0];
          if (file) loadFile(file);
        }}
      >
        <span className="drop-icon">{fileName ? "✅" : "📄"}</span>
        <div className="drop-title">{fileName || "Kéo thả file vào đây"}</div>
        <div className="drop-subtitle">
          {fileName ? `${sizeMB} MB · ${charCount} ký tự` : "hoặc click để chọn file · Hỗ trợ .txt, .md, .text"}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.text"
          style={{ display: "none" }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) loadFile(file);
          }}
        />
      </div>

      {fileName && (
        <div className="file-info visible">
          <strong>{fileName}</strong> — {sizeMB} MB ({charCount} ký tự)
        </div>
      )}
    </div>
  );
}
