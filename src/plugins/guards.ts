/**
 * D5, best effort: before a plugin's code is imported, the host process removes the raw escape hatches. A plugin reaches the world only
 * through ctx (storage, net, shell, keys), where the AGENT checks every permission. This is not a sandbox: the UI says plugins with code
 * are trusted code. It stops the honest mistake and the lazy shortcut, not a determined attacker.
 *
 * What is removed (each call throws "<name> is not available to plugins: use ctx.<x>"):
 *   process spawning   node:child_process (all), Bun.spawn, Bun.spawnSync, Bun.$
 *   raw network        fetch, WebSocket, EventSource, XMLHttpRequest, node:http, node:https, node:http2, node:net, node:tls, node:dgram, Bun.connect, Bun.listen, Bun.udpSocket
 *   file writes        node:fs and node:fs/promises writers, Bun.write, Bun.file().writer
 *   other              process.dlopen, Worker, process.binding
 * Properties are made read-only so the plugin cannot put the originals back (it never receives them).
 */
const HINT: Record<string, string> = {
  spawn: "ctx.shell (permission: shell)",
  net: "ctx.net.fetch (permission: network)",
  write: "ctx.storage (permission: storage)",
  other: "the plugin API",
};

function deny(name: string, kind: keyof typeof HINT): (...a: unknown[]) => never {
  return () => { throw new Error(`${name} is not available to plugins: use ${HINT[kind]}`); };
}

function lock(obj: any, keys: string[], prefix: string, kind: keyof typeof HINT): void {
  if (!obj) return;
  for (const k of keys) {
    if (!(k in obj)) continue;
    try { Object.defineProperty(obj, k, { value: deny(`${prefix}${k}`, kind), writable: false, configurable: false, enumerable: true }); }
    catch { try { obj[k] = deny(`${prefix}${k}`, kind); } catch { /* a read-only builtin: nothing more to do */ } }
  }
}

const req = (name: string): any => { try { return require(name); } catch { return null; } };

export function lockDown(): void {
  lock(req("node:child_process"), ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"], "child_process.", "spawn");
  const B: any = (globalThis as any).Bun;
  lock(B, ["spawn", "spawnSync", "$"], "Bun.", "spawn");
  lock(B, ["connect", "listen", "udpSocket"], "Bun.", "net");
  lock(B, ["write"], "Bun.", "write");
  lock(globalThis, ["fetch", "WebSocket", "EventSource", "XMLHttpRequest"], "", "net");
  for (const m of ["node:http", "node:https"]) lock(req(m), ["request", "get", "createServer"], `${m.slice(5)}.`, "net");
  lock(req("node:http2"), ["connect", "createServer", "createSecureServer"], "http2.", "net");
  lock(req("node:net"), ["connect", "createConnection", "createServer"], "net.", "net");
  lock(req("node:tls"), ["connect", "createServer"], "tls.", "net");
  lock(req("node:dgram"), ["createSocket"], "dgram.", "net");
  const W = ["writeFile", "appendFile", "mkdir", "rm", "rmdir", "rename", "unlink", "copyFile", "cp", "truncate", "symlink", "link", "chmod", "chown", "utimes"];
  lock(req("node:fs"), [...W.flatMap((k) => [k, `${k}Sync`]), "createWriteStream"], "fs.", "write");
  lock(req("node:fs/promises"), W, "fs.promises.", "write");
  // a Bun.file(...).writer() would write too
  if (B?.file) {
    const orig = B.file.bind(B);
    try {
      Object.defineProperty(B, "file", { value: (...a: unknown[]) => {
        const f = orig(...a);
        try { Object.defineProperty(f, "writer", { value: deny("Bun.file().writer", "write") }); Object.defineProperty(f, "write", { value: deny("Bun.file().write", "write") }); } catch { /* ignore */ }
        return f;
      }, writable: false, configurable: false });
    } catch { /* ignore */ }
  }
  lock(process, ["dlopen", "binding", "_linkedBinding"], "process.", "other");
  lock(globalThis, ["Worker"], "", "other");
}
