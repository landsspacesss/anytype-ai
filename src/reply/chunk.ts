export function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length === 0) return [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen);
    const nl = window.lastIndexOf("\n");
    const cut = nl > 0 ? nl : maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
