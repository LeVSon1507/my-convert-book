"use client";

import { useEffect, useMemo, useState } from "react";
import {
  deleteCloudFile,
  downloadCloudFileText,
  loadResumeCheckpoint,
} from "@/lib/firebase";
import { exportAs } from "@/lib/export";
import { useAuthStore } from "@/store/authStore";
import {
  TranslationResumeCheckpoint,
  useTranslationStore,
} from "@/store/translationStore";

const TRANSLATION_HISTORY_KEY = "translation_history_v1";

type LocalHistoryEntry = {
  historyId?: string;
  checkpointKey?: string;
  completedTextKey?: string;
  fileName?: string;
  model?: string;
  status?: string;
  totalChunks?: number;
  completedChunks?: number;
  completedAt?: number;
  updatedAt?: number;
};

type FirestoreTimestampLike = {
  seconds?: unknown;
};

function readLocalHistory(): LocalHistoryEntry[] {
  if (globalThis.window === undefined) return [];

  try {
    const parsed = JSON.parse(
      localStorage.getItem(TRANSLATION_HISTORY_KEY) || "[]",
    );
    return Array.isArray(parsed) ? (parsed as LocalHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function getTimestampSeconds(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const seconds = (value as FirestoreTimestampLike).seconds;
  return typeof seconds === "number" ? seconds : null;
}

function formatCloudDate(value: unknown): string {
  const seconds = getTimestampSeconds(value);
  return seconds ? new Date(seconds * 1000).toLocaleString("vi-VN") : "—";
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "") || "translated";
}

type HistoryWorkspaceProps = {
  onResume?: () => void;
};

function parseLocalCheckpoint(raw: string): TranslationResumeCheckpoint | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const translatedChunks = (parsed as { translatedChunks?: unknown })
    .translatedChunks;
  if (!Array.isArray(translatedChunks)) return null;
  return {
    translatedChunks: translatedChunks.map((chunk) =>
      typeof chunk === "string" ? chunk : null,
    ),
    totalChunks:
      Number((parsed as { totalChunks?: unknown }).totalChunks) ||
      translatedChunks.length,
  };
}

export function HistoryWorkspace({
  onResume,
}: Readonly<HistoryWorkspaceProps>) {
  const user = useAuthStore((s) => s.user);
  const cloudHistory = useAuthStore((s) => s.cloudHistory);
  const refreshCloudHistory = useAuthStore((s) => s.refreshCloudHistory);
  const resumeFromCheckpoint = useTranslationStore(
    (s) => s.resumeFromCheckpoint,
  );
  const [localHistory, setLocalHistory] = useState<LocalHistoryEntry[]>(() =>
    readLocalHistory(),
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (user) void refreshCloudHistory();
  }, [refreshCloudHistory, user]);

  const sortedLocalHistory = useMemo(
    () =>
      localHistory
        .slice()
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)),
    [localHistory],
  );

  async function downloadCloudItem(
    id: string,
    fileName: string,
    chunkCount: number,
  ) {
    if (!user) return;
    setMessage("");
    setError("");
    try {
      const text = await downloadCloudFileText(user.uid, id, chunkCount || 1);
      await exportAs([text], `${baseName(fileName)}_vietnamese`, "txt");
    } catch (downloadError) {
      setError(
        `Không tải được bản dịch cloud: ${
          downloadError instanceof Error
            ? downloadError.message
            : String(downloadError)
        }`,
      );
    }
  }

  async function deleteCloudItem(
    id: string,
    chunkCount: number,
    checkpointChunkCount: number,
  ) {
    if (!user) return;
    const confirmed = globalThis.confirm("Xóa bản dịch này khỏi cloud?");
    if (!confirmed) return;
    setMessage("");
    setError("");
    try {
      await deleteCloudFile(
        user.uid,
        id,
        chunkCount || 0,
        checkpointChunkCount || 0,
      );
      await refreshCloudHistory();
      setMessage("Đã xóa bản dịch cloud.");
    } catch (deleteError) {
      setError(
        `Không xóa được bản dịch cloud: ${
          deleteError instanceof Error
            ? deleteError.message
            : String(deleteError)
        }`,
      );
    }
  }

  async function resumeCloudItem(id: string, checkpointChunkCount: number) {
    if (!user) return;
    setMessage("");
    setError("");
    try {
      const checkpoint = await loadResumeCheckpoint(
        user.uid,
        id,
        checkpointChunkCount,
      );
      if (!checkpoint) {
        setError("Không tìm thấy checkpoint cloud để tiếp tục.");
        return;
      }
      resumeFromCheckpoint(checkpoint);
      setMessage("Đã nạp checkpoint cloud. Quay về tab Dịch mới để tiếp tục.");
      onResume?.();
    } catch (resumeError) {
      setError(
        `Không nạp được checkpoint cloud: ${
          resumeError instanceof Error
            ? resumeError.message
            : String(resumeError)
        }`,
      );
    }
  }

  async function downloadLocalItem(item: LocalHistoryEntry) {
    setMessage("");
    setError("");
    try {
      const fileName = item.fileName || "translated.txt";
      if (item.completedTextKey) {
        const text = localStorage.getItem(item.completedTextKey);
        if (text) {
          await exportAs([text], `${baseName(fileName)}_vietnamese`, "txt");
          return;
        }
      }

      if (!item.checkpointKey) {
        setError("Không tìm thấy dữ liệu local để tải.");
        return;
      }

      const raw = localStorage.getItem(item.checkpointKey);
      if (!raw) {
        setError("Checkpoint local không còn tồn tại.");
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      const translatedChunks =
        parsed &&
        typeof parsed === "object" &&
        Array.isArray(
          (parsed as { translatedChunks?: unknown }).translatedChunks,
        )
          ? (parsed as { translatedChunks: (string | null)[] }).translatedChunks
          : [];
      const chunks = translatedChunks.filter((chunk): chunk is string =>
        Boolean(chunk),
      );
      if (!chunks.length) {
        setError("Checkpoint local chưa có nội dung dịch.");
        return;
      }
      await exportAs(
        chunks,
        `${baseName(fileName)}_partial_${chunks.length}chunks_vietnamese`,
        "txt",
      );
    } catch (downloadError) {
      setError(
        `Không tải được bản dịch local: ${
          downloadError instanceof Error
            ? downloadError.message
            : String(downloadError)
        }`,
      );
    }
  }

  function resumeLocalItem(item: LocalHistoryEntry) {
    setMessage("");
    setError("");
    try {
      if (!item.checkpointKey) {
        setError("Bản ghi local này không có checkpoint để tiếp tục.");
        return;
      }
      const raw = localStorage.getItem(item.checkpointKey);
      if (!raw) {
        setError("Checkpoint local không còn tồn tại.");
        return;
      }
      const checkpoint = parseLocalCheckpoint(raw);
      if (!checkpoint) {
        setError("Checkpoint local không hợp lệ.");
        return;
      }
      resumeFromCheckpoint(checkpoint);
      setMessage("Đã nạp checkpoint local. Quay về tab Dịch mới để tiếp tục.");
      onResume?.();
    } catch (resumeError) {
      setError(
        `Không nạp được checkpoint local: ${
          resumeError instanceof Error
            ? resumeError.message
            : String(resumeError)
        }`,
      );
    }
  }

  function deleteLocalItem(item: LocalHistoryEntry) {
    const confirmed = globalThis.confirm("Xóa bản ghi lịch sử local?");
    if (!confirmed) return;
    setMessage("");
    setError("");
    try {
      if (item.completedTextKey) localStorage.removeItem(item.completedTextKey);
      if (item.checkpointKey) localStorage.removeItem(item.checkpointKey);
      const nextHistory = localHistory.filter(
        (historyItem) => historyItem.historyId !== item.historyId,
      );
      localStorage.setItem(
        TRANSLATION_HISTORY_KEY,
        JSON.stringify(nextHistory),
      );
      setLocalHistory(nextHistory);
      setMessage("Đã xóa bản ghi local.");
    } catch (deleteError) {
      setError(
        `Không xóa được lịch sử local: ${
          deleteError instanceof Error
            ? deleteError.message
            : String(deleteError)
        }`,
      );
    }
  }

  return (
    <div className="card">
      <div className="card-title">
        <span className="icon">↺</span> Lịch sử dịch
      </div>
      {message && <div className="alert alert-success visible">{message}</div>}
      {error && <div className="alert alert-error visible">{error}</div>}

      {user ? (
        <>
          <div className="history-section-label">
            Cloud — đồng bộ mọi thiết bị ({cloudHistory.length})
          </div>
          {cloudHistory.length ? (
            cloudHistory.map((item) => {
              const fileName = item.fileName || "unknown.txt";
              const completedChunks = Number(item.completedChunks) || 0;
              const totalChunks = Number(item.totalChunks) || 0;
              const isInProgress =
                item.status === "in_progress" ||
                (completedChunks > 0 && totalChunks > completedChunks);
              const chunkCount = Number(item.textChunkCount) || 0;
              const checkpointChunkCount =
                Number(item.checkpointChunkCount) || 0;

              return (
                <div className="history-item" key={item.id}>
                  <div className="history-item-info">
                    <div className="history-item-name" title={fileName}>
                      {fileName}
                    </div>
                    <div className="history-item-meta">
                      {formatCloudDate(item.updatedAt || item.completedAt)}
                      {item.model ? ` · ${String(item.model)}` : ""}
                      {totalChunks
                        ? ` · ${completedChunks}/${totalChunks} đoạn`
                        : ""}
                    </div>
                    <div className="history-item-meta">
                      {item.status || "completed"}
                      {isInProgress ? " · dở dang" : ""}
                    </div>
                  </div>
                  <div className="history-item-actions">
                    {isInProgress && checkpointChunkCount > 0 && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() =>
                          void resumeCloudItem(item.id, checkpointChunkCount)
                        }
                        type="button"
                      >
                        Tiếp tục
                      </button>
                    )}
                    <button
                      className="btn btn-secondary btn-sm"
                      disabled={!chunkCount}
                      onClick={() =>
                        void downloadCloudItem(item.id, fileName, chunkCount)
                      }
                      type="button"
                    >
                      Tải về
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() =>
                        void deleteCloudItem(
                          item.id,
                          chunkCount,
                          checkpointChunkCount,
                        )
                      }
                      type="button"
                    >
                      Xóa
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="history-empty">
              Chưa có bản dịch nào trên cloud.
              <br />
              <small>Bản dịch sẽ tự động lưu sau khi hoàn thành.</small>
            </div>
          )}
        </>
      ) : (
        <div className="history-empty">
          Đăng nhập để xem lịch sử cloud.
          <br />
          <small>Lịch sử local vẫn hiển thị bên dưới nếu có.</small>
        </div>
      )}

      <div className="history-section-label" style={{ marginTop: 18 }}>
        Chỉ trên thiết bị này
      </div>
      {sortedLocalHistory.length ? (
        sortedLocalHistory.map((item, index) => {
          const fileName = item.fileName || "unknown.txt";
          const completedChunks = Number(item.completedChunks) || 0;
          const totalChunks = Number(item.totalChunks) || 0;
          const timestamp = item.updatedAt || item.completedAt || 0;
          const when = timestamp
            ? new Date(timestamp).toLocaleString("vi-VN")
            : "—";
          return (
            <div
              className="history-item"
              key={item.historyId || `${fileName}-${index}`}
            >
              <div className="history-item-info">
                <div className="history-item-name">{fileName}</div>
                <div className="history-item-meta">
                  {when}
                  {item.model ? ` · ${item.model}` : ""}
                </div>
                <div className="history-item-meta">
                  {totalChunks
                    ? `${completedChunks}/${totalChunks} đoạn · `
                    : ""}
                  {item.status === "in_progress" ? "Dở dang" : "Hoàn tất"}
                </div>
              </div>
              <div className="history-item-actions">
                {item.status === "in_progress" && item.checkpointKey && (
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => resumeLocalItem(item)}
                    type="button"
                  >
                    Tiếp tục
                  </button>
                )}
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => void downloadLocalItem(item)}
                  type="button"
                >
                  Tải về
                </button>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => deleteLocalItem(item)}
                  type="button"
                >
                  Xóa
                </button>
              </div>
            </div>
          );
        })
      ) : (
        <div className="history-empty">
          Chưa có lịch sử local.
          <br />
          <small>Dịch xong một file để tạo bản ghi.</small>
        </div>
      )}
    </div>
  );
}
