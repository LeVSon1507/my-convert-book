import { getCachedStoryAnalysis, setCachedStoryAnalysis } from "@/lib/cache";
import { estimateTokenCount } from "@/lib/cost";
import { requestChatCompletions } from "@/lib/chatApi";
import {
  MODEL_CONTEXT_LIMITS,
  ProviderId,
  extractAssistantText,
  getTailContext,
} from "@/lib/providers";

export type WritingStyle = "neutral" | "intense" | "dark" | "light" | "romantic" | "funny";

export type WritingBudgets = {
  sampleSize: number;
  lastChapterLength: number;
  previousTailLength: number;
};

export type WritingApiContext = {
  provider: ProviderId;
  model: string;
  apiKey: string;
  baseUrl: string;
  temperature: number;
};

export type WritingUsage = {
  promptTokens: number;
  completionTokens: number;
  totalCost: number;
};

type WritingResponseData = {
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

const ANALYSIS_WINDOW = 60000;
const ANALYSIS_CHUNK_SIZE = 6000;

const STYLE_INSTRUCTIONS: Record<WritingStyle, string> = {
  neutral: "",
  intense:
    "\n\nHƯỚNG VIẾT: Tăng sức căng thẳng, mâu thuẫn, và nhịp truyện. Mỗi câu phải đẩy tình huống đến giới hạn hơn. Cảm xúc nhân vật cần rõ ràng và sắc nét hơn.",
  dark: "\n\nHƯỚNG VIẾT: Tông tối hơn — áp bức, cô đơn, hoặc hiểm nguy nặng nề hơn. Vẫn phải hợp lý với tính cách nhân vật.",
  light:
    "\n\nHƯỚNG VIẾT: Nhẹ nhàng, ấm áp hơn. Giảm xung đột, tăng những khoảnh khắc bình yên, thú vị hoặc hài hòa giữa nhân vật.",
  romantic:
    "\n\nHƯỚNG VIẾT: Tăng phần romance — khoảng cách gần hơn giữa nhân vật, ánh mắt, cảm xúc ngầm, khoảnh khắc riêng tư. Không gượng ép.",
  funny:
    "\n\nHƯỚNG VIẾT: Hài hước hơn, dí dỏm hơn. Tình huống trớ trêu, câu nói bất ngờ. Vẫn phải phù hợp nhân vật và không phá vỡ mạch chính.",
};

function getMaxTokensForWriting(model: string, systemPrompt: string, userPrompt: string): number {
  const contextLimit = MODEL_CONTEXT_LIMITS[model] || 32000;
  const inputTokens = estimateTokenCount((systemPrompt || "").length + (userPrompt || "").length);
  const reservedTokens = Math.max(500, Math.floor(contextLimit * 0.12));
  const available = contextLimit - inputTokens - reservedTokens;
  const dynamicCap = Math.floor(available * 0.9);
  return Math.max(500, Math.min(3200, dynamicCap));
}

function parseUsage(responseData: WritingResponseData): WritingUsage {
  const usage = responseData.usage;
  if (!usage || typeof usage !== "object") {
    return { promptTokens: 0, completionTokens: 0, totalCost: 0 };
  }
  return {
    promptTokens: Number(usage.prompt_tokens) || 0,
    completionTokens: Number(usage.completion_tokens) || 0,
    totalCost: Number(usage.cost) || 0,
  };
}

export function addUsage(left: WritingUsage, right: WritingUsage): WritingUsage {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalCost: left.totalCost + right.totalCost,
  };
}

export function getWritingContextBudgets(modelName: string): WritingBudgets {
  const contextLimit = MODEL_CONTEXT_LIMITS[modelName] || 32000;
  if (contextLimit <= 32768) {
    return { sampleSize: 1200, lastChapterLength: 4500, previousTailLength: 1200 };
  }
  if (contextLimit <= 64000) {
    return { sampleSize: 1800, lastChapterLength: 7000, previousTailLength: 2000 };
  }
  return { sampleSize: 2500, lastChapterLength: 10000, previousTailLength: 3500 };
}

