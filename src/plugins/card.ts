/**
 * The `card` renderer (spec release 0.5, D2): a small JSON tree of built-in parts that the deck draws with the theme.
 * The ONE definition of the shapes, the limits and the check, used by the agent (live data and manifest previews), the deck
 * (which never trusts what it receives) and plugin authors (`@nookdeck/plugin` re-exports the types and the builders).
 * Pure: no imports, and no syntax Safari 12 cannot parse after the web build.
 */

export type CardTone = "default" | "muted" | "accent" | "ok" | "warn" | "bad";
export type CardGap = 0 | 1 | 2 | 3;
export type CardAlign = "start" | "center" | "end" | "between";
export type CardArgs = Record<string, string | number | boolean>;

export type CardNode =
  | { t: "row" | "col"; gap?: CardGap; align?: CardAlign; grow?: boolean; children: CardNode[] }
  | { t: "text"; text: string; size?: "s" | "m" | "l"; tone?: CardTone; bold?: boolean }
  | { t: "number"; value: string | number; unit?: string; size?: "m" | "l" | "xl"; tone?: CardTone }
  | { t: "pill"; text: string; tone?: CardTone }
  /** 0..1 */
  | { t: "progress"; value: number; tone?: CardTone }
  /** at most 60 points */
  | { t: "sparkline"; points: number[]; tone?: CardTone }
  /** an icon name the deck ships */
  | { t: "icon"; name: string; tone?: CardTone }
  /** data:image/png or data:image/jpeg, base64 */
  | { t: "image"; src: string; fit?: "cover" | "contain" }
  | { t: "button"; label: string; icon?: string; action: string; args?: CardArgs; tone?: CardTone; active?: boolean }
  | { t: "spacer" };

/** The `data` of a card widget. */
export interface CardData { root: CardNode }

export const CARD_LIMITS = {
  /** the root is depth 1 */
  depth: 6,
  nodes: 60,
  /** any one text: text, number value, unit, pill, button label, a string arg */
  text: 200,
  /** bytes of the card as JSON, image sources left out */
  bytes: 32 * 1024,
  /** characters of all image sources of one card together (data URL included) */
  imageBytes: 200 * 1024,
  points: 60,
  args: 20,
} as const;

const TONES = ["default", "muted", "accent", "ok", "warn", "bad"];
const ALIGNS = ["start", "center", "end", "between"];
const FIELDS: Record<string, string[]> = {
  row: ["gap", "align", "grow", "children"],
  col: ["gap", "align", "grow", "children"],
  text: ["text", "size", "tone", "bold"],
  number: ["value", "unit", "size", "tone"],
  pill: ["text", "tone"],
  progress: ["value", "tone"],
  sparkline: ["points", "tone"],
  icon: ["name", "tone"],
  image: ["src", "fit"],
  button: ["label", "icon", "action", "args", "tone", "active"],
  spacer: [],
};
const ICON_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const ACTION_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const ARG_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const IMAGE_RE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

class CardError extends Error {}
const bad = (m: string): never => { throw new CardError(m); };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && isFinite(v);

interface Ctx { nodes: number; images: number }

function str(v: unknown, where: string, max: number = CARD_LIMITS.text): string {
  if (typeof v !== "string") return bad(`${where} must be text`);
  if (v.length > max) bad(`${where} is longer than ${max} characters`);
  return v;
}

function oneOf<T>(v: unknown, list: readonly unknown[], where: string): T {
  if (list.indexOf(v) < 0) bad(`${where} must be one of ${list.join(", ")}`);
  return v as T;
}

function bool(v: unknown, where: string): boolean {
  if (typeof v !== "boolean") bad(`${where} must be true or false`);
  return v as boolean;
}

