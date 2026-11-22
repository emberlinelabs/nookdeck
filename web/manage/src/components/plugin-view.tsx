import { useState, type KeyboardEvent, type ReactNode } from "react";
import { IconLayoutGrid as GridIcon, IconList as ListIcon } from "@tabler/icons-react";
import { t, useLanguage } from "@/lib/i18n";

export type PluginView = "grid" | "list";
const KEY = "nookdeck.plugins.view";

/** The chosen view, remembered in this browser and shared by every list of the Plugins page. */
export function usePluginView(): [PluginView, (v: PluginView) => void] {
  const [view, setView] = useState<PluginView>(() => { try { return window.localStorage.getItem(KEY) === "list" ? "list" : "grid"; } catch { return "grid"; } });
  return [view, (v) => { setView(v); try { window.localStorage.setItem(KEY, v); } catch { /* not remembered */ } }];
}

/** Two icon buttons: grid and list. */
export function ViewToggle({ view, onView }: { view: PluginView; onView: (v: PluginView) => void }) {
  useLanguage();
  const btn = (v: PluginView, label: string, icon: ReactNode) => (
    <button type="button" aria-pressed={view === v} aria-label={label} title={label} onClick={() => onView(v)}
      className={`grid size-7 place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-ring ${view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{icon}</button>
  );
  return (
    <div role="group" aria-label={t("View")} className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/50 p-0.5">
      {btn("grid", t("Grid view"), <GridIcon className="size-4" />)}
      {btn("list", t("List view"), <ListIcon className="size-4" />)}
    </div>
  );
}

/** A list of rows: arrow keys move between the rows (each `[data-row]` is focusable). */
export function RowList({ children, label }: { children: ReactNode; label: string }) {
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-row]"));
    if (rows.length === 0) return;
    const at = rows.findIndex((r) => r === document.activeElement || r.contains(document.activeElement));
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)));
    // inside a text field or select the arrows keep their own meaning
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    e.preventDefault();
    rows[next]?.focus();
  };
  return <ul role="list" aria-label={label} onKeyDown={onKeyDown} className="flex flex-col gap-1.5">{children}</ul>;
}

/** The frame of one row: focusable, Enter on the row opens it. */
export function Row({ children, onOpen, label }: { children: ReactNode; onOpen?: () => void; label: string }) {
  return (
    <li data-row tabIndex={0} aria-label={label}
      onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) { e.preventDefault(); onOpen?.(); } }}
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border bg-card px-3 py-2 text-card-foreground transition-colors hover:bg-muted/30 focus-visible:outline-2 focus-visible:outline-ring">
      {children}
    </li>
  );
}
