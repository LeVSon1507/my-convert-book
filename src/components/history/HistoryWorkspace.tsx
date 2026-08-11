"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import {
  deleteCloudFile,
  downloadCloudFileText,
  getCurrentIdToken,
  loadResumeCheckpoint,
} from "@/lib/firebase";
import { exportAs } from "@/lib/export";
import { useAuthStore } from "@/store/authStore";
import {
  TranslationResumeCheckpoint,
  useTranslationStore,
} from "@/store/translationStore";

type ActiveBackendJob = {
  id: string;
  fileName: string;
  totalChunks: number;
  done: number;
};

/** Jobs still running server-side (translationJobs collection) — a separate
 *  data model from the completed-only cloud history above, so this needs its
 *  own fetch. See src/lib/translationJobs.ts. */
async function fetchActiveBackendJobs(): Promise<ActiveBackendJob[]> {
  const idToken = await getCurrentIdToken();
  if (!idToken) return [];

  const listResponse = await fetch("/api/translate/jobs?status=running", {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!listResponse.ok) return [];
  const { jobs } = (await listResponse.json()) as {
    jobs?: { id: string; fileName: string; totalChunks: number }[];
  };
  if (!jobs?.length) return [];

  const withProgress = await Promise.all(
    jobs.map(async (job) => {
      const detailResponse = await fetch(`/api/translate/jobs/${job.id}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!detailResponse.ok) return { ...job, done: 0 };
      const { progress } = (await detailResponse.json()) as {
        progress?: { done?: number; permanentlyFailed?: number };
      };
      const done = (progress?.done ?? 0) + (progress?.permanentlyFailed ?? 0);
      return { ...job, done };
    }),
  );
  return withProgress;
}

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

type HistoryBadgeTone = "done" | "progress" | "failed";

type HistoryStatusBadge = {
  label: string;
  tone: HistoryBadgeTone;
  percent: number;
};

type HistoryGroup<RecordType> = {
  fileName: string;
  records: RecordType[];
};

function toPercent(completedCount: number, totalCount: number): number {
  if (!totalCount) return 0;
  return Math.max(
    0,
    Math.min(100, Math.round((completedCount / totalCount) * 100)),
  );
}

function resolveCloudStatusBadge(
  statusText: string,
  completedCount: number,
  totalCount: number,
): HistoryStatusBadge {
  const isFailedStatus = statusText === "error" || statusText === "failed";
  if (isFailedStatus) {
    return { label: "Failed", tone: "failed", percent: 0 };
  }

  const hasProgress =
    statusText === "in_progress" ||
    (totalCount > 0 && completedCount > 0 && completedCount < totalCount);
  if (hasProgress) {
    const progressLabel = totalCount
      ? `In Progress · ${completedCount}/${totalCount}`
      : "In Progress";
    return {
      label: progressLabel,
      tone: "progress",
      percent: toPercent(completedCount, totalCount),
    };
  }

  return { label: "Done · 100%", tone: "done", percent: 100 };
}

function resolveLocalStatusBadge(
  statusText: string,
  completedCount: number,
  totalCount: number,
): HistoryStatusBadge {
  if (statusText === "failed") {
    return { label: "Failed", tone: "failed", percent: 0 };
  }

  if (statusText === "in_progress") {
    const progressLabel = totalCount
      ? `In Progress · ${completedCount}/${totalCount}`
      : "In Progress";
    return {
      label: progressLabel,
      tone: "progress",
      percent: toPercent(completedCount, totalCount),
    };
  }

  return { label: "Done · 100%", tone: "done", percent: 100 };
}

function groupRecordsByFileName<RecordType extends { fileName?: string }>(
  records: RecordType[],
): HistoryGroup<RecordType>[] {
  const groupedRecords = new Map<string, RecordType[]>();

  records.forEach((recordValue) => {
    const fileNameValue =
      typeof recordValue.fileName === "string" && recordValue.fileName.trim()
        ? recordValue.fileName
        : "unknown.txt";
    const existingGroup = groupedRecords.get(fileNameValue) ?? [];
    existingGroup.push(recordValue);
    groupedRecords.set(fileNameValue, existingGroup);
  });

  return Array.from(groupedRecords.entries()).map(
    ([fileNameValue, groupedEntries]) => ({
      fileName: fileNameValue,
      records: groupedEntries,
    }),
  );
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
  const attachToBackendJob = useTranslationStore((s) => s.attachToBackendJob);
  const [localHistory, setLocalHistory] = useState<LocalHistoryEntry[]>(() =>
    readLocalHistory(),
  );
  const [activeJobs, setActiveJobs] = useState<ActiveBackendJob[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (user) void refreshCloudHistory();
  }, [refreshCloudHistory, user]);

  useEffect(() => {
    if (!user) return;
    void fetchActiveBackendJobs().then(setActiveJobs);
  }, [user]);

  const visibleActiveJobs = useMemo(
    () => (user ? activeJobs : []),
    [activeJobs, user],
  );

  async function viewActiveJobProgress(jobId: string) {
    await attachToBackendJob(jobId);
    onResume?.();
  }

  async function downloadActiveJobPartial(jobId: string, fileName: string) {
    if (!user) return;
    setMessage("");
    setError("");
    try {
      const idToken = await getCurrentIdToken();
      if (!idToken) throw new Error("Chưa đăng nhập.");
      const response = await fetch(`/api/translate/jobs/${jobId}/text`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { text } = (await response.json()) as { text?: string };
      if (!text) throw new Error("Chưa có đoạn nào dịch xong.");
      await exportAs([text], `${baseName(fileName)}_partial_vietnamese`, "txt");
    } catch (downloadError) {
      setError(
        `Không tải được bản dịch dở: ${
          downloadError instanceof Error
            ? downloadError.message
            : String(downloadError)
        }`,
      );
    }
  }

  const sortedLocalHistory = useMemo(
    () =>
      localHistory
        .slice()
        .sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)),
    [localHistory],
  );

  const groupedRunningJobs = useMemo(
    () =>
      groupRecordsByFileName(
        visibleActiveJobs.map((activeJob) => ({
          ...activeJob,
          fileName: activeJob.fileName,
        })),
      ),
    [visibleActiveJobs],
  );

  const groupedCloudHistory = useMemo(
    () =>
      groupRecordsByFileName(
        cloudHistory.map((cloudEntry) => ({
          ...cloudEntry,
          fileName:
            typeof cloudEntry.fileName === "string"
              ? cloudEntry.fileName
              : "unknown.txt",
        })),
      ),
    [cloudHistory],
  );

  const groupedLocalHistory = useMemo(
    () =>
      groupRecordsByFileName(
        sortedLocalHistory.map((localEntry) => ({
          ...localEntry,
          fileName:
            typeof localEntry.fileName === "string"
              ? localEntry.fileName
              : "unknown.txt",
        })),
      ),
    [sortedLocalHistory],
  );

  const hasCompletelyEmptyHistory =
    visibleActiveJobs.length === 0 &&
    cloudHistory.length === 0 &&
    sortedLocalHistory.length === 0;

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
    <div className="card history-dashboard-card">
      <div className="card-title">
        <span className="icon">↺</span> Lịch sử dịch
      </div>
      {message && <div className="alert alert-success visible">{message}</div>}
      {error && <div className="alert alert-error visible">{error}</div>}

      {hasCompletelyEmptyHistory ? (
        <div className="history-empty history-empty-hero">
          <Image
            src="/undraw-img/undraw-history-empty.svg"
            alt="History empty illustration"
            className="illustration history-empty-illustration"
            width={140}
            height={100}
            priority={false}
          />
          <div>
            Chưa có bản dịch nào trong lịch sử.
            <br />
            <small>
              {user
                ? "Dịch xong một file để bắt đầu lưu lịch sử cloud và local."
                : "Đăng nhập và dịch file đầu tiên để xem lịch sử tại đây."}
            </small>
          </div>
        </div>
      ) : (
        <>
          {user && groupedRunningJobs.length > 0 && (
            <>
              <div className="history-section-label">
                Đang chạy trên server ({visibleActiveJobs.length})
              </div>

              {groupedRunningJobs.map((runningGroup, runningGroupIndex) => (
                <details
                  className="history-group-card"
                  key={`${runningGroup.fileName}-${runningGroupIndex}`}
                  open
                >
                  <summary className="history-group-summary">
                    <span
                      className="history-group-title"
                      title={runningGroup.fileName}
                    >
                      {runningGroup.fileName}
                    </span>
                    <span className="history-group-summary-right">
                      <span className="history-status-badge progress">
                        In Progress
                      </span>
                      <span className="history-group-count">
                        {runningGroup.records.length} tiến trình
                      </span>
                    </span>
                  </summary>

                  <div className="history-group-body">
                    {runningGroup.records.map((runningJob) => {
                      const runningPercent = toPercent(
                        runningJob.done,
                        runningJob.totalChunks,
                      );
                      return (
                        <div className="history-row" key={runningJob.id}>
                          <div className="history-row-main">
                            <div className="history-row-title">
                              Job #{runningJob.id}
                            </div>
                            <div className="history-row-meta">
                              {runningJob.done}/{runningJob.totalChunks} đoạn
                            </div>
                            <div className="history-progress-mini">
                              <div
                                className="history-progress-mini-fill"
                                style={{ width: `${runningPercent}%` }}
                              />
                            </div>
                          </div>

                          <div className="history-row-actions">
                            <button
                              className="history-icon-btn"
                              onClick={() =>
                                void viewActiveJobProgress(runningJob.id)
                              }
                              type="button"
                              title="Xem tiến độ"
                              aria-label="Xem tiến độ"
                            >
                              👁
                            </button>
                            <button
                              className="history-icon-btn"
                              disabled={runningJob.done === 0}
                              onClick={() =>
                                void downloadActiveJobPartial(
                                  runningJob.id,
                                  runningJob.fileName,
                                )
                              }
                              type="button"
                              title="Tải tạm"
                              aria-label="Tải tạm"
                            >
                              ⬇
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </details>
              ))}
            </>
          )}

          {user ? (
            <>
              <div className="history-section-label">
                Cloud — đồng bộ mọi thiết bị ({cloudHistory.length})
              </div>
              {groupedCloudHistory.length > 0 ? (
                groupedCloudHistory.map((cloudGroup, cloudGroupIndex) => (
                  <details
                    className="history-group-card"
                    key={`${cloudGroup.fileName}-${cloudGroupIndex}`}
                    open={cloudGroupIndex === 0}
                  >
                    <summary className="history-group-summary">
                      <span
                        className="history-group-title"
                        title={cloudGroup.fileName}
                      >
                        {cloudGroup.fileName}
                      </span>
                      <span className="history-group-summary-right">
                        <span className="history-group-count">
                          {cloudGroup.records.length} bản lưu
                        </span>
                      </span>
                    </summary>

                    <div className="history-group-body">
                      {cloudGroup.records.map((cloudRecord) => {
                        const cloudRecordMeta = cloudRecord as Record<
                          string,
                          unknown
                        >;
                        const cloudModelRaw = cloudRecordMeta.model;
                        const cloudModelLabel =
                          typeof cloudModelRaw === "string"
                            ? cloudModelRaw
                            : "";
                        const completedChunkCount =
                          Number(cloudRecord.completedChunks) || 0;
                        const totalChunkCount =
                          Number(cloudRecord.totalChunks) || 0;
                        const statusText =
                          typeof cloudRecord.status === "string"
                            ? cloudRecord.status
                            : "completed";
                        const cloudBadge = resolveCloudStatusBadge(
                          statusText,
                          completedChunkCount,
                          totalChunkCount,
                        );
                        const textChunkCount =
                          Number(cloudRecord.textChunkCount) || 0;
                        const checkpointChunkCount =
                          Number(cloudRecord.checkpointChunkCount) || 0;
                        const canResumeCloudItem =
                          cloudBadge.tone === "progress" &&
                          checkpointChunkCount > 0;
                        const updatedAtValue = cloudRecordMeta.updatedAt;
                        const completedAtValue = cloudRecordMeta.completedAt;

                        return (
                          <div className="history-row" key={cloudRecord.id}>
                            <div className="history-row-main">
                              <div className="history-row-title">
                                {formatCloudDate(
                                  updatedAtValue || completedAtValue,
                                )}
                              </div>
                              <div className="history-row-meta">
                                {cloudModelLabel ? `${cloudModelLabel} · ` : ""}
                                {totalChunkCount
                                  ? `${completedChunkCount}/${totalChunkCount} đoạn`
                                  : "Không có số đoạn"}
                              </div>
                              <div
                                className={`history-status-badge ${cloudBadge.tone}`}
                              >
                                {cloudBadge.label}
                              </div>
                              {cloudBadge.tone === "progress" &&
                                totalChunkCount > 0 && (
                                  <div className="history-progress-mini">
                                    <div
                                      className="history-progress-mini-fill"
                                      style={{
                                        width: `${cloudBadge.percent}%`,
                                      }}
                                    />
                                  </div>
                                )}
                            </div>

                            <div className="history-row-actions">
                              {canResumeCloudItem && (
                                <button
                                  className="history-icon-btn"
                                  onClick={() =>
                                    void resumeCloudItem(
                                      cloudRecord.id,
                                      checkpointChunkCount,
                                    )
                                  }
                                  type="button"
                                  title="Tiếp tục"
                                  aria-label="Tiếp tục"
                                >
                                  ▶
                                </button>
                              )}
                              <button
                                className="history-icon-btn"
                                disabled={!textChunkCount}
                                onClick={() =>
                                  void downloadCloudItem(
                                    cloudRecord.id,
                                    cloudGroup.fileName,
                                    textChunkCount,
                                  )
                                }
                                type="button"
                                title="Tải về"
                                aria-label="Tải về"
                              >
                                ⬇
                              </button>
                              <button
                                className="history-icon-btn danger"
                                onClick={() =>
                                  void deleteCloudItem(
                                    cloudRecord.id,
                                    textChunkCount,
                                    checkpointChunkCount,
                                  )
                                }
                                type="button"
                                title="Xóa"
                                aria-label="Xóa"
                              >
                                🗑
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </details>
                ))
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

          <div className="history-section-label history-local-section-label">
            Chỉ trên thiết bị này
          </div>
          {groupedLocalHistory.length > 0 ? (
            groupedLocalHistory.map((localGroup, localGroupIndex) => (
              <details
                className="history-group-card"
                key={`${localGroup.fileName}-${localGroupIndex}`}
                open={localGroupIndex === 0}
              >
                <summary className="history-group-summary">
                  <span
                    className="history-group-title"
                    title={localGroup.fileName}
                  >
                    {localGroup.fileName}
                  </span>
                  <span className="history-group-summary-right">
                    <span className="history-group-count">
                      {localGroup.records.length} bản lưu
                    </span>
                  </span>
                </summary>

                <div className="history-group-body">
                  {localGroup.records.map((localRecord, localRecordIndex) => {
                    const localModelLabel =
                      typeof localRecord.model === "string"
                        ? localRecord.model
                        : "";
                    const completedChunkCount =
                      Number(localRecord.completedChunks) || 0;
                    const totalChunkCount =
                      Number(localRecord.totalChunks) || 0;
                    const localStatusText =
                      typeof localRecord.status === "string"
                        ? localRecord.status
                        : "completed";
                    const localBadge = resolveLocalStatusBadge(
                      localStatusText,
                      completedChunkCount,
                      totalChunkCount,
                    );
                    const updatedTimestamp =
                      localRecord.updatedAt || localRecord.completedAt || 0;
                    const updatedLabel = updatedTimestamp
                      ? new Date(updatedTimestamp).toLocaleString("vi-VN")
                      : "—";
                    const canResumeLocalItem =
                      localStatusText === "in_progress" &&
                      Boolean(localRecord.checkpointKey);

                    return (
                      <div
                        className="history-row"
                        key={
                          localRecord.historyId ||
                          `${localGroup.fileName}-${localRecordIndex}`
                        }
                      >
                        <div className="history-row-main">
                          <div className="history-row-title">
                            {updatedLabel}
                          </div>
                          <div className="history-row-meta">
                            {localModelLabel || "Model không xác định"}
                            {totalChunkCount
                              ? ` · ${completedChunkCount}/${totalChunkCount} đoạn`
                              : ""}
                          </div>
                          <div
                            className={`history-status-badge ${localBadge.tone}`}
                          >
                            {localBadge.label}
                          </div>
                          {localBadge.tone === "progress" &&
                            totalChunkCount > 0 && (
                              <div className="history-progress-mini">
                                <div
                                  className="history-progress-mini-fill"
                                  style={{ width: `${localBadge.percent}%` }}
                                />
                              </div>
                            )}
                        </div>

                        <div className="history-row-actions">
                          {canResumeLocalItem && (
                            <button
                              className="history-icon-btn"
                              onClick={() => resumeLocalItem(localRecord)}
                              type="button"
                              title="Tiếp tục"
                              aria-label="Tiếp tục"
                            >
                              ▶
                            </button>
                          )}
                          <button
                            className="history-icon-btn"
                            onClick={() => void downloadLocalItem(localRecord)}
                            type="button"
                            title="Tải về"
                            aria-label="Tải về"
                          >
                            ⬇
                          </button>
                          <button
                            className="history-icon-btn danger"
                            onClick={() => deleteLocalItem(localRecord)}
                            type="button"
                            title="Xóa"
                            aria-label="Xóa"
                          >
                            🗑
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </details>
            ))
          ) : (
            <div className="history-empty">
              Chưa có lịch sử local.
              <br />
              <small>Dịch xong một file để tạo bản ghi.</small>
            </div>
          )}
        </>
      )}
    </div>
  );
}
