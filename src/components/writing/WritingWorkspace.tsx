"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { exportAs, ExportFormat } from "@/lib/export";
import {
  WritingStyle,
  WritingUsage,
  addUsage,
  analyzeStoryForWriting,
  buildContinueWritingSystemPrompt,
  buildContinueWritingUserPrompt,
  continueWritingChunk,
  extractWritingContext,
  getWritingContextBudgets,
} from "@/lib/writing";
import { useAuthStore } from "@/store/authStore";
import { useTranslationStore } from "@/store/translationStore";

const WRITING_STYLES: { id: WritingStyle; label: string }[] = [
  { id: "neutral", label: "Giữ nguyên" },
  { id: "intense", label: "Căng hơn" },
  { id: "dark", label: "Tối hơn" },
  { id: "light", label: "Nhẹ hơn" },
  { id: "romantic", label: "Romance" },
  { id: "funny", label: "Hài hơn" },
];

const EXPORT_OPTIONS: { format: ExportFormat; label: string }[] = [
  { format: "txt", label: "TXT" },
  { format: "docx", label: "DOCX" },
  { format: "epub", label: "EPUB" },
];

function formatNumber(value: number): string {
  return value.toLocaleString("vi-VN");
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function emptyUsage(): WritingUsage {
  return { promptTokens: 0, completionTokens: 0, totalCost: 0 };
}

export function WritingWorkspace() {
  const stopRequestedRef = useRef(false);
  const provider = useTranslationStore((s) => s.provider);
  const apiKey = useTranslationStore((s) => s.apiKey);
  const baseUrl = useTranslationStore((s) => s.baseUrl);
  const fileContent = useTranslationStore((s) => s.fileContent);
  const fileName = useTranslationStore((s) => s.fileName);
  const currentFileHash = useTranslationStore((s) => s.currentFileHash);
  const getSelectedModel = useTranslationStore((s) => s.getSelectedModel);
  const systemPrompt = useTranslationStore((s) => s.systemPrompt);
  const glossaryInput = useTranslationStore((s) => s.glossaryInput);
  const delayBetweenChunks = useTranslationStore((s) => s.delayBetweenChunks);
  const user = useAuthStore((s) => s.user);
  const savePrompts = useAuthStore((s) => s.savePrompts);
  const loadPrompts = useAuthStore((s) => s.loadPrompts);

  const [chunkCount, setChunkCount] = useState(3);
  const [temperature, setTemperature] = useState(0.75);
  const [enableAnalysis, setEnableAnalysis] = useState(true);
  const [writingStyle, setWritingStyle] = useState<WritingStyle>("neutral");
  const [plotDirection, setPlotDirection] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [chunks, setChunks] = useState<string[]>([]);
  const [usage, setUsage] = useState<WritingUsage>(() => emptyUsage());
  const [processingChunkIndex, setProcessingChunkIndex] = useState<
    number | null
  >(null);

  const model = getSelectedModel();
  const resultText = chunks.join("\n\n");
  const hasFile = Boolean(fileContent);
  const canStart =
    hasFile &&
    Boolean(model) &&
    Boolean(baseUrl.trim()) &&
    (provider === "ollama" || Boolean(apiKey.trim()));

  const baseOutputName = useMemo(() => {
    const sourceName = fileName
      ? fileName.replace(/\.[^.]+$/, "")
      : "continued_story";
    return `${sourceName}_continued`;
  }, [fileName]);

  useEffect(() => {
    let cancelled = false;

    async function loadCloudPlotDirection() {
      if (!user) return;
      const prompts = await loadPrompts(provider);
      if (cancelled || !prompts?.plotDirection) return;
      setPlotDirection(prompts.plotDirection);
    }

    void loadCloudPlotDirection();
    return () => {
      cancelled = true;
    };
  }, [loadPrompts, provider, user]);

  async function persistPlotDirection() {
    if (!user) return;
    await savePrompts(provider, { systemPrompt, glossaryInput, plotDirection });
  }

  async function startWriting() {
    if (!fileContent) {
      setError("Vui lòng tải file truyện ở tab Dịch mới trước.");
      return;
    }
    if (provider !== "ollama" && !apiKey.trim()) {
      setError("Vui lòng nhập API key.");
      return;
    }
    if (!model) {
      setError("Vui lòng chọn hoặc nhập tên model.");
      return;
    }
    if (!baseUrl.trim()) {
      setError("Vui lòng nhập Base URL.");
      return;
    }

    stopRequestedRef.current = false;
    setIsRunning(true);
    setError("");
    setStatus("Chuẩn bị ngữ cảnh...");
    setChunks([]);
    setUsage(emptyUsage());
    await persistPlotDirection();

    const ctx = {
      provider,
      model,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      temperature,
    };
    const budgets = getWritingContextBudgets(model);
    const { styleSample, lastChapter } = extractWritingContext(
      fileContent,
      budgets,
    );

    try {
      let storyAnalysis: string | null = null;
      let nextUsage = emptyUsage();

      if (enableAnalysis) {
        setStatus("Đang phân tích truyện...");
        const analysisResult = await analyzeStoryForWriting(
          fileContent,
          currentFileHash,
          ctx,
          setStatus,
          () => stopRequestedRef.current,
        );
        storyAnalysis = analysisResult.analysis;
        nextUsage = addUsage(nextUsage, analysisResult.usage);
        setUsage(nextUsage);
      }

      if (stopRequestedRef.current) {
        setStatus("Đã dừng.");
        return;
      }

      const writingSystemPrompt = buildContinueWritingSystemPrompt(
        styleSample,
        storyAnalysis,
        writingStyle,
      );
      let accumulatedText = "";
      const nextChunks: string[] = [];

      for (let index = 0; index < chunkCount; index++) {
        if (stopRequestedRef.current) break;
        setStatus(`Đang viết đoạn ${index + 1}/${chunkCount}...`);
        const userPrompt = buildContinueWritingUserPrompt(
          lastChapter,
          plotDirection.trim(),
          accumulatedText,
          budgets.previousTailLength,
          nextChunks.length,
        );
        const result = await continueWritingChunk(
          writingSystemPrompt,
          userPrompt,
          ctx,
        );
        nextChunks.push(result.text);
        accumulatedText = nextChunks.join("\n\n");
        nextUsage = addUsage(nextUsage, result.usage);
        setChunks(nextChunks.slice());
        setUsage(nextUsage);

        if (
          delayBetweenChunks > 0 &&
          index < chunkCount - 1 &&
          !stopRequestedRef.current
        ) {
          await new Promise((resolve) =>
            window.setTimeout(resolve, delayBetweenChunks),
          );
        }
      }

      setStatus(stopRequestedRef.current ? "Đã dừng." : "Viết xong.");
    } catch (writingError) {
      setError(
        writingError instanceof Error
          ? writingError.message
          : String(writingError),
      );
      setStatus("Có lỗi khi viết tiếp.");
    } finally {
      setIsRunning(false);
    }
  }

  function stopWriting() {
    stopRequestedRef.current = true;
    setStatus("Đang dừng sau request hiện tại...");
  }

  async function downloadResult(format: ExportFormat) {
    if (!chunks.length) return;
    await exportAs(chunks, baseOutputName, format);
  }

  function getWritingApiContext() {
    return {
      provider,
      model,
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      temperature,
    };
  }

  function replaceChunk(
    index: number,
    nextText: string,
    nextUsage: WritingUsage,
  ) {
    setChunks((currentChunks) =>
      currentChunks.map((chunk, chunkIndex) =>
        chunkIndex === index ? nextText : chunk,
      ),
    );
    setUsage((currentUsage) => addUsage(currentUsage, nextUsage));
  }

  async function transformChunk(
    index: number,
    systemInstruction: string,
    userInstruction: string,
  ) {
    const originalText = chunks[index];
    if (!originalText) return;
    setProcessingChunkIndex(index);
    setError("");
    setStatus(`Đang chỉnh đoạn ${index + 1}...`);
    try {
      const result = await continueWritingChunk(
        systemInstruction,
        `${userInstruction}\n\n${originalText}`,
        getWritingApiContext(),
      );
      replaceChunk(index, result.text, result.usage);
      setStatus(`Đã chỉnh đoạn ${index + 1}.`);
    } catch (transformError) {
      setError(
        transformError instanceof Error
          ? transformError.message
          : String(transformError),
      );
      setStatus("Có lỗi khi chỉnh đoạn.");
    } finally {
      setProcessingChunkIndex(null);
    }
  }

  async function improveChunk(index: number) {
    if (!fileContent) return;
    const budgets = getWritingContextBudgets(model);
    const { styleSample } = extractWritingContext(fileContent, budgets);
    await transformChunk(
      index,
      `Bạn là biên tập viên. Nhiệm vụ: cải thiện đoạn văn dưới đây để GIỐNG giọng văn mẫu hơn.

KHÔNG thay đổi nội dung, cốt truyện, tình tiết. CHỈ cải thiện:
- Ngôi kể, đại từ cho đúng với mẫu
- Cách thể hiện suy nghĩ cho đúng với mẫu
- Giảm miêu tả cảm xúc thừa nếu mẫu không có
- Điều chỉnh tone cho khớp mẫu
- CHỈ trả về đoạn văn đã cải thiện, KHÔNG giải thích

=== MẪU VĂN PHONG ===
${styleSample}
=== HẾT MẪU ===`,
      "Cải thiện đoạn sau cho giống giọng văn mẫu hơn:",
    );
  }

  async function rewriteChunk(index: number) {
    if (!fileContent) return;
    setProcessingChunkIndex(index);
    setError("");
    setStatus(`Đang viết lại đoạn ${index + 1}...`);
    try {
      const budgets = getWritingContextBudgets(model);
      const { styleSample, lastChapter } = extractWritingContext(
        fileContent,
        budgets,
      );
      const previousText = chunks.slice(0, index).join("\n\n");
      const userPrompt = buildContinueWritingUserPrompt(
        lastChapter,
        plotDirection.trim(),
        previousText,
        budgets.previousTailLength,
        index,
      );
      const result = await continueWritingChunk(
        buildContinueWritingSystemPrompt(styleSample, null, writingStyle),
        userPrompt,
        getWritingApiContext(),
      );
      replaceChunk(index, result.text, result.usage);
      setStatus(`Đã viết lại đoạn ${index + 1}.`);
    } catch (rewriteError) {
      setError(
        rewriteError instanceof Error
          ? rewriteError.message
          : String(rewriteError),
      );
      setStatus("Có lỗi khi viết lại đoạn.");
    } finally {
      setProcessingChunkIndex(null);
    }
  }

  async function matchStyleChunk(index: number) {
    if (!fileContent) return;
    const budgets = getWritingContextBudgets(model);
    const { styleSample } = extractWritingContext(fileContent, budgets);
    await transformChunk(
      index,
      `Bạn là biên tập viên. Viết lại đoạn văn sau để bám sát hơn văn phong mẫu: ngôi kể, đại từ, nhịp câu, mật độ cảm xúc. KHÔNG thay đổi nội dung/tình tiết. CHỈ trả về đoạn văn đã viết lại.

=== MẪU VĂN PHONG ===
${styleSample}
=== HẾT MẪU ===`,
      "Viết lại đoạn văn sau bám sát văn phong mẫu hơn:",
    );
  }

  async function copyResult() {
    if (!resultText) return;
    await navigator.clipboard.writeText(resultText);
    setStatus("Đã sao chép nội dung viết tiếp.");
  }

  return (
    <>
      <div className="card writing-section visible">
        <div className="card-title">
          <span className="icon">✍</span> Viết tiếp truyện
        </div>
        <Image
          src="/undraw-img/undraw-writing-hero.svg"
          alt="Writing workspace illustration"
          className="illustration writing-hero-illustration"
          width={160}
          height={110}
          priority={false}
        />
        {!hasFile && (
          <div className="alert alert-warning visible">
            Hãy tải file truyện ở tab Dịch mới trước khi viết tiếp.
          </div>
        )}
        {error && <div className="alert alert-error visible">{error}</div>}

        <div className="writing-settings-grid">
          <div className="form-group">
            <label htmlFor="writingChunkCount">Số đoạn cần viết</label>
            <input
              id="writingChunkCount"
              max={20}
              min={1}
              onChange={(event) =>
                setChunkCount(
                  Math.max(1, Number.parseInt(event.target.value, 10) || 1),
                )
              }
              type="number"
              value={chunkCount}
            />
          </div>
          <div className="form-group">
            <label htmlFor="writingTemperature">
              Temperature:{" "}
              <span className="slider-value">{temperature.toFixed(2)}</span>
            </label>
            <input
              id="writingTemperature"
              max={1.2}
              min={0}
              onChange={(event) =>
                setTemperature(Number.parseFloat(event.target.value))
              }
              step={0.05}
              type="range"
              value={temperature}
            />
          </div>
        </div>

        <div className="form-group">
          <p className="writing-field-title">Phong cách</p>
          <div className="format-row">
            {WRITING_STYLES.map((style) => (
              <button
                className={`btn btn-secondary btn-sm writing-style-btn ${
                  writingStyle === style.id ? "active" : ""
                }`}
                key={style.id}
                onClick={() => setWritingStyle(style.id)}
                type="button"
              >
                {style.label}
              </button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label className="format-option">
            <input
              checked={enableAnalysis}
              onChange={(event) => setEnableAnalysis(event.target.checked)}
              type="checkbox"
            />
            <span>Phân tích cốt truyện trước khi viết</span>
          </label>
        </div>

        <div className="form-group">
          <label htmlFor="plotDirection">Gợi ý hướng phát triển</label>
          <textarea
            id="plotDirection"
            onBlur={() => void persistPlotDirection()}
            onChange={(event) => setPlotDirection(event.target.value)}
            placeholder="Ví dụ: đẩy xung đột ở chương sau, giữ nhịp chậm, tập trung vào nhân vật chính..."
            value={plotDirection}
          />
        </div>

        <div className="button-row">
          <button
            className="btn btn-writing"
            disabled={!canStart || isRunning}
            onClick={() => void startWriting()}
            type="button"
          >
            {isRunning ? <span className="spinner" /> : null}
            Viết tiếp
          </button>
          <button
            className="btn btn-danger"
            disabled={!isRunning}
            onClick={stopWriting}
            type="button"
          >
            Dừng
          </button>
        </div>
      </div>

      {(status || chunks.length > 0) && (
        <div className="card writing-section visible" id="writingResultSection">
          <div className="writing-result-header">
            <div className="card-title" style={{ marginBottom: 0 }}>
              <span className="icon">▣</span> Kết quả viết tiếp
            </div>
            {status && (
              <span className="writing-chunk-indicator">{status}</span>
            )}
          </div>

          <div className="progress-stats">
            <div className="progress-stat-card">
              <div className="stat-value">{formatNumber(chunks.length)}</div>
              <div className="stat-label">Đoạn</div>
            </div>
            <div className="progress-stat-card">
              <div className="stat-value">
                {formatNumber(usage.promptTokens)}
              </div>
              <div className="stat-label">Prompt</div>
            </div>
            <div className="progress-stat-card">
              <div className="stat-value">
                {formatNumber(usage.completionTokens)}
              </div>
              <div className="stat-label">Completion</div>
            </div>
            <div className="progress-stat-card">
              <div className="stat-value">
                {formatCurrency(usage.totalCost)}
              </div>
              <div className="stat-label">Chi phí</div>
            </div>
          </div>

          <div className="writing-output">
            {chunks.length ? (
              chunks.map((chunk, index) => (
                <div
                  className="writing-chunk-block"
                  key={`${index}-${chunk.slice(0, 16)}`}
                >
                  <div className="chunk-header">
                    <span>Đoạn {index + 1}</span>
                    <div className="chunk-actions">
                      <button
                        disabled={processingChunkIndex !== null}
                        onClick={() => void improveChunk(index)}
                        type="button"
                      >
                        Cải thiện
                      </button>
                      <button
                        disabled={processingChunkIndex !== null}
                        onClick={() => void rewriteChunk(index)}
                        type="button"
                      >
                        Viết lại
                      </button>
                      <button
                        disabled={processingChunkIndex !== null}
                        onClick={() =>
                          void transformChunk(
                            index,
                            "Bạn là biên tập viên. Mở rộng đoạn văn thêm khoảng 50%, giữ nguyên nội dung, phong cách và ngôi kể. CHỈ trả về đoạn văn đã mở rộng.",
                            "Mở rộng đoạn văn sau thêm khoảng 50%, giữ nguyên nội dung và phong cách:",
                          )
                        }
                        type="button"
                      >
                        Dài hơn
                      </button>
                      <button
                        disabled={processingChunkIndex !== null}
                        onClick={() =>
                          void transformChunk(
                            index,
                            "Bạn là biên tập viên. Tóm gọn đoạn văn khoảng 50%, giữ nguyên ý chính và phong cách. CHỈ trả về đoạn văn đã rút gọn.",
                            "Tóm gọn đoạn văn sau khoảng 50%, giữ nguyên ý chính:",
                          )
                        }
                        type="button"
                      >
                        Ngắn hơn
                      </button>
                      <button
                        disabled={processingChunkIndex !== null}
                        onClick={() =>
                          void transformChunk(
                            index,
                            "Bạn là biên tập viên. Thêm một đoạn hội thoại tự nhiên vào đoạn văn, phù hợp tình huống và nhân vật. CHỈ trả về đoạn văn đã chỉnh sửa.",
                            "Thêm một đoạn hội thoại tự nhiên vào đoạn văn sau, phù hợp tình huống:",
                          )
                        }
                        type="button"
                      >
                        Hội thoại
                      </button>
                      <button
                        disabled={processingChunkIndex !== null}
                        onClick={() =>
                          void transformChunk(
                            index,
                            "Bạn là biên tập viên. Thêm 1-2 câu miêu tả cảnh hoặc cảm xúc nhân vật vào đoạn văn, phù hợp văn phong tác giả. CHỈ trả về đoạn văn đã chỉnh sửa.",
                            "Thêm 1-2 câu miêu tả cảnh/cảm xúc vào đoạn văn sau:",
                          )
                        }
                        type="button"
                      >
                        Miêu tả
                      </button>
                      <button
                        disabled={processingChunkIndex !== null}
                        onClick={() => void matchStyleChunk(index)}
                        type="button"
                      >
                        Giữ văn phong
                      </button>
                    </div>
                  </div>
                  <div className="chunk-content">{chunk}</div>
                </div>
              ))
            ) : (
              <div className="history-empty">Chưa có nội dung viết tiếp.</div>
            )}
          </div>

          {chunks.length > 0 && (
            <div className="format-row format-row-lg" style={{ marginTop: 12 }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => void copyResult()}
                type="button"
              >
                Sao chép
              </button>
              {EXPORT_OPTIONS.map(({ format, label }) => (
                <button
                  className="btn btn-success btn-sm"
                  key={format}
                  onClick={() => void downloadResult(format)}
                  type="button"
                >
                  Tải {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