export function extractWritingContext(text: string, budgets: WritingBudgets): {
  styleSample: string;
  lastChapter: string;
} {
  const beginSample = text.slice(0, Math.min(budgets.sampleSize, text.length));
  let styleSample = `[ĐẦU TRUYỆN]\n${beginSample}`;

  if (text.length > budgets.sampleSize * 3) {
    const middleStart = Math.floor(text.length / 2) - Math.floor(budgets.sampleSize / 2);
    const middleSample = text.slice(middleStart, middleStart + budgets.sampleSize);
    const nearEndStart = Math.floor(text.length * 0.8);
    const nearEndSample = text.slice(nearEndStart, nearEndStart + budgets.sampleSize);
    styleSample += `\n\n[GIỮA TRUYỆN]\n${middleSample}`;
    styleSample += `\n\n[GẦN CUỐI TRUYỆN]\n${nearEndSample}`;
  }

  const lastChapter =
    text.length > budgets.lastChapterLength ? text.slice(-budgets.lastChapterLength) : text;
  return { styleSample, lastChapter };
}

function splitStoryForAnalysis(text: string): string[] {
  const chunks: string[] = [];
  let currentPosition = 0;

  while (currentPosition < text.length) {
    let endPosition = currentPosition + ANALYSIS_CHUNK_SIZE;
    if (endPosition < text.length) {
      const paragraphBreak = text.lastIndexOf("\n\n", endPosition);
      if (paragraphBreak > currentPosition + ANALYSIS_CHUNK_SIZE * 0.5) {
        endPosition = paragraphBreak + 2;
      }
    }
    chunks.push(text.slice(currentPosition, endPosition));
    currentPosition = endPosition;
  }

  return chunks;
}

async function callWritingApi(
  systemPrompt: string,
  userPrompt: string,
  ctx: WritingApiContext,
): Promise<{ text: string; usage: WritingUsage }> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 180000);
  const maxTokens = getMaxTokensForWriting(ctx.model, systemPrompt, userPrompt);
  const payload =
    ctx.provider === "ollama"
      ? {
          model: ctx.model,
          stream: false,
          keep_alive: "30m",
          options: {
            temperature: ctx.temperature,
            num_predict: maxTokens,
          },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }
      : {
          model: ctx.model,
          temperature: ctx.temperature,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        };

  try {
    const response = await requestChatCompletions(
      ctx.provider,
      ctx.baseUrl,
      ctx.apiKey,
      payload,
      controller.signal,
    );
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorBody}`);
    }

    const responseData = (await response.json()) as WritingResponseData;
    const text =
      ctx.provider === "ollama" && typeof responseData.message?.content === "string"
        ? responseData.message.content.trim()
        : extractAssistantText(responseData).trim();
    if (!text) throw new Error("Phản hồi API không hợp lệ — không có nội dung trả về");

    return { text, usage: parseUsage(responseData) };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("Timeout sau 180s");
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function buildAnalysisSystemPrompt(): string {
  return `Bạn là nhà phê bình văn học chuyên nghiệp. Nhiệm vụ: đọc đoạn truyện và trích xuất thông tin cấu trúc.

Trả về CHÍNH XÁC theo format sau (không thêm gì khác):

**SỰ KIỆN:** [Liệt kê các sự kiện chính xảy ra trong đoạn này, theo thứ tự thời gian]

**NHÂN VẬT:** [Tên nhân vật — mô tả ngắn về tính cách, vai trò, hành động trong đoạn này. Nếu có mối quan hệ mới được tiết lộ, ghi rõ]

**BỐI CẢNH:** [Địa điểm, thời gian, không gian diễn ra trong đoạn]

**CẢM XÚC:** [Tông cảm xúc chủ đạo: căng thẳng, lãng mạn, buồn, vui, kịch tính...]

**TUYẾN TRUYỆN:** [Các tuyến truyện đang mở hoặc phát triển trong đoạn này]`;
}

function buildConsolidationPrompt(chunkSummaries: string[]): string {
  const allSummaries = chunkSummaries.join("\n\n---\n\n");
  return `Dưới đây là phân tích các đoạn gần cuối của một truyện dài. Hãy tổng hợp thành BẢN PHÂN TÍCH HOÀN CHỈNH theo format:

