import { AgentApi, TOOLS, callTool, type Fetch } from "./tools";

export const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = "0.1.0";

type Msg = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
const rpcErr = (id: Msg["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** One JSON-RPC message in, the reply out (undefined for notifications). */
export async function handleMessage(api: AgentApi, msg: Msg): Promise<object | undefined> {
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string") return rpcErr(msg?.id, -32600, "invalid request");
  const isNote = msg.id === undefined || msg.method.startsWith("notifications/");
  if (isNote) return undefined;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize": {
      const want = msg.params?.protocolVersion;
      return ok({
        protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "nookdeck", version: VERSION },
        instructions: "Arrange the Nookdeck deck. Call get_layout first, use preview_changes before saving, and undo reverts the last change.",
      });
    }
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      const name = msg.params?.name;
      if (typeof name !== "string" || !TOOLS.some((t) => t.name === name)) return rpcErr(msg.id, -32602, `unknown tool "${name}"`);
      const args = msg.params?.arguments ?? {};
      if (typeof args !== "object" || Array.isArray(args)) return rpcErr(msg.id, -32602, "arguments must be an object");
      const r = await callTool(api, name, args);
      return ok({ content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) });
    }
    default: return rpcErr(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

/** Newline-delimited JSON-RPC over stdio. Logs go to stderr only; stdout carries protocol messages. */
export async function runMcp(opts: { port: number; input?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>; write?: (line: string) => void; fetch?: Fetch }) {
  const api = new AgentApi(opts.port, opts.fetch);
  const write = opts.write ?? ((l: string) => { process.stdout.write(l + "\n"); });
  const input = (opts.input ?? Bun.stdin.stream()) as AsyncIterable<Uint8Array>;
  const dec = new TextDecoder();
  let buf = "";
  const pending: Promise<void>[] = [];
  const handleLine = async (line: string) => {
    if (!line.trim()) return;
    let msg: any;
    try { msg = JSON.parse(line); } catch { write(JSON.stringify(rpcErr(null, -32700, "parse error"))); return; }
    try {
      const out = await handleMessage(api, msg);
      if (out) write(JSON.stringify(out));
    } catch (e: any) {
      console.error("nookdeck mcp:", e);
      write(JSON.stringify(rpcErr(msg?.id, -32603, e?.message ?? "internal error")));
    }
  };
  for await (const chunk of input) {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      pending.push(handleLine(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  }
  if (buf.trim()) pending.push(handleLine(buf));
  await Promise.all(pending);
}
