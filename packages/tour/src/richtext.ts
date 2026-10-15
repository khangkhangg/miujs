// A tiny, safe "rich text" for info hotspots: paragraphs (blank line), line breaks,
// **bold**, *emphasis* and [text](https://link). Everything is escaped first and only these
// tags are produced, so the HTML can go straight into viewer tooltips.
import { escapeHtml } from "@miujs/web";

function inline(text: string): string {
  // Links first, on the raw text, so their URL is escaped exactly once.
  let out = "";
  const re = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)"'<>]{1,2000})\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out += emphasis(escapeHtml(text.slice(last, m.index)));
    out += `<a href="${escapeHtml(m[2])}" target="_blank" rel="noopener noreferrer">${emphasis(escapeHtml(m[1]))}</a>`;
    last = m.index + m[0].length;
  }
  return out + emphasis(escapeHtml(text.slice(last)));
}

function emphasis(escaped: string): string {
  return escaped.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
}

/** Render hotspot text as safe HTML. */
export function richText(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => `<p>${p.split("\n").map(inline).join("<br>")}</p>`)
    .join("");
}
