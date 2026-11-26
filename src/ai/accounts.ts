/**
 * Several Claude Code accounts and Codex profiles (PhoneBox #538, #633). Claude Code keeps one sign-in per config folder
 * (CLAUDE_CONFIG_DIR), Codex one per CODEX_HOME. The built-in folder is the account "default"; the user adds more folders,
 * each with a name. Nookdeck only READS those folders (and, on macOS, the folder's Keychain entry); it never writes to them.
 *
 * Stored in ~/.nookdeck/ai-accounts.json (0600): names and folder paths only, never a token. Phones get the id and the name.
 */
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { HOME } from "../config";
import { safeHome } from "./types";
import { t } from "../i18n";
import { platform } from "../platform";

export type AccountTool = "claude" | "codex";
export const ACCOUNT_TOOLS: AccountTool[] = ["claude", "codex"];
export const DEFAULT_ACCOUNT = "default";
export const MAX_ACCOUNTS = 8;
export const ACCOUNT_NAME_MAX = 40;

export interface AiAccountRef {
  id: string;
  name: string;
  /** absolute folder path */
  dir: string;
  /** the tool's own folder (~/.claude, ~/.codex or the env override) */
  isDefault: boolean;
}

interface Stored { id: string; name: string; dir: string }
interface FileShape { claude?: Stored[]; codex?: Stored[]; names?: { claude?: string; codex?: string } }

const DEFAULT_NAME: Record<AccountTool, string> = { claude: "Claude", codex: "Codex" };

/** "~/x" and relative paths to an absolute path. */
export function expandDir(p: string, home = safeHome()): string {
  const s = p.trim();
  if (s === "~") return home;
  if (s.startsWith("~/") || s.startsWith("~\\")) return join(home, s.slice(2));
  return isAbsolute(s) ? resolve(s) : resolve(home, s);
}

// macOS and Windows folders are case-insensitive by default; Linux ones are not
const samePath = (a: string, b: string) => (platform.id === "win32" || platform.id === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b);

export class AccountStore {
  private data: FileShape = {};
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private defaults: Record<AccountTool, () => string>,
    private file = join(HOME, "ai-accounts.json"),
    private isDir: (p: string) => Promise<boolean> = async (p) => { try { return (await stat(p)).isDirectory(); } catch { return false; } },
  ) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8"));
      const clean = (v: unknown): Stored[] => (Array.isArray(v) ? v : [])
        .filter((a: any) => a && typeof a.id === "string" && /^a-[0-9a-f]{6,16}$/.test(a.id) && typeof a.name === "string" && typeof a.dir === "string" && isAbsolute(a.dir))
        .slice(0, MAX_ACCOUNTS - 1)
        .map((a: any) => ({ id: a.id, name: a.name.slice(0, ACCOUNT_NAME_MAX), dir: a.dir }));
      const names = raw?.names && typeof raw.names === "object" ? raw.names : {};
      this.data = {
        claude: clean(raw?.claude),
        codex: clean(raw?.codex),
        names: {
          ...(typeof names.claude === "string" && names.claude ? { claude: names.claude.slice(0, ACCOUNT_NAME_MAX) } : {}),
          ...(typeof names.codex === "string" && names.codex ? { codex: names.codex.slice(0, ACCOUNT_NAME_MAX) } : {}),
        },
      };
    } catch {
      this.data = {};
    }
  }

  /** The default account first, then the added ones in the order they were added. */
  list(tool: AccountTool): AiAccountRef[] {
    return [
      { id: DEFAULT_ACCOUNT, name: this.data.names?.[tool] ?? DEFAULT_NAME[tool], dir: this.defaults[tool](), isDefault: true },
      ...(this.data[tool] ?? []).map((a) => ({ ...a, isDefault: false })),
    ];
  }

  private name(v: unknown): string {
    const n = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
    if (!n) throw new Error(t("Give the account a name"));
    if (n.length > ACCOUNT_NAME_MAX) throw new Error(t("The name is too long (at most {n} characters)", { n: ACCOUNT_NAME_MAX }));
    return n;
  }

  async add(tool: AccountTool, name: unknown, dir: unknown): Promise<AiAccountRef> {
    const n = this.name(name);
    if (typeof dir !== "string" || !dir.trim()) throw new Error(t("Choose the folder of that sign-in"));
    const abs = expandDir(dir);
    if (!(await this.isDir(abs))) throw new Error(t("That folder does not exist: {path}", { path: abs }));
    const all = this.list(tool);
    if (all.length >= MAX_ACCOUNTS) throw new Error(t("At most {n} accounts", { n: MAX_ACCOUNTS }));
    if (all.some((a) => samePath(a.dir, abs))) throw new Error(t("That folder is already in the list"));
    if (all.some((a) => a.name.toLowerCase() === n.toLowerCase())) throw new Error(t("Another account already has that name"));
    const a: Stored = { id: `a-${randomBytes(4).toString("hex")}`, name: n, dir: abs };
    this.data[tool] = [...(this.data[tool] ?? []), a];
    await this.save();
    return { ...a, isDefault: false };
  }

  async rename(tool: AccountTool, id: string, name: unknown): Promise<AiAccountRef> {
    const n = this.name(name);
    if (this.list(tool).some((a) => a.id !== id && a.name.toLowerCase() === n.toLowerCase())) throw new Error(t("Another account already has that name"));
    if (id === DEFAULT_ACCOUNT) {
      this.data.names = { ...this.data.names, [tool]: n };
    } else {
      const a = (this.data[tool] ?? []).find((x) => x.id === id);
      if (!a) throw new Error(t("No such account"));
      a.name = n;
    }
    await this.save();
    return this.list(tool).find((a) => a.id === id)!;
  }

  /** The default account cannot be removed (it is the tool's own folder); rename it instead. */
  async remove(tool: AccountTool, id: string): Promise<void> {
    if (id === DEFAULT_ACCOUNT) throw new Error(t("The default account cannot be removed"));
    const before = this.data[tool] ?? [];
    if (!before.some((a) => a.id === id)) throw new Error(t("No such account"));
    this.data[tool] = before.filter((a) => a.id !== id);
    await this.save();
  }

  private save(): Promise<void> {
    const body = JSON.stringify(this.data, null, 2) + "\n";
    const run = this.chain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, body, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    });
    this.chain = run.catch(() => {});
    return run;
  }
}
