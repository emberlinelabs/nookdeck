import { userHome } from "./home";
import { isAbsolute, join, normalize, relative } from "node:path";

import { t as tr } from "./i18n";

export type Risk = "low" | "medium" | "high";
export interface RiskResult {
  risk: Risk;
  /** Short Vietnamese reason, shown next to the request. Empty for low risk. */
  reason: string;
}

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
const SHELL_TOOLS = new Set(["bash", "shell", "exec_command", "local_shell", "exec", "run_command"]);
const WRITE_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "apply_patch", "str_replace_editor"]);
const SENSITIVE_PATH = /(^|\/)(\.env(\.[^/]*)?|id_rsa[^/]*|id_ed25519[^/]*|\.npmrc|\.netrc|credentials[^/]*|\.aws\/|\.ssh\/|\.git\/config)/i;
const SYSTEM_DIRS = /^(\/(etc|usr|bin|sbin|System|Library|var|boot|opt|private\/etc)(\/|$)|~\/\.(ssh|aws|gnupg)\b)/;

const bump = (cur: RiskResult, risk: Risk, reason: string): RiskResult => (RANK[risk] > RANK[cur.risk] ? { risk, reason } : cur);

export function commandOf(input: any): string | undefined {
  const c = input?.command ?? input?.cmd;
  if (Array.isArray(c)) return c.map(String).join(" ");
  return typeof c === "string" && c.trim() ? c : undefined;
}

/** Expands ~ and resolves a path against the project cwd. */
export function resolvePath(p: string, cwd?: string): string {
  const expanded = p === "~" ? userHome() : p.startsWith("~/") ? join(userHome(), p.slice(2)) : p;
  return normalize(isAbsolute(expanded) ? expanded : join(cwd ?? "/", expanded));
}

export function isOutside(path: string, cwd: string): boolean {
  const rel = relative(normalize(cwd), resolvePath(path, cwd));
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
}

/** Paths a Codex apply_patch touches (`*** Update File: x`, `*** Add File: x`, ...). */
export function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)].map((m) => m[1]!.trim());
}

