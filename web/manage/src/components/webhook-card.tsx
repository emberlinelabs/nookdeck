import { useState } from "react";
import { IconCheck as Check, IconCopy as Copy, IconRefresh as Refresh } from "@tabler/icons-react";
import { Alert } from "@/components/ui/knowns/alert";
import { Badge } from "@/components/ui/knowns/badge";
import { Button } from "@/components/ui/knowns/button";
import { Card, CardContent } from "@/components/ui/knowns/card";
import { Dialog } from "@/components/ui/knowns/dialog";
import { Spinner } from "@/components/ui/knowns/spinner";
import { api } from "@/api";
import { Icon } from "@/components/icon";
import { t } from "@/lib/i18n";
import { useWebhook } from "@/lib/webhook";

/** Webhook: key for pushing values / notifications / page changes from other machines in the LAN. */
export function WebhookCard() {
  const { info, missing, error, reload } = useWebhook();
  const [copied, setCopied] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      /* clipboard unavailable: the text is selectable */
    }
  };

  const rotate = async () => {
    setConfirm(false);
    setBusy(true);
    setNotice(null);
    try {
      await api.rotateWebhook();
      await reload();
      setNotice({ tone: "success", text: t("Key changed. Update the new key everywhere that calls the webhook.") });
    } catch (e) {
      setNotice({ tone: "danger", text: t("Could not change the key: {error}", { error: e instanceof Error ? e.message : String(e) }) });
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async () => {
    try {
      const k = await api.revealWebhookKey();
      if (k) await copy("key", k);
    } catch (e) {
      setNotice({ tone: "danger", text: t("Could not get the key: {error}", { error: e instanceof Error ? e.message : String(e) }) });
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-xl border bg-muted/50"><Icon name="link" size={22} /></span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold leading-tight">Webhook</h3>
            <p className="text-xs text-muted-foreground">{t("Let other machines on the network push values, notifications or screen changes to the phone")}</p>
          </div>
          {missing ? <Badge tone="neutral" dot>{t("Agent not supported")}</Badge> : !info && !error ? <Spinner label={t("Loading")} /> : info ? <Badge tone="success" dot>{t("Ready")}</Badge> : <Badge tone="danger" dot>{t("Error")}</Badge>}
        </div>
        {missing && <Alert tone="info">{t("This agent does not have /api/webhook yet (404). Update the agent and reload the page.")}</Alert>}
        {error && !missing && <Alert tone="danger" action={{ label: t("Retry"), onClick: () => void reload() }}>{error}</Alert>}
        {notice && <Alert tone={notice.tone} onDismiss={() => setNotice(null)}>{notice.text}</Alert>}
        {info && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Webhook key</span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-muted px-2.5 py-1.5 text-xs" aria-label={t("Masked key")}>{info.keyMasked}</code>
                <Button size="sm" variant="secondary" icon={copied === "key" ? <Check /> : <Copy />} onClick={() => void copyKey()}>{copied === "key" ? t("Copied") : t("Copy key")}</Button>
                <Button size="sm" variant="destructive" icon={<Refresh />} loading={busy} onClick={() => setConfirm(true)}>{t("Change key")}</Button>
              </div>
              <p className="text-[11.5px] text-muted-foreground">{t("Other machines on the LAN send this key in the Authorization: Bearer header. The key can only call the webhook, not the phone control API. Calls from this machine also need the header X-Nookdeck: 1.")}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">{t("Example (replace <KEY> with the copied key)")}</span>
              {info.examples.map((cmd, i) => (
                <div key={i} className="flex items-start gap-2">
                  <code className="min-w-0 flex-1 select-all break-all rounded-lg bg-muted px-2.5 py-1.5 text-[11.5px]">{cmd}</code>
                  <Button size="xs" variant="secondary" aria-label={t("Copy command")} icon={copied === `ex${i}` ? <Check /> : <Copy />} onClick={() => void copy(`ex${i}`, cmd)} />
                </div>
              ))}
            </div>
            <p className="text-[11.5px] text-muted-foreground">{t("Other machines on the LAN paste the key into the Authorization: Bearer header.")}</p>
          </>
        )}
      </CardContent>
      <Dialog open={confirm} onOpenChange={setConfirm} title={t("Change webhook key?")} description={t("The old key stops working immediately.")}
        size="md"
        footer={<><Button variant="secondary" onClick={() => setConfirm(false)}>{t("Cancel")}</Button><Button variant="destructive" onClick={() => void rotate()}>{t("Change key")}</Button></>}>
        <p className="text-sm">{t("Every script or machine using the old key will be rejected until you update to the new key.")}</p>
      </Dialog>
    </Card>
  );
}
