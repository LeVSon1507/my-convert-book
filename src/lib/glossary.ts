export type GlossaryPair = { source: string; target: string };

export function parseGlossaryInput(rawGlossaryText: string): GlossaryPair[] {
  return String(rawGlossaryText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => {
      let arrow: string | null = null;
      if (line.includes("=>")) {
        arrow = "=>";
      } else if (line.includes("->")) {
        arrow = "->";
      }

      if (!arrow) return [];
      const [source, ...rest] = line.split(arrow);
      const target = rest.join(arrow).trim();
      return source.trim() && target ? [{ source: source.trim(), target }] : [];
    });
}

export function buildGlossaryInstruction(pairs: GlossaryPair[]): string {
  if (!pairs.length) return "";
  const rows = pairs
    .map((pair) => `- ${pair.source} => ${pair.target}`)
    .join("\n");
  return `\n\nGLOSSARY BẮT BUỘC — dùng đúng mapping sau, không được tự ý đổi tên riêng:\n${rows}\n- TUYỆT ĐỐI dùng đúng tên ở trên, giữ nguyên mọi đoạn.`;
}

export function buildGlossaryInstructionFromInput(rawGlossaryText: string): string {
  return buildGlossaryInstruction(parseGlossaryInput(rawGlossaryText));
}
