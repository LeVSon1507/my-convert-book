import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { normalizeTranslatedChunks } from "./quality";

export type ExportFormat = "txt" | "docx" | "epub";

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function exportAsTxt(text: string, baseName: string): string {
  const fileName = `${baseName}.txt`;
  triggerDownload(new Blob([text], { type: "text/plain;charset=utf-8" }), fileName);
  return fileName;
}

async function exportAsDocx(chunks: string[], baseName: string, title: string): Promise<string> {
  const fileName = `${baseName}.docx`;
  const paragraphs: Paragraph[] = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];

  chunks.forEach((chunkText, chunkIndex) => {
    if (!chunkText) return;
    chunkText.split("\n").forEach((line) => {
      paragraphs.push(
        new Paragraph({
          children: [new TextRun({ text: line, size: 24, font: "Times New Roman" })],
          spacing: { after: line.trim() === "" ? 0 : 120 },
        }),
      );
    });
    if (chunkIndex < chunks.length - 1) paragraphs.push(new Paragraph({ text: "" }));
  });

  const document = new Document({ sections: [{ properties: {}, children: paragraphs }] });
  const blob = await Packer.toBlob(document);
  triggerDownload(blob, fileName);
  return fileName;
}

function escapeXmlText(line: string): string {
  return line.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function exportAsEpub(chunks: string[], baseName: string, title: string): Promise<string> {
  const fileName = `${baseName}.epub`;
  const zip = new JSZip();

  const bodyHtml = chunks
    .filter(Boolean)
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => `<p>${escapeXmlText(line)}</p>`)
        .join("\n"),
    )
    .join("\n");

  const chapterHtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="vi">
<head><meta charset="UTF-8"/><title>${title}</title>
<style>body{font-family:serif;font-size:1em;line-height:1.8;margin:5%;} h1{font-size:1.4em;margin-bottom:1em;} p{margin:0 0 0.8em;text-indent:1.5em;}</style>
</head><body>
<h1>${title}</h1>
${bodyHtml}
</body></html>`;

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
  <dc:title>${title}</dc:title><dc:language>vi</dc:language>
  <dc:identifier id="uid">${baseName}-${Date.now()}</dc:identifier>
</metadata>
<manifest>
  <item id="ch1" href="chapter.xhtml" media-type="application/xhtml+xml"/>
  <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
</manifest>
<spine toc="ncx"><itemref idref="ch1"/></spine>
</package>`;

  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${baseName}"/></head>
<docTitle><text>${title}</text></docTitle>
<navMap><navPoint id="np1" playOrder="1"><navLabel><text>${title}</text></navLabel>
<content src="chapter.xhtml"/></navPoint></navMap>
</ncx>`;

  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file("OEBPS/content.opf", opf);
  zip.file("OEBPS/toc.ncx", ncx);
  zip.file("OEBPS/chapter.xhtml", chapterHtml);

  const epubBlob = await zip.generateAsync({ type: "blob", mimeType: "application/epub+zip" });
  triggerDownload(epubBlob, fileName);
  return fileName;
}

export async function exportAs(
  chunks: (string | null | undefined)[],
  baseName: string,
  format: ExportFormat,
): Promise<string> {
  const normalizedChunks = normalizeTranslatedChunks(chunks);
  const title = baseName.replace(/_vietnamese$/, "").replaceAll("_", " ");

  if (format === "docx") return exportAsDocx(normalizedChunks, baseName, title);
  if (format === "epub") return exportAsEpub(normalizedChunks, baseName, title);
  return exportAsTxt(normalizedChunks.join("\n\n"), baseName);
}
