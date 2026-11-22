import type { ReactNode } from "react";

/**
 * A small, safe markdown renderer for plugin READMEs. It builds React elements only (never HTML strings), so raw HTML in a README
 * shows as plain text. Supports headings, paragraphs, lists, code blocks, quotes, rules, **bold**, *italic*, `code` and links
 * (only http, https and mailto; anything else shows as text).
 */
const SAFE = /^(https?:|mailto:)/i;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(tok.slice(1, -1), k)}</em>);
    else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      out.push(SAFE.test(lm[2]!)
        ? <a key={k} href={lm[2]} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">{lm[1]}</a>
        : <span key={k}>{lm[1]}</span>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = () => `b${n++}`;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) buf.push(lines[i++]!);
      i++;
      blocks.push(<pre key={key()} tabIndex={0} className="overflow-auto rounded-lg bg-muted p-2.5 font-mono text-[12px] leading-snug"><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1]!.length;
      const k = key();
      blocks.push(<div key={k} role="heading" aria-level={Math.min(lvl + 2, 6)} className={lvl <= 1 ? "mt-1 text-[15px] font-semibold" : "mt-3 text-[13.5px] font-semibold"}>{inline(h[2]!, k)}</div>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
      const k = key();
      const Tag = ordered ? "ol" : "ul";
      blocks.push(<Tag key={k} className={`flex flex-col gap-1 pl-5 ${ordered ? "list-decimal" : "list-disc"}`}>{items.map((it, j) => <li key={j}>{inline(it, `${k}-${j}`)}</li>)}</Tag>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) buf.push(lines[i++]!.replace(/^>\s?/, ""));
      const k = key();
      blocks.push(<blockquote key={k} className="rounded-lg bg-muted/60 px-3 py-2 text-muted-foreground">{inline(buf.join(" "), k)}</blockquote>);
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push(<hr key={key()} className="border-border" />); i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(```|#{1,6}\s|\s*([-*+]|\d+[.)])\s|>)/.test(lines[i]!)) buf.push(lines[i++]!);
    const k = key();
    blocks.push(<p key={k}>{inline(buf.join(" "), k)}</p>);
  }
  return <div className="flex flex-col gap-2.5 text-[13px] leading-relaxed [overflow-wrap:anywhere]">{blocks}</div>;
}