function node(v: unknown, where: string, depth: number, ctx: Ctx): CardNode {
  if (!isObj(v)) return bad(`${where} must be an object`);
  if (depth > CARD_LIMITS.depth) bad(`the card is nested more than ${CARD_LIMITS.depth} levels`);
  if (++ctx.nodes > CARD_LIMITS.nodes) bad(`the card has more than ${CARD_LIMITS.nodes} parts`);
  const t = v.t;
  if (typeof t !== "string" || !Object.prototype.hasOwnProperty.call(FIELDS, t)) return bad(`${where}: unknown part "${String(t).slice(0, 20)}"`);
  const allowed = FIELDS[t]!;
  const keys = Object.keys(v);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (k !== "t" && v[k] !== undefined && allowed.indexOf(k) < 0) bad(`${where}: "${k.slice(0, 20)}" is not a field of ${t}`);
  }
  const out: Record<string, unknown> = { t };
  const has = (k: string): boolean => v[k] !== undefined;
  const tone = (): void => { if (has("tone")) out.tone = oneOf(v.tone, TONES, `${where}.tone`); };
  if (t === "row" || t === "col") {
    if (has("gap")) out.gap = oneOf(v.gap, [0, 1, 2, 3], `${where}.gap`);
    if (has("align")) out.align = oneOf(v.align, ALIGNS, `${where}.align`);
    if (has("grow")) out.grow = bool(v.grow, `${where}.grow`);
    const list = v.children;
    if (!Array.isArray(list)) return bad(`${where}.children must be a list`);
    if (list.length > CARD_LIMITS.nodes) bad(`the card has more than ${CARD_LIMITS.nodes} parts`);
    out.children = list.map((c, i) => node(c, `${where}.children[${i}]`, depth + 1, ctx));
  } else if (t === "text") {
    out.text = str(v.text, `${where}.text`);
    if (has("size")) out.size = oneOf(v.size, ["s", "m", "l"], `${where}.size`);
    if (has("bold")) out.bold = bool(v.bold, `${where}.bold`);
    tone();
  } else if (t === "number") {
    out.value = finite(v.value) ? v.value : typeof v.value === "string" ? str(v.value, `${where}.value`) : bad(`${where}.value must be a number or text`);
    if (has("unit")) out.unit = str(v.unit, `${where}.unit`);
    if (has("size")) out.size = oneOf(v.size, ["m", "l", "xl"], `${where}.size`);
    tone();
  } else if (t === "pill") {
    out.text = str(v.text, `${where}.text`);
    tone();
  } else if (t === "progress") {
    if (!finite(v.value)) bad(`${where}.value must be a number from 0 to 1`);
    out.value = Math.min(1, Math.max(0, v.value as number));
    tone();
  } else if (t === "sparkline") {
    const p = v.points;
    if (!Array.isArray(p) || p.length > CARD_LIMITS.points || !p.every(finite)) bad(`${where}.points must be at most ${CARD_LIMITS.points} numbers`);
    out.points = (p as number[]).slice();
    tone();
  } else if (t === "icon") {
    if (typeof v.name !== "string" || !ICON_RE.test(v.name)) bad(`${where}.name must be an icon name`);
    out.name = v.name;
    tone();
  } else if (t === "image") {
    const src = v.src;
    if (typeof src !== "string") return bad(`${where}.src must be a data:image/png or data:image/jpeg address`);
    ctx.images += src.length;
    if (ctx.images > CARD_LIMITS.imageBytes) bad(`the card's images are larger than ${CARD_LIMITS.imageBytes / 1024} KB`);
    if (!IMAGE_RE.test(src)) bad(`${where}.src must be a base64 data:image/png or data:image/jpeg address`);
    out.src = src;
    if (has("fit")) out.fit = oneOf(v.fit, ["cover", "contain"], `${where}.fit`);
  } else if (t === "button") {
    out.label = str(v.label, `${where}.label`);
    if (has("icon")) {
      if (typeof v.icon !== "string" || !ICON_RE.test(v.icon)) bad(`${where}.icon must be an icon name`);
      out.icon = v.icon;
    }
    if (!out.label && !out.icon) bad(`${where} needs a label or an icon`);
    if (typeof v.action !== "string" || !ACTION_RE.test(v.action)) bad(`${where}.action must be the id of one of the plugin's actions`);
    out.action = v.action;
    if (has("args")) out.args = cardArgs(v.args, `${where}.args`);
    if (has("active")) out.active = bool(v.active, `${where}.active`);
    tone();
  }
  return out as unknown as CardNode;
}

