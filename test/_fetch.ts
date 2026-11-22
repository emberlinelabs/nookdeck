// Test helper: the agent's localhost routes require "X-Nookdeck: 1" and a JSON content type on mutating requests
// (CSRF guard). Existing tests talk to a temp agent through fetch, so default those headers here. Guard tests use rawFetch.
export const rawFetch: typeof fetch = globalThis.fetch.bind(globalThis);
if (!(globalThis as any).__pdFetchPatched) {
  (globalThis as any).__pdFetchPatched = true;
  const wrapped = ((input: any, init: any = {}) => {
    const url = String(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):/.test(url)) return rawFetch(input, init);
    const headers = new Headers(init.headers);
    if (!headers.has("x-nookdeck")) headers.set("x-nookdeck", "1");
    if ((init.body === undefined || typeof init.body === "string") && !headers.has("content-type")) headers.set("content-type", "application/json");
    return rawFetch(input, { ...init, headers });
  }) as typeof fetch;
  globalThis.fetch = wrapped;
}
