import { NextResponse } from "next/server";
import { after } from "next/server";
import { isNextResponse, requireUid, toPublicJob } from "@/lib/translateJobsApi";
import {
  createTranslationJob,
  listUserTranslationJobs,
  type TranslationJobStatus,
} from "@/lib/translationJobs";
import { runJobTick } from "@/lib/translationJobRunner";
import { buildGlossaryInstructionFromInput } from "@/lib/glossary";
import { splitIntoChapterChunks, splitIntoChunks } from "@/lib/chunking";
import { applyTranslationScope } from "@/lib/cost";
import { PROVIDER_CONFIGS, ProviderId } from "@/lib/providers";

const MAX_FILE_BYTES = 4_000_000;

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && value in PROVIDER_CONFIGS;
}

type CreateJobBody = {
  fileName?: unknown;
  fileContent?: unknown;
  fileHash?: unknown;
  provider?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  chunkSize?: unknown;
  concurrentRequests?: unknown;
  temperature?: unknown;
  delayBetweenChunks?: unknown;
  scopePercent?: unknown;
  enableChapterSplit?: unknown;
  systemPrompt?: unknown;
  glossaryInput?: unknown;
};

export async function POST(request: Request) {
  const uid = await requireUid(request);
  if (isNextResponse(uid)) return uid;

  let body: CreateJobBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Payload không hợp lệ." }, { status: 400 });
  }

  const provider = body.provider;
  if (!isProviderId(provider)) {
    return NextResponse.json({ error: "Provider không hợp lệ." }, { status: 400 });
  }
  if (provider === "ollama") {
    return NextResponse.json(
      {
        error:
          "Ollama chạy trên máy của bạn nên không thể dịch nền trên server. Hãy dùng luồng dịch tại trình duyệt cho Ollama.",
      },
      { status: 400 },
    );
  }

  const fileContent = typeof body.fileContent === "string" ? body.fileContent : "";
  if (!fileContent.trim()) {
    return NextResponse.json({ error: "Thiếu nội dung file." }, { status: 400 });
  }
  if (Buffer.byteLength(fileContent, "utf8") > MAX_FILE_BYTES) {
    return NextResponse.json(
      {
        error:
          "File quá lớn cho dịch nền (giới hạn ~4MB do Vercel). Hãy dùng luồng dịch tại trình duyệt cho file này.",
      },
      { status: 400 },
    );
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!model) return NextResponse.json({ error: "Thiếu model." }, { status: 400 });
  if (!baseUrl) return NextResponse.json({ error: "Thiếu Base URL." }, { status: 400 });
  if (!apiKey) return NextResponse.json({ error: "Thiếu API key." }, { status: 400 });

  const chunkSize = Number(body.chunkSize) || 8000;
  const concurrentRequests = Math.max(1, Math.min(200, Number(body.concurrentRequests) || 12));
  const temperature = Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 0.25;
  const delayBetweenChunks = Math.max(0, Number(body.delayBetweenChunks) || 0);
  const scopePercent = Number(body.scopePercent) || 100;
  const enableChapterSplit = Boolean(body.enableChapterSplit);
  const systemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt : "";
  const glossaryInput = typeof body.glossaryInput === "string" ? body.glossaryInput : "";
  const fileName = typeof body.fileName === "string" && body.fileName ? body.fileName : "unknown.txt";
  const fileHash = typeof body.fileHash === "string" ? body.fileHash : "";

  const splitResult = enableChapterSplit
    ? splitIntoChapterChunks(fileContent, chunkSize)
    : { chunks: splitIntoChunks(fileContent, chunkSize), chapterMap: [] };
  const chunks = applyTranslationScope(splitResult.chunks, scopePercent);
  if (chunks.length === 0) {
    return NextResponse.json({ error: "Không tách được đoạn nào từ file." }, { status: 400 });
  }

  const jobId = await createTranslationJob({
    uid,
    fileName,
    fileHash,
    provider,
    model,
    baseUrl,
    apiKey,
    chunkSize,
    concurrentRequests,
    temperature,
    delayBetweenChunks,
    scopePercent,
    systemPrompt,
    glossaryInstruction: buildGlossaryInstructionFromInput(glossaryInput),
    chunks,
    chapterMap: splitResult.chapterMap,
  });

  // Kick the first tick without holding up the response — the client starts
  // polling /api/translate/jobs/[jobId] immediately after this returns.
  after(() => runJobTick(jobId).catch((e) => console.error(`[job ${jobId}] initial tick failed`, e)));

  return NextResponse.json({ jobId });
}

export async function GET(request: Request) {
  const uid = await requireUid(request);
  if (isNextResponse(uid)) return uid;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") as TranslationJobStatus | null;
  const jobs = await listUserTranslationJobs(uid, status ?? undefined);
  return NextResponse.json({ jobs: jobs.map(toPublicJob) });
}