**NGÔI KỂ & GIỌNG VĂN:**
- Ngôi kể: [ngôi thứ mấy? Gần gũi hay xa cách?]
- Đại từ chỉ nhân vật chính: ["anh" hay "hắn" hay "y" hay tên riêng?]
- Cách thể hiện suy nghĩ: [xen trực tiếp kiểu "Sao phải làm lớn chuyện đến thế?" hay miêu tả từ ngoài kiểu "Hắn cảm thấy khó chịu"?]
- Tone: [hóm hỉnh/nghiêm túc/nhẹ nhàng/nặng nề?]

**TÓM TẮT CỐT TRUYỆN GẦN ĐÂY:**
[Tóm tắt cốt truyện trong phần được phân tích, ~300 từ]

**HỒ SƠ NHÂN VẬT:**
[Với MỖI nhân vật quan trọng:]
- Tên: [tên]
- Cách xưng hô: [trong truyện gọi như thế nào? "anh", "hắn", "nàng", tên riêng?]
- Tính cách: [mô tả ngắn]
- Mối quan hệ: [quan hệ với các nhân vật khác]
- Tình trạng: [đang làm gì, ở đâu]

**CÁC TUYẾN TRUYỆN ĐANG MỞ:**
[Liệt kê các tuyến truyện chưa kết thúc]

=== CÁC BẢN PHÂN TÍCH TỪNG ĐOẠN ===
${allSummaries}
=== HẾT ===`;
}

export async function analyzeStoryForWriting(
  text: string,
  fileHash: string,
  ctx: WritingApiContext,
  onStatus: (status: string) => void,
  shouldStop: () => boolean,
): Promise<{ analysis: string | null; usage: WritingUsage }> {
  const cached = getCachedStoryAnalysis(fileHash);
  if (cached) {
    onStatus("Dùng lại bản phân tích cache.");
    return { analysis: cached, usage: { promptTokens: 0, completionTokens: 0, totalCost: 0 } };
  }

  const textToAnalyze = text.length > ANALYSIS_WINDOW ? text.slice(-ANALYSIS_WINDOW) : text;
  const chunks = splitStoryForAnalysis(textToAnalyze);
  let usage: WritingUsage = { promptTokens: 0, completionTokens: 0, totalCost: 0 };

  if (textToAnalyze.length < 20000) {
    onStatus("Phân tích trực tiếp...");
    const result = await callWritingApi(
      buildAnalysisSystemPrompt(),
      `Đây là đoạn 1/1 của truyện. Phân tích đoạn sau:\n\n${textToAnalyze}`,
      ctx,
    );
    usage = addUsage(usage, result.usage);
    if (fileHash) setCachedStoryAnalysis(fileHash, result.text);
    return { analysis: result.text, usage };
  }

  const summaries: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    if (shouldStop()) return { analysis: null, usage };
    onStatus(`Đang đọc ${index + 1}/${chunks.length} đoạn...`);
    const result = await callWritingApi(
      buildAnalysisSystemPrompt(),
      `Đây là đoạn ${index + 1}/${chunks.length} của truyện. Phân tích đoạn sau:\n\n${chunks[index]}`,
      ctx,
    );
    usage = addUsage(usage, result.usage);
    summaries.push(`[Đoạn ${index + 1}]\n${result.text}`);
  }

  if (shouldStop()) return { analysis: null, usage };
  onStatus("Đang tổng hợp phân tích...");
  const consolidated = await callWritingApi(
    "Bạn là nhà phê bình văn học. Nhiệm vụ: tổng hợp các bản phân tích từng đoạn thành MỘT bản phân tích tổng thể.",
    buildConsolidationPrompt(summaries),
    ctx,
  );
  usage = addUsage(usage, consolidated.usage);
  if (fileHash) setCachedStoryAnalysis(fileHash, consolidated.text);
  return { analysis: consolidated.text, usage };
}

export function buildContinueWritingSystemPrompt(
  styleSample: string,
  storyAnalysis: string | null,
  writingStyle: WritingStyle,
): string {
  let prompt = `Bạn là một nhà văn chuyên SAO CHÉP phong cách. Bạn KHÔNG sáng tạo giọng văn mới — bạn NHÁI CHÍNH XÁC giọng văn đã cho.