/** A button's `args`: up to 20 flat values. Throws; also used for what a phone sends back. */
function cardArgs(v: unknown, where: string): CardArgs {
  if (!isObj(v)) return bad(`${where} must be an object`);
  const keys = Object.keys(v).filter((k) => v[k] !== undefined);
  if (keys.length > CARD_LIMITS.args) bad(`${where} has more than ${CARD_LIMITS.args} values`);
  const out: CardArgs = {};
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]!;
    if (!ARG_KEY_RE.test(k)) bad(`${where}: "${k.slice(0, 20)}" is not a setting name`);
    const x = v[k];
    if (typeof x === "boolean" || finite(x)) out[k] = x;
    else out[k] = str(x, `${where}.${k}`);
  }
  return out;
}

/** Checks `data` of a card widget. Returns a clean copy, or a short message for the tile and the plugin's author. */
export function validateCard(data: unknown): { data: CardData } | { error: string } {
  try {
    if (!isObj(data)) return bad("a card needs { root }");
    const extra = Object.keys(data).filter((k) => k !== "root" && data[k] !== undefined);
    if (extra.length) bad(`a card has only "root", not "${extra[0]!.slice(0, 20)}"`);
    const ctx: Ctx = { nodes: 0, images: 0 };
    const root = node(data.root, "root", 1, ctx);
    const json = JSON.stringify({ root }, (k, v) => (k === "src" && typeof v === "string" ? "" : v));
    if (new TextEncoder().encode(json).length > CARD_LIMITS.bytes) bad(`the card is larger than ${CARD_LIMITS.bytes / 1024} KB`);
    return { data: { root } };
  } catch (e) {
    if (e instanceof CardError) return { error: `card: ${e.message}` };
    throw e;
  }
}

// ------------------------------------------------------------------------------------------------ builders

type Opts<T extends CardNode["t"], K extends string> = Omit<Extract<CardNode, { t: T }>, "t" | K>;
/** Children may hold false / null / undefined, so `cond && card.text(...)` works. */
export type CardChildren = Array<CardNode | false | null | undefined>;

const make = (t: CardNode["t"], fields: object): any => {
  const out: Record<string, unknown> = { t };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) out[k] = v;
  return out;
};
const kids = (c: CardChildren): CardNode[] => c.filter((x): x is CardNode => !!x);

type BoxOpts = { gap?: CardGap; align?: CardAlign; grow?: boolean };

/** `return { render: "card", data: card.root(card.col([card.text("Hi")])) }` */
export const card = {
  root: (root: CardNode): CardData => ({ root }),
  row: (children: CardChildren, o: BoxOpts = {}): CardNode => make("row", { ...o, children: kids(children) }),
  col: (children: CardChildren, o: BoxOpts = {}): CardNode => make("col", { ...o, children: kids(children) }),
  text: (text: string, o: Opts<"text", "text"> = {}): CardNode => make("text", { ...o, text }),
  number: (value: string | number, o: Opts<"number", "value"> = {}): CardNode => make("number", { ...o, value }),
  pill: (text: string, o: Opts<"pill", "text"> = {}): CardNode => make("pill", { ...o, text }),
  progress: (value: number, o: Opts<"progress", "value"> = {}): CardNode => make("progress", { ...o, value }),
  /** keeps the last 60 points */
  sparkline: (points: number[], o: Opts<"sparkline", "points"> = {}): CardNode => make("sparkline", { ...o, points: points.slice(-CARD_LIMITS.points) }),
  icon: (name: string, o: Opts<"icon", "name"> = {}): CardNode => make("icon", { ...o, name }),
  image: (src: string, o: Opts<"image", "src"> = {}): CardNode => make("image", { ...o, src }),
  button: (label: string, action: string, o: Opts<"button", "label" | "action"> = {}): CardNode => make("button", { ...o, label, action }),
  spacer: (): CardNode => ({ t: "spacer" }),
};
