// ===== Chapter Detection & Chapter-Aware Splitting =====

var CHAPTER_PATTERNS = [
  /^\u7b2c\s*[\d\u96f6\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07]+\s*[\u7ae0\u5377\u8282\u56de\u7bc7]/,
  /^[Cc]hapter\s+\d+/,
  /^CHAPTER\s+\d+/,
  /^[Pp]art\s+\d+/,
  /^\u5377[\d\u96f6\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07]+/,
  /^\u7b2c[\d\u96f6\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07]+\u56de/,
  /^(?:\u5e8f\u7ae0|\u524d\u8a00|\u5c3e\u58f0|\u540e\u8bb0|\u756a\u5916\d*)/,
  /^(?:Prologue|Epilogue)/i,
];

function detectChapters(text) {
  var boundaries = [];
  var lines = text.split("\n");
  var offset = 0;

  for (var i = 0; i < lines.length; i++) {
    var rawLine = lines[i];
    var trimmed = rawLine.replace(/\r$/, "").trim();
    var lineOffset = offset;
    offset += rawLine.length + 1; // +1 for the \n

    if (!trimmed) continue;

    var isChapterLine = CHAPTER_PATTERNS.some(function (re) {
      return re.test(trimmed);
    });
    if (!isChapterLine) continue;

    // Must be preceded by a blank line (or be the very first content)
    var prevTrimmed = i > 0 ? lines[i - 1].replace(/\r$/, "").trim() : "";
    if (prevTrimmed === "") {
      boundaries.push({ offset: lineOffset, title: trimmed });
    }
  }

  return {
    found: boundaries.length >= 2,
    count: boundaries.length,
    boundaries: boundaries,
  };
}

function splitIntoChapterChunks(text, chunkSize) {
  var detection = detectChapters(text);

  if (!detection.found) {
    var fallbackChunks = splitIntoChunks(text, chunkSize);
    return {
      chunks: fallbackChunks,
      chapterMap: fallbackChunks.map(function (_, i) {
        return { chunkIndex: i, chapterIndex: 0, chapterTitle: "" };
      }),
    };
  }

  var chunks = [];
  var chapterMap = [];
  var boundaries = detection.boundaries;

  function pushChapter(chapterText, chapterIndex, chapterTitle) {
    if (!chapterText.trim()) return;
    if (chapterText.length <= chunkSize) {
      var ci = chunks.length;
      chunks.push(chapterText);
      chapterMap.push({
        chunkIndex: ci,
        chapterIndex: chapterIndex,
        chapterTitle: chapterTitle,
      });
    } else {
      var subChunks = splitIntoChunks(chapterText, chunkSize);
      subChunks.forEach(function (sub, subIdx) {
        var ci2 = chunks.length;
        chunks.push(sub);
        chapterMap.push({
          chunkIndex: ci2,
          chapterIndex: chapterIndex,
          chapterTitle:
            subIdx === 0
              ? chapterTitle
              : chapterTitle + " (ti\u1ebfp " + (subIdx + 1) + ")",
        });
      });
    }
  }

  // Handle preamble (text before first chapter)
  if (boundaries[0].offset > 0) {
    var preamble = text.slice(0, boundaries[0].offset);
    pushChapter(preamble, 0, "\u5e8f");
  }

  // Handle each chapter
  for (var ci = 0; ci < boundaries.length; ci++) {
    var start = boundaries[ci].offset;
    var end =
      ci + 1 < boundaries.length ? boundaries[ci + 1].offset : text.length;
    var chapterText = text.slice(start, end);
    pushChapter(chapterText, ci + 1, boundaries[ci].title);
  }

  return { chunks: chunks, chapterMap: chapterMap };
}