ĐIỀU QUAN TRỌNG NHẤT — NGÔI KỂ VÀ GIỌNG KỂ:
- XÁC ĐỊNH ngôi kể trong mẫu: ngôi thứ nhất ("tôi"), ngôi thứ ba gần ("anh"), hay ngôi thứ ba xa ("hắn")?
- DÙNG ĐÚNG đại từ cho nhân vật chính như mẫu: nếu mẫu gọi "anh" thì VIẾT "anh", KHÔNG đổi thành "hắn"
- COPY cách thể hiện suy nghĩ: nếu mẫu viết suy nghĩ trực tiếp xen trong văn ("Sao phải làm lớn chuyện đến thế?") thì bạn CŨNG viết kiểu đó, KHÔNG đổi thành "Hắn tự hỏi sao phải làm lớn chuyện"
- COPY khoảng cách người kể: nếu mẫu kể gần gũi như đang ở trong đầu nhân vật, bạn cũng kể gần như vậy

GIỌNG VĂN & NHỊP:
- Tone: SAO CHÉP — nếu mẫu hóm hỉnh thì hóm hỉnh, nếu nghiêm túc thì nghiêm túc
- Nhịp câu: ĐẾM câu dài/ngắn và giữ TỈ LỆ TƯƠNG TỰ
- Mật độ cảm xúc: Dùng ĐÚNG số lượng tính từ cảm xúc như mẫu. KHÔNG THÊM
- Cách xưng hô trong đối thoại: COPY chính xác

QUY TẮC KHÁC:
- Viết tiếp ĐÚNG nhịp truyện — KHÔNG tăng tốc, KHÔNG dồn nén
- KHÔNG tóm tắt, KHÔNG nhảy cóc thời gian
- CHỈ trả về nội dung truyện, KHÔNG giải thích, ghi chú
- KHÔNG bắt đầu bằng "Dưới đây là...", "Tiếp theo..."${STYLE_INSTRUCTIONS[writingStyle]}

=== MẪU VĂN PHONG ===
${styleSample}
=== HẾT MẪU ===`;

  if (storyAnalysis) {
    prompt += `

=== PHÂN TÍCH TÁC PHẨM ===
${storyAnalysis}
=== HẾT PHÂN TÍCH ===

Hãy sử dụng bản phân tích trên để:
- Dùng ĐÚNG đại từ/cách xưng hô của từng nhân vật như ghi trong phân tích
- Tiếp tục các tuyến truyện đang mở
- Giữ nhất quán với cốt truyện`;
  }

  return prompt;
}

export function buildContinueWritingUserPrompt(
  lastChapter: string,
  plotDirection: string,
  previousText: string,
  previousTailLength: number,
  writtenChunkCount: number,
): string {
  const previousTail = getTailContext(previousText, previousTailLength);
  let prompt = `Đây là đoạn cuối cùng của truyện:

=== ĐOẠN CUỐI ===
${lastChapter}
=== HẾT ===

`;

  if (previousTail) {
    prompt += `Đây là phần đuôi bạn đã viết tiếp trước đó (${writtenChunkCount} đoạn trước, chỉ đưa phần gần nhất để tránh lặp):

=== ĐUÔI PHẦN ĐÃ VIẾT ===
${previousTail}
=== HẾT ĐUÔI ===

`;
  }

  prompt += "Hãy viết tiếp khoảng 1500 từ, giữ ĐÚNG giọng văn và nhịp truyện của tác giả.";
  if (plotDirection) {
    prompt += `\n\nGợi ý hướng phát triển cốt truyện (chỉ là gợi ý, hãy triển khai tự nhiên theo nhịp truyện):\n${plotDirection}`;
  }
  prompt += `\n\nLưu ý QUAN TRỌNG — đọc kỹ:
- Viết tiếp TỰ NHIÊN ngay từ câu tiếp theo, không lặp lại nội dung đã có
- KHÔNG thêm cảm xúc, tính từ, miêu tả nội tâm NHIỀU HƠN tác giả gốc
- Giữ TỈ LỆ đối thoại vs miêu tả ĐÚNG như truyện gốc
- CHỈ trả về nội dung truyện, không ghi chú, không bình luận`;

  return prompt;
}

export async function continueWritingChunk(
  systemPrompt: string,
  userPrompt: string,
  ctx: WritingApiContext,
): Promise<{ text: string; usage: WritingUsage }> {
  return callWritingApi(systemPrompt, userPrompt, ctx);
}
