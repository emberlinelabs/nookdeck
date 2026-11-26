import { useState } from "react";
import { IconBrandGithub as Github, IconCheck as Check, IconCopy as Copy, IconDownload as Download, IconFileText as FileText } from "@tabler/icons-react";
import { api } from "@/api";
import { Button } from "@/components/ui/knowns/button";
import { Card, CardContent } from "@/components/ui/knowns/card";
import { Textarea } from "@/components/ui/knowns/textarea";
import { t, useLanguage } from "@/lib/i18n";
import { issueUrl } from "@/lib/report";

/**
 * "Report a problem": the agent builds a masked report (GET /api/report). It is shown here first and can be edited; nothing leaves
 * the computer until "Open a GitHub issue" (which opens GitHub in the browser with the report) or a copy.
 */
export function ReportCard() {
  useLanguage();
  const [report, setReport] = useState<{ title: string; markdown: string; repo: string } | null>(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const create = async () => {
    setLoading(true); setError("");
    try {
      const r = await api.getReport();
      setReport(r);
      setText(r.markdown);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); return true; } catch { return false; }
  };
  const openIssue = async () => {
    if (!report) return;
    const { url, inline } = issueUrl(report.repo, report.title, text);
    if (!inline) await copy();
    window.open(url, "_blank", "noopener,noreferrer");
  };
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    a.download = `nookdeck-report-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <Card id="report" className="max-w-3xl">
      <CardContent className="flex flex-col gap-3 p-4">
        <h3 className="text-[15px] font-semibold">{t("Report a problem")}</h3>
        <p className="text-[13px] text-muted-foreground">
          {t("Collects the version, system, permission checks, phones, connection drops and the end of the error log into one report. Personal details (home folder, computer name, IP addresses, PIN, tokens) are masked. Check it before you send it.")}
        </p>
        {!report ? (
          <div><Button size="sm" icon={<FileText />} loading={loading} onClick={() => void create()}>{t("Create report")}</Button></div>
        ) : (
          <>
            <Textarea value={text} onChange={(e) => setText(e.currentTarget.value)} autosize minRows={8} maxRows={20} className="kn-scroll font-mono text-xs" aria-label={t("Report")} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<Github />} onClick={() => void openIssue()}>{t("Open a GitHub issue")}</Button>
              <Button size="sm" variant="secondary" icon={copied ? <Check /> : <Copy />} onClick={() => void copy()}>{copied ? t("Copied") : t("Copy")}</Button>
              <Button size="sm" variant="secondary" icon={<Download />} onClick={download}>{t("Download")}</Button>
              <Button size="sm" variant="secondary" loading={loading} onClick={() => void create()}>{t("Create again")}</Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("A long report is copied to the clipboard: paste it into the issue that opens.")}</p>
          </>
        )}
        {error && <p className="text-[13px] text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
