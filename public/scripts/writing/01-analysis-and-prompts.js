    /* ===== Continue Writing Feature ===== */

    let isWritingStopped = false;
    let continuedChunks = [];
    let cachedStoryAnalysis = null;

    function getWritingContextBudgets(modelName) {
      const contextLimit = MODEL_CONTEXT_LIMITS[modelName] || 32000;

      if (contextLimit <= 32768) {
        return { sampleSize: 1200, lastChapterLength: 4500, previousTailLength: 1200 };
      }
      if (contextLimit <= 64000) {
        return { sampleSize: 1800, lastChapterLength: 7000, previousTailLength: 2000 };
      }
      return { sampleSize: 2500, lastChapterLength: 10000, previousTailLength: 3500 };
    }

    function extractWritingContext(text, budgets) {
      const SAMPLE_SIZE = budgets?.sampleSize || 2500;
      const LAST_CHAPTER_LENGTH = budgets?.lastChapterLength || 10000;

      // Lấy 3 mẫu văn phong: đầu, giữa, cuối
      const beginSample = text.slice(0, Math.min(SAMPLE_SIZE, text.length));

      let styleSample = `[ĐẦU TRUYỆN]\n${beginSample}`;

      if (text.length > SAMPLE_SIZE * 3) {
        const middleStart = Math.floor(text.length / 2) - Math.floor(SAMPLE_SIZE / 2);
        const middleSample = text.slice(middleStart, middleStart + SAMPLE_SIZE);
        styleSample += `\n\n[GIỮA TRUYỆN]\n${middleSample}`;

        const nearEndStart = Math.floor(text.length * 0.8);
        const nearEndSample = text.slice(nearEndStart, nearEndStart + SAMPLE_SIZE);
        styleSample += `\n\n[GẦN CUỐI TRUYỆN]\n${nearEndSample}`;
      }

      // Chỉ giữ cửa sổ ngữ cảnh gần cuối để giảm token lặp.
      const lastChapter = text.length > LAST_CHAPTER_LENGTH
        ? text.slice(-LAST_CHAPTER_LENGTH)
        : text;

      return { styleSample, lastChapter };
    }

    /* --- Story Pre-Analysis --- */

    function splitStoryForAnalysis(text) {
      const ANALYSIS_CHUNK_SIZE = 6000;
      const analysisChunks = [];
      let currentPosition = 0;

      while (currentPosition < text.length) {
        let endPosition = currentPosition + ANALYSIS_CHUNK_SIZE;

        if (endPosition < text.length) {
          const paragraphBreak = text.lastIndexOf('\n\n', endPosition);
          if (paragraphBreak > currentPosition + ANALYSIS_CHUNK_SIZE * 0.5) {
            endPosition = paragraphBreak + 2;
          }
        }

        analysisChunks.push(text.slice(currentPosition, endPosition));
        currentPosition = endPosition;
      }

      return analysisChunks;
    }

    async function analyzeChunkContent(chunkText, chunkNumber, totalAnalysisChunks) {
      const systemPrompt = `Bạn là nhà phê bình văn học chuyên nghiệp. Nhiệm vụ: đọc đoạn truyện và trích xuất thông tin cấu trúc.

Trả về CHÍNH XÁC theo format sau (không thêm gì khác):

**SỰ KIỆN:** [Liệt kê các sự kiện chính xảy ra trong đoạn này, theo thứ tự thời gian]

**NHÂN VẬT:** [Tên nhân vật — mô tả ngắn về tính cách, vai trò, hành động trong đoạn này. Nếu có mối quan hệ mới được tiết lộ, ghi rõ]

**BỐI CẢNH:** [Địa điểm, thời gian, không gian diễn ra trong đoạn]

**CẢM XÚC:** [Tông cảm xúc chủ đạo: căng thẳng, lãng mạn, buồn, vui, kịch tính...]

**TUYẾN TRUYỆN:** [Các tuyến truyện đang mở hoặc phát triển trong đoạn này]`;

      const userPrompt = `Đây là đoạn ${chunkNumber}/${totalAnalysisChunks} của truyện. Phân tích đoạn sau:\n\n${chunkText}`;

      return await callWritingApi(systemPrompt, userPrompt);
    }

    async function consolidateAnalysis(chunkSummaries) {
      const allSummaries = chunkSummaries.join('\n\n---\n\n');

      const systemPrompt = `Bạn là nhà phê bình văn học. Nhiệm vụ: tổng hợp các bản phân tích từng đoạn thành MỘT bản phân tích tổng thể.`;

       const userPrompt = `Dưới đây là phân tích các đoạn gần cuối của một truyện dài. Hãy tổng hợp thành BẢN PHÂN TÍCH HOÀN CHỈNH theo format:

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

      return await callWritingApi(systemPrompt, userPrompt);
    }

    async function analyzeFullStory(text, updateStatusCallback) {
      // Chỉ phân tích 60K ký tự cuối thay vì toàn bộ — tiết kiệm API và hiệu quả hơn
      const ANALYSIS_WINDOW = 60000;
      const textToAnalyze = text.length > ANALYSIS_WINDOW
        ? text.slice(-ANALYSIS_WINDOW)
        : text;

      const analysisChunks = splitStoryForAnalysis(textToAnalyze);
      const totalAnalysisChunks = analysisChunks.length;

      if (textToAnalyze.length < 20000) {
        updateStatusCallback('Phân tích trực tiếp...');
        const directAnalysis = await analyzeChunkContent(textToAnalyze, 1, 1);
        return directAnalysis;
      }

      const chunkResults = new Array(totalAnalysisChunks).fill(null);
      let nextAnalysisIndex = 0;
      let completedAnalysisCount = 0;
      let activeAnalysisRequests = 0;
      let analysisScheduleTimer = null;
      isAnalysisRunning = true;

      updateStatusCallback(`Đang đọc ${totalAnalysisChunks} đoạn (song song động, có thể đổi khi đang chạy)...`);

      try {
        await new Promise(function(resolve) {
          function queueSchedule(delayMs) {
            if (analysisScheduleTimer !== null) return;
            analysisScheduleTimer = setTimeout(function() {
              analysisScheduleTimer = null;
              scheduleAnalysis();
            }, delayMs);
          }

          function maybeResolve() {
            if ((isWritingStopped || nextAnalysisIndex >= totalAnalysisChunks) && activeAnalysisRequests === 0) {
              resolve();
              return true;
            }
            return false;
          }

          function launchAnalysis(indexToAnalyze) {
            activeAnalysisRequests++;

            (async function() {
              try {
                const summary = await analyzeChunkContent(
                  analysisChunks[indexToAnalyze],
                  indexToAnalyze + 1,
                  totalAnalysisChunks
                );
                chunkResults[indexToAnalyze] = `[Đoạn ${indexToAnalyze + 1}]\n${summary}`;
              } catch (analysisError) {
                chunkResults[indexToAnalyze] = `[Đoạn ${indexToAnalyze + 1}] — Lỗi: ${analysisError.message}`;
              }

              completedAnalysisCount++;
              updateStatusCallback(`Đã đọc ${completedAnalysisCount}/${totalAnalysisChunks} đoạn...`);
            })().finally(function() {
              activeAnalysisRequests--;
              scheduleAnalysis();
            });
          }

          function scheduleAnalysis() {
            if (maybeResolve()) return;

            const desiredConcurrency = getRuntimeConcurrentRequests();
            while (!isWritingStopped && activeAnalysisRequests < desiredConcurrency && nextAnalysisIndex < totalAnalysisChunks) {
              launchAnalysis(nextAnalysisIndex);
              nextAnalysisIndex++;
            }

            if (maybeResolve()) return;

            if (!isWritingStopped && nextAnalysisIndex < totalAnalysisChunks && activeAnalysisRequests < getRuntimeConcurrentRequests()) {
              queueSchedule(120);
            }
          }

          scheduleAnalysis();
        });

        if (isWritingStopped) return null;

        const chunkSummaries = chunkResults.filter(Boolean);
        updateStatusCallback('Đang tổng hợp phân tích...');
        return await consolidateAnalysis(chunkSummaries);
      } finally {
        isAnalysisRunning = false;
      }
    }

    /* --- Prompt Builders --- */

    function buildContinueWritingSystemPrompt(styleSample, storyAnalysis) {
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

LỖI PHỔ BIẾN — TUYỆT ĐỐI KHÔNG LÀM:
❌ Mẫu dùng "anh" cho nhân vật chính → BẠN đổi thành "hắn" ← SAI, sai ngôi kể
❌ Mẫu viết suy nghĩ trực tiếp: "Thật tài giỏi quá!" → BẠN đổi thành: "Hắn cảm thấy thán phục" ← SAI, sai cách thể hiện
❌ Mẫu kể nhẹ nhàng, hóm hỉnh → BẠN viết u ám, drama ← SAI, sai tone
❌ Mẫu miêu tả hành động giản dị → BẠN thêm bầu không khí, ánh sáng, cảm xúc ← SAI
❌ Mẫu không miêu tả ngoại hình chi tiết → BẠN thêm "váy ngắn ôm sát, ngực cao" ← SAI

QUY TẮC VÀNG — ĐỌc lại mẫu, ĐẾM:
- Nhân vật chính được gọi là gì? → Dùng ĐÚNG từ đó
- Suy nghĩ được viết kiểu gì? → COPY kiểu đó
- Bao nhiêu dòng đối thoại vs miêu tả? → Giữ ĐÚNG tỉ lệ
- Có miêu tả bầu không khí/ánh sáng không? → Chỉ thêm nếu mẫu có

QUY TẮC KHÁC:
- Viết tiếp ĐÚNG nhịp truyện — KHÔNG tăng tốc, KHÔNG dồn nén
- KHÔNG tóm tắt, KHÔNG nhảy cóc thời gian
- CHỈ trả về nội dung truyện, KHÔNG giải thích, ghi chú
- KHÔNG bắt đầu bằng "Dưới đây là...", "Tiếp theo..."

=== MẪU VĂN PHONG (HÃY NHÁI CHÍNH XÁC NGÔI KỂ, GIỌNG KỂ, ĐẠI TỪ) ===
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

    function buildContinueWritingUserPrompt(lastChapter, plotDirection, previousTail, writtenChunkCount) {
      let prompt = `Đây là đoạn cuối cùng của truyện:\n\n=== ĐOẠN CUỐI ===\n${lastChapter}\n=== HẾT ===\n\n`;

      if (previousTail) {
        prompt += `Đây là phần đuôi bạn đã viết tiếp trước đó (${writtenChunkCount} đoạn trước, chỉ đưa phần gần nhất để tránh lặp):\n\n=== ĐUÔI PHẦN ĐÃ VIẾT ===\n${previousTail}\n=== HẾT ĐUÔI ===\n\n`;
      }

      prompt += `Hãy viết tiếp khoảng 1500 từ, giữ ĐÚNG giọng văn và nhịp truyện của tác giả.`;

      if (plotDirection) {
        prompt += `\n\nGợi ý hướng phát triển cốt truyện (chỉ là gợi ý, hãy triển khai tự nhiên theo nhịp truyện):\n${plotDirection}`;
      }

      prompt += `\n\nLưu ý QUAN TRỌNG — đọc kỹ:
- Viết tiếp TỰ NHIÊN ngay từ câu tiếp theo, không lặp lại nội dung đã có
- KHÔNG thêm cảm xúc, tính từ, miêu tả nội tâm NHIỀU HƠN tác giả gốc
- Nếu tác giả gốc viết "Cô ấy đi ra ngoài" — KHÔNG viết "Cô ấy đi ra ngoài, lòng nặng trĩu nỗi buồn"
- Giữ TỈ LỆ đối thoại vs miêu tả ĐÚNG như truyện gốc
- CHỈ trả về nội dung truyện, không ghi chú, không bình luận`;

      return prompt;
    }