/** Targets of shell redirections (`> file`, `>> file`, `tee file`) with simple quoting. */
export function redirectTargets(cmd: string): string[] {
  const out: string[] = [];
  for (const m of cmd.matchAll(/(?:^|[^>0-9&])>{1,2}\s*(["']?)([^\s"'|;&<>]+)\1/g)) out.push(m[2]!);
  for (const m of cmd.matchAll(/\btee\s+(?:-a\s+)?(["']?)([^\s"'|;&<>]+)\1/g)) out.push(m[2]!);
  return out.filter((t) => !t.startsWith("&") && t !== "/dev/null" && !/^\/dev\/(stderr|stdout|fd)/.test(t));
}

function classifyShell(cmd: string, cwd?: string): RiskResult {
  let r: RiskResult = { risk: "low", reason: "" };
  const c = cmd.replace(/\s+/g, " ");
  const high = (re: RegExp, reason: string) => { if (re.test(c)) r = bump(r, "high", reason); };
  const medium = (re: RegExp, reason: string) => { if (re.test(c)) r = bump(r, "medium", reason); };

  high(/(^|[;&|(\s])sudo\b/, tr("uses sudo"));
  high(/(^|[;&|(\s])rm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*(rf|fr)[a-zA-Z]*\b/i, tr("recursive delete (rm -rf)"));
  high(/(^|[;&|(\s])rm\s+(-[a-zA-Z]*\s+)*(-[a-zA-Z]*r[a-zA-Z]*\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*\s+(-[a-zA-Z]+\s+)*-[a-zA-Z]*r)/i, tr("recursive delete (rm -rf)"));
  high(/(^|[;&|(\s])rm\s+(-[a-zA-Z]+\s+)*--(recursive|force)/, tr("recursive delete (rm -rf)"));
  high(/\b(curl|wget|fetch)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, tr("downloads and runs a script (curl | sh)"));
  high(/\b(bash|sh|zsh)\s+<\(\s*(curl|wget)\b/, tr("downloads and runs a script (curl | sh)"));
  high(/\bgit\s+push\b[^;&|]*(--force(?!-with-lease)\b|\s-f\b|--force-with-lease|\s\+\S)/, "git push --force");
  high(/\bchmod\s+(-[a-zA-Z]+\s+)*0?777\b/, "chmod 777");
  high(/\bchmod\s+(-[a-zA-Z]+\s+)*-R\b[^;&|]*\s\//, tr("recursive chmod on the root"));
  high(/\b(mkfs(\.\w+)?|fdisk|diskutil\s+(erase|partition)|dd\s+[^;&|]*of=\/dev\/)/, tr("writes directly to a disk"));
  high(/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb");
  high(/>\s*\/dev\/(sd|disk|nvme)/, tr("writes directly to a disk"));

  medium(/(^|[;&|(\s])rm\s/, tr("deletes files (rm)"));
  medium(/\bgit\s+push\b/, "git push");
  medium(/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s|branch\s+-D|stash\s+(drop|clear))/, tr("destructive git command"));
  medium(/\b(chmod|chown|chgrp)\s/, tr("changes file permissions"));
  medium(/\b(kill|pkill|killall)\s/, tr("kills processes"));
  medium(/\b(npm|pnpm|yarn|bun|cargo|gem|pip)\s+publish\b/, "publish package");
  medium(/\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/, tr("removes docker objects"));
  medium(/\b(drop\s+(table|database)|truncate\s+table)\b/i, tr("deletes SQL data"));
  medium(/\b(brew|apt(-get)?|dnf|yum|pacman)\s+(uninstall|remove|purge)\b/, tr("uninstalls software"));
  medium(/\b(launchctl|systemctl)\s+(unload|stop|disable|bootout)\b/, tr("stops system services"));

  if (cwd) {
    for (const t of redirectTargets(cmd)) {
      const abs = resolvePath(t, cwd);
      if (SYSTEM_DIRS.test(t) || SYSTEM_DIRS.test(abs)) r = bump(r, "high", tr("writes a system file"));
      else if (isOutside(t, cwd)) r = bump(r, "medium", tr("writes a file outside the project"));
    }
  }
  return r;
}

/**
 * Pure risk classification of one tool call.
 * Edit/Write outside the project cwd is high; Bash is matched against destructive patterns; reads are low.
 */
export function classifyRisk(tool: string, input: unknown, cwd?: string): RiskResult {
  const t = tool.toLowerCase();
  const i: any = input && typeof input === "object" ? input : {};
  const cmd = commandOf(i);

  if (SHELL_TOOLS.has(t) || (cmd && !WRITE_TOOLS.has(t) && !t.startsWith("mcp__"))) {
    return cmd ? classifyShell(cmd, cwd) : { risk: "low", reason: "" };
  }

  if (WRITE_TOOLS.has(t)) {
    const paths: string[] = [];
    for (const k of ["file_path", "path", "notebook_path"]) if (typeof i[k] === "string") paths.push(i[k]);
    for (const k of ["patch", "input", "diff"]) if (typeof i[k] === "string") paths.push(...patchPaths(i[k]));
    if (paths.length === 0) return { risk: "medium", reason: tr("target file unknown") };
    let r: RiskResult = { risk: "low", reason: "" };
    for (const p of paths) {
      if (!cwd) r = bump(r, "medium", tr("project folder unknown"));
      else if (isOutside(p, cwd)) r = bump(r, "high", tr("writes a file outside the project"));
      if (SENSITIVE_PATH.test(resolvePath(p, cwd))) r = bump(r, "medium", tr("sensitive file (keys, .env)"));
    }
    return r;
  }

  if (t.startsWith("mcp__")) {
    return /(delete|remove|drop|destroy|purge|send|publish|push|transfer|pay|execute)/i.test(t)
      ? { risk: "medium", reason: tr("MCP tool may change data") }
      : { risk: "low", reason: "" };
  }
  return { risk: "low", reason: "" };
}
