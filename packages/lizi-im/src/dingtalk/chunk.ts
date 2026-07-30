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

  const chunks: string[] = [];
  let remaining = text;
  while (Array.from(remaining).length > maxChars) {
    const codepoints = Array.from(remaining);
    const window = codepoints.slice(0, maxChars).join("");
    const newline = window.lastIndexOf("\n");
    const splitAt =
      newline >= Math.floor(maxChars * 0.5) ? newline + 1 : window.length;
    const chunk = remaining.slice(0, splitAt).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
  }
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
