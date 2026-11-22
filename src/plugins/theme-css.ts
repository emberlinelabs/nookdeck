/**
 * Theme CSS (spec D15): parsed with postcss on install (a real parser, not regexes), checked against the reject rules, scoped under
 * `.pd-root[data-theme-pkg="<id>"]` (plus `[data-theme-variant="<v>"]` for a variant's file) and url()s rewritten to the package's own
 * files. Anything that could load or leak data from elsewhere is refused, never silently dropped.
 */
import postcss, { type AtRule, type ChildNode, type Declaration, type Root, type Rule } from "postcss";

export const THEME_CSS_MAX_BYTES = 64 * 1024;
/** The deck's sheet layer: a theme may not stack above it. */
export const THEME_Z_MAX = 100;
export class ThemeCssError extends Error {}

const AT_ALLOWED = new Set(["media", "supports", "keyframes", "-webkit-keyframes", "font-face"]);
/** The documented theming hooks: the only data-* attributes a selector may use. Anything else on `data-*` or `value` is an exfiltration pattern. */
const ATTR_ALLOWED = new Set(["data-part", "data-kind", "data-state", "data-size", "data-theme-variant", "data-theme-pkg"]);

export interface ScopeOptions {
  /** The theme id (scope and file urls). */
  id: string;
  /** Adds [data-theme-variant="<v>"] to the scope. */
  variant?: string;
  /** Files of the package: a url() may only name one of these. */
  files: Set<string>;
  /** Where the package files are served from (default the agent's /api/themes/<id>/files). A demo or website host passes its own folder. */
  urlBase?: string;
}

const fail = (m: string): never => { throw new ThemeCssError(m); };

/** Removes quoted strings so that checks do not trip over text inside them. */
const unquote = (s: string): string => s.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');

function checkAttrs(selector: string): void {
  const bare = unquote(selector);
  const re = /\[\s*([^\]=~|^$*\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(bare))) {
    const name = m[1]!.toLowerCase().replace(/^[^|]*\|/, "");
    if (!ATTR_ALLOWED.has(name)) fail(`the attribute selector [${name}] is not allowed: only ${[...ATTR_ALLOWED].join(", ")} can be matched`);
  }
}

/** Splits a selector list at top-level commas. */
function splitSelectors(sel: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", q = "";
  for (const ch of sel) {
    if (q) { cur += ch; if (ch === q) q = ""; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function scopeSelector(sel: string, scope: string): string {
  if (/\\/.test(sel)) fail("escapes (\\) are not allowed in selectors");
  checkAttrs(sel);
  const bare = unquote(sel);
  if (/(^|[\s>+~(,])(html|body)(?![\w-])/i.test(bare)) fail("selectors on html or body are not allowed: style the deck through its data-part hooks");
  const m = /^(:root|\.pd-root)(?![\w-])/.exec(sel);
  if (m) return scope + sel.slice(m[0].length); // `:root { ... }` and `.pd-root { ... }` style the root itself
  // the pack's own attributes sit on the root element: `[data-theme-variant="x"] .a` means root-with-variant, no descendant space
  const roots = /^(?:\[\s*data-theme-(?:pkg|variant)\s*=\s*(?:"[^"]*"|'[^']*'|[\w-]+)\s*\])+/.exec(sel);
  if (roots) return scope + roots[0] + sel.slice(roots[0].length);
  return `${scope} ${sel}`;
}

function rewriteUrls(value: string, opts: ScopeOptions, where: string): string {
  const plain = unquote(value);
  if (/\\/.test(plain)) fail(`${where}: escapes (\\) are not allowed in values`);
  if (/expression\s*\(|behavior\s*:|-moz-binding|javascript:|image-set\s*\(|-webkit-image-set\s*\(|\belement\s*\(|\bsrc\s*\(|\blocal\s*\(/i.test(plain)) fail(`${where}: this value is not allowed`);
  return value.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi, (_m, a, b, c) => {
    const raw = String(a ?? b ?? c ?? "").trim();
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//") || raw.startsWith("/") || raw.startsWith("#") || raw.includes("..") || raw.includes("\\")) fail(`${where}: url(${raw.slice(0, 40)}) must name a file of the theme package`);
    const rel = raw.replace(/^\.\//, "");
    if (!opts.files.has(rel)) fail(`${where}: url(${rel}) is not a file in the theme package`);
    return `url("${(opts.urlBase ?? `/api/themes/${opts.id}/files`).replace(/\/+$/, "")}/${rel}")`;
  });
}

function checkDecl(d: Declaration, opts: ScopeOptions, where: string): void {
  const prop = d.prop.toLowerCase();
  if (/\\/.test(d.prop)) fail(`${where}: escapes (\\) are not allowed in property names`);
  if (prop === "behavior" || prop === "-moz-binding") fail(`${where}: ${prop} is not allowed`);
  const v = d.value.trim().toLowerCase();
  if (prop === "position" && /\bfixed\b/.test(v)) fail(`${where}: position: fixed is not allowed`);
  if (prop === "z-index") {
    const n = Number(v);
    if (!Number.isFinite(n) || n > THEME_Z_MAX) fail(`${where}: z-index above ${THEME_Z_MAX} (the sheet layer) is not allowed`);
  }
  d.value = rewriteUrls(d.value, opts, where);
}

function walk(nodes: ChildNode[], opts: ScopeOptions, scope: string, inKeyframes: boolean): void {
  for (const n of nodes.slice()) { // a copy: removing a comment must not skip the node after it
    if (n.type === "comment") { n.remove(); continue; }
    if (n.type === "decl") { checkDecl(n, opts, `"${n.prop}"`); continue; }
    if (n.type === "atrule") {
      const at = n as AtRule;
      const name = at.name.toLowerCase();
      if (!AT_ALLOWED.has(name)) fail(`@${at.name} is not allowed (only @media, @supports, @keyframes and @font-face)`);
      if (/\\/.test(at.params)) fail(`@${at.name}: escapes (\\) are not allowed`);
      if (name.endsWith("keyframes")) {
        if (/^pd-/i.test(at.params.trim())) fail("keyframes names starting with pd- are reserved for the deck");
        walk(at.nodes ?? [], opts, scope, true);
      } else walk(at.nodes ?? [], opts, scope, inKeyframes);
      continue;
    }
    if (n.type === "rule") {
      const r = n as Rule;
      if (!inKeyframes) r.selector = splitSelectors(r.selector).map((s) => scopeSelector(s, scope)).join(", ");
      else if (!/^(from|to|\d+(\.\d+)?%)(\s*,\s*(from|to|\d+(\.\d+)?%))*$/i.test(r.selector.trim())) fail("keyframe selectors must be from, to or percentages");
      walk(r.nodes ?? [], opts, scope, inKeyframes);
      continue;
    }
  }
}

/** Parses, checks and scopes one css file. Returns the css to serve. */
export function scopeThemeCss(css: string, opts: ScopeOptions): string {
  if (new TextEncoder().encode(css).length > THEME_CSS_MAX_BYTES) fail("theme.css is larger than 64 KB");
  let root: Root;
  try { root = postcss.parse(css); } catch (e: any) { return fail(`theme.css is not valid CSS: ${e?.reason ?? e?.message ?? e}`); }
  const scope = `.pd-root[data-theme-pkg="${opts.id}"]${opts.variant ? `[data-theme-variant="${opts.variant}"]` : ""}`;
  walk(root.nodes, opts, scope, false);
  // @font-face and keyframes are global by nature; rules inside @media were scoped by the walk
  return root.toString();
}
