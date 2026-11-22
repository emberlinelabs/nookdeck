/** Runs argv and returns stdout. Throws on a non-zero exit, a missing binary or a timeout. (Shared by every platform.) */
export const ACTION_TIMEOUT_MS = 10_000;

export async function runCapture(argv: string[], timeoutMs = ACTION_TIMEOUT_MS, stdin?: string, env?: Record<string, string>): Promise<string> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : new Response(stdin), stdout: "pipe", stderr: "pipe", windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) } as any);
  } catch (err: any) {
    if (err?.code === "ENOENT" || /not found|ENOENT/i.test(String(err?.message))) {
      throw new Error(`${argv[0]} not found; is it installed?`);
    }
    throw new Error(`cannot start ${argv[0]}: ${err?.message ?? err}`);
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
  }, timeoutMs);

  const stdoutP = new Response(proc.stdout as ReadableStream).text().catch(() => "");
  const stderrP = new Response(proc.stderr as ReadableStream).text().catch(() => "");
  const code = await proc.exited;
  clearTimeout(timer);
  // Do not hang if a grandchild keeps a pipe open.
  const grace = <T,>(p: Promise<T>, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), 300))]);
  const [stdout, stderr] = await Promise.all([grace(stdoutP, ""), grace(stderrP, "")]);

  if (timedOut) throw new Error(`${argv[0]} timed out after ${timeoutMs / 1000}s`);
  if (code !== 0) throw new Error(stderr.trim() || `${argv[0]} exited with code ${code}`);
  return stdout;
}

/** Like runCapture but never throws: exit code and stdout+stderr. */
export async function runCode(argv: string[], timeoutMs = 5000): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", windowsHide: true } as any);
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const [o, e] = await Promise.all([new Response(p.stdout as any).text(), new Response(p.stderr as any).text()]);
    clearTimeout(timer);
    return { code: await p.exited, out: `${o}\n${e}`.trim() };
  } catch (err: any) {
    return { code: 127, out: String(err?.message ?? err) };
  }
}
