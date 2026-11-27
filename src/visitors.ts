/**
 * Who reached this computer since the agent started: one entry per remote address (never localhost), for "Report a problem".
 * A phone that cannot open the page never gets here (another network, a router that isolates its clients, the firewall), so an
 * empty list is itself the answer to "does the phone reach the computer at all?". Kept in memory only.
 */
export type VisitKind = "page" | "pair-ok" | "pair-fail" | "ws" | "request";

export interface Visit {
  address: string;
  first: number;
  last: number;
  hits: number;
  /** opened the deck page (/, the pairing page) */
  page: boolean;
  paired: boolean;
  pinFails: number;
  /** the paired device that connected its socket from this address */
  device?: string;
}

/** "::ffff:192.168.1.5" -> "192.168.1.5". */
export const plainIp = (a: string): string => a.replace(/^::ffff:/i, "");

export class VisitorLog {
  private byAddr = new Map<string, Visit>();
  constructor(private readonly max = 20, private readonly now: () => number = Date.now) {}

  seen(address: string | null | undefined, kind: VisitKind, device?: string): void {
    if (!address) return;
    const a = plainIp(address);
    if (a === "127.0.0.1" || a === "::1") return;
    const t = this.now();
    let v = this.byAddr.get(a);
    if (!v) {
      if (this.byAddr.size >= this.max) {
        const oldest = [...this.byAddr.values()].sort((x, y) => x.last - y.last)[0]!;
        this.byAddr.delete(oldest.address);
      }
      v = { address: a, first: t, last: t, hits: 0, page: false, paired: false, pinFails: 0 };
      this.byAddr.set(a, v);
    }
    v.last = t;
    v.hits++;
    if (kind === "page") v.page = true;
    if (kind === "pair-ok") v.paired = true;
    if (kind === "pair-fail") v.pinFails++;
    if (kind === "ws" && device) v.device = device;
  }

  /** newest first */
  list(): Visit[] {
    return [...this.byAddr.values()].map((v) => ({ ...v })).sort((x, y) => y.last - x.last);
  }
}
