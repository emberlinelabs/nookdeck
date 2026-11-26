/**
 * A GitHub "new issue" URL for the "Report a problem" card. The report goes in the URL only when it fits (GitHub refuses very long
 * URLs); otherwise the issue page asks to paste it, and the card copies it to the clipboard first. Pure.
 */
export function issueUrl(repo: string, title: string, body: string, max = 6000): { url: string; inline: boolean } {
  const base = `${repo.replace(/\/+$/, "")}/issues/new?title=${encodeURIComponent(title)}`;
  const full = `${base}&body=${encodeURIComponent(body)}`;
  if (full.length <= max) return { url: full, inline: true };
  return { url: `${base}&body=${encodeURIComponent("<!-- Describe the problem here, then paste the Nookdeck report below (it was copied to the clipboard). -->\n\n")}`, inline: false };
}
