import { useCallback, useEffect, useId, useState } from "react";
import { IconCheck as Check, IconPencil as Pencil, IconPlus as Plus, IconTrash as Trash, IconX as X } from "@tabler/icons-react";
import { Badge } from "@/components/ui/knowns/badge";
import { Button } from "@/components/ui/knowns/button";
import { Dialog } from "@/components/ui/knowns/dialog";
import { Field, Input } from "@/components/ui/knowns/input";
import { Select } from "@/components/ui/knowns/select";
import { ApiError, api } from "@/api";
import { t, useLanguage } from "@/lib/i18n";
import type { AiAccountInfo, AiAccounts, AiAccountTool } from "@/types";

const HELP: Record<AiAccountTool, { hint: string; example: string }> = {
  claude: {
    hint: "Another Claude Code sign-in lives in its own config folder: start Claude Code with CLAUDE_CONFIG_DIR set to that folder and log in once there. Nookdeck only reads it.",
    example: "~/.claude-work",
  },
  codex: {
    hint: "Another Codex profile lives in its own CODEX_HOME folder. Nookdeck reads the quota from its session files only.",
    example: "~/.codex-work",
  },
};

function statusBadge(a: AiAccountInfo) {
  if (a.status === "needs_login") return <Badge tone="warning" dot>{t("Sign in again")}</Badge>;
  if (a.error && !a.windows) return <Badge tone="danger" dot>{t("Error")}</Badge>;
  if (a.stale) return <Badge tone="neutral" dot>{t("stale")}</Badge>;
  if (a.windows) return <Badge tone="success" dot>{a.plan ? t("{plan} plan", { plan: a.plan }) : t("Quota read")}</Badge>;
  return <Badge tone="neutral" dot>{t("No data")}</Badge>;
}

/** The Claude accounts or Codex profiles of one tool: list, add, rename, remove. Folders and names stay on this computer. */
export function AiAccountsSection({ tool, toolName, onChanged }: { tool: AiAccountTool; toolName: string; onChanged?: () => void }) {
  useLanguage();
  const uid = useId();
  const [list, setList] = useState<AiAccountInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<AiAccountInfo | null>(null);

  const load = useCallback(() => {
    api.getAiAccounts().then((r) => { setList(r[tool]); setError(null); }, (e) => setError(e instanceof ApiError ? e.message : String(e)));
  }, [tool]);
  useEffect(load, [load]);

  const run = async (fn: () => Promise<AiAccounts>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setList(r[tool]);
      after?.();
      onChanged?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const title = tool === "claude" ? t("Claude accounts") : t("Codex profiles");
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-[13px] font-medium">{title}</h4>
          <p className="text-xs text-muted-foreground">{t("A quota tile can show one of them, or cycle through all.")}</p>
        </div>
        {!adding && (
          <Button size="sm" variant="secondary" icon={<Plus />} disabled={busy || !list || list.length >= 8} onClick={() => { setAdding(true); setName(""); setDir(""); }}>
            {tool === "claude" ? t("Add account") : t("Add profile")}
          </Button>
        )}
      </div>

      {list && (
        <ul className="flex flex-col divide-y rounded-lg border">
          {list.map((a) => (
            <li key={a.id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                {editing?.id === a.id ? (
                  <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); void run(() => api.renameAiAccount(tool, a.id, editing.name), () => setEditing(null)); }}>
                    <Input size="sm" aria-label={t("Name")} value={editing.name} maxLength={40} autoFocus onChange={(e) => setEditing({ id: a.id, name: e.target.value })} />
                    <Button size="xs" type="submit" aria-label={t("Save")} icon={<Check />} loading={busy} />
                    <Button size="xs" variant="ghost" type="button" aria-label={t("Cancel")} icon={<X />} onClick={() => setEditing(null)} />
                  </form>
                ) : (
                  <p className="truncate text-[13px] font-medium">
                    {a.name}
                    {a.isDefault && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{t("(default)")}</span>}
                  </p>
                )}
                <p className="truncate font-mono text-[11.5px] text-muted-foreground" title={a.dir}>{a.dir}</p>
                {a.status === "needs_login" && (
                  <p className="text-xs text-amber-700 dark:text-amber-300">{tool === "claude" ? t("Open Claude Code with this folder and sign in again.") : t("Sign in to Codex again with this folder.")}</p>
                )}
              </div>
              {statusBadge(a)}
              {editing?.id !== a.id && (
                <Button size="xs" variant="ghost" aria-label={t("Rename {name}", { name: a.name })} icon={<Pencil />} disabled={busy} onClick={() => setEditing({ id: a.id, name: a.name })} />
              )}
              {!a.isDefault && editing?.id !== a.id && (
                <Button size="xs" variant="ghost" aria-label={t("Remove {name}", { name: a.name })} icon={<Trash />} disabled={busy} onClick={() => setRemoving(a)} />
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <form
          className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3"
          onSubmit={(e) => { e.preventDefault(); void run(() => api.addAiAccount(tool, name, dir), () => setAdding(false)); }}
        >
          <Field label={t("Name")} id={`${uid}-name`}>
            <Input id={`${uid}-name`} value={name} maxLength={40} placeholder={tool === "claude" ? t("Work") : t("Work")} autoFocus onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={t("Folder")} id={`${uid}-dir`} hint={t(HELP[tool].hint)}>
            <Input id={`${uid}-dir`} value={dir} spellCheck={false} autoComplete="off" className="font-mono" placeholder={HELP[tool].example} onChange={(e) => setDir(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" type="button" onClick={() => setAdding(false)}>{t("Cancel")}</Button>
            <Button size="sm" type="submit" loading={busy} disabled={!name.trim() || !dir.trim()}>{t("Add")}</Button>
          </div>
        </form>
      )}

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

      <Dialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("Remove {name}?", { name: removing?.name ?? "" })}
        description={t("Nookdeck stops reading this {tool} folder. The folder and its sign-in are not touched.", { tool: toolName })}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>{t("Cancel")}</Button>
            <Button variant="destructive" onClick={() => { const a = removing!; setRemoving(null); void run(() => api.removeAiAccount(tool, a.id)); }}>{t("Remove")}</Button>
          </>
        }
      />
    </div>
  );
}

/** The account a quota tile shows: one of them, or (empty) cycle through all. Hidden while the tool has a single account. */
export function QuotaAccountPicker({ tool, value, onChange, id }: { tool: AiAccountTool; value: string | undefined; onChange: (v: string | undefined) => void; id: string }) {
  useLanguage();
  const [list, setList] = useState<AiAccountInfo[]>([]);
  useEffect(() => {
    let live = true;
    api.getAiAccounts().then((r) => live && setList(r[tool]), () => live && setList([]));
    return () => { live = false; };
  }, [tool]);
  if (list.length < 2 && !value) return null;
  const known = list.some((a) => a.id === value);
  return (
    <Field label={tool === "claude" ? t("Account") : t("Profile")} id={id} hint={!value ? t("Tap the tile's name on the phone to show the next one.") : undefined}>
      <Select
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        options={[
          { value: "", label: t("All, tap to switch") },
          ...list.map((a) => ({ value: a.id, label: a.name })),
          ...(value && !known ? [{ value, label: t("{name} (removed)", { name: value }) }] : []),
        ]}
      />
    </Field>
  );
}
