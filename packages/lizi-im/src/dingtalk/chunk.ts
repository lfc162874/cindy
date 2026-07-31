const DEFAULT_MAX_CHARS = 3_500;

/** Split long Markdown replies without cutting Unicode surrogate pairs. */
export function chunkDingTalkMarkdown(
  markdown: string,
  maxChars = DEFAULT_MAX_CHARS,
): string[] {
  const text = markdown.trim();
  if (!text) return [];
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error("DINGTALK_INVALID_CHUNK_SIZE");
  }

  // Keep one Unicode code-point array and advance a cursor; rebuilding the
  // remaining suffix on every iteration made long replies repeatedly rescan
  // their already-processed prefix.
  const codepoints = Array.from(text);
  const chunks: string[] = [];
  let start = 0;
  while (codepoints.length - start > maxChars) {
    const windowCodepoints = codepoints.slice(start, start + maxChars);
    const window = windowCodepoints.join("");
    const newline = window.lastIndexOf("\n");
    const splitAtCodepoints =
      newline >= Math.floor(maxChars * 0.5)
        ? windowCodepoints.lastIndexOf("\n") + 1
        : windowCodepoints.length;
    const chunk = windowCodepoints.slice(0, splitAtCodepoints).join("").trim();
    if (chunk) chunks.push(chunk);
    start += splitAtCodepoints;
    while (
      start < codepoints.length &&
      codepoints[start].trimStart() === ""
    ) {
      start += 1;
    }
  }
  const remaining = codepoints.slice(start).join("");
  if (remaining) chunks.push(remaining);
  return chunks;
}

/** Do not expose Cindy-local media URLs to an external IM client. */
export function sanitizeDingTalkMarkdown(markdown: string): string {
  return markdown
    .replace(
      /!\[([^\]]*)\]\((?:xdt-image|cindy-media):\/\/[^)]+\)/gi,
      (_match, alt: string) =>
        alt ? `[${alt}：图片暂不支持发送]` : "[图片暂不支持发送]",
    )
    .replace(/\[([^\]]+)\]\(xdt-file:\/\/[^)]+\)/gi, "[$1：文件暂不支持发送]");
}
