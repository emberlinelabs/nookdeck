import { useState } from "react";
import { IconCoffee as Coffee, IconStar as Star } from "@tabler/icons-react";
import { Button } from "@/components/ui/knowns/button";
import { t, useLanguage } from "@/lib/i18n";
import { GITHUB_URL, KOFI_URL, answer, shouldAsk } from "@/lib/support";

const store = () => window.localStorage;
const LINK = "inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1 font-medium transition-colors hover:bg-muted";

/** Asked once, a few days in. It never covers anything, and nothing leaves the computer unless a link is clicked. */
export function SupportCard() {
  useLanguage();
  const [open, setOpen] = useState(() => shouldAsk(store, Date.now()));
  if (!open) return null;
  const close = (choice: "later" | "done") => {
    answer(store, Date.now(), choice);
    setOpen(false);
  };
  return (
    <aside aria-label={t("Support Nookdeck")} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-muted/40 px-3.5 py-2.5 text-[13px]">
      <span className="font-medium">{t("Enjoying Nookdeck? Star it on GitHub")}</span>
      <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className={LINK} onClick={() => close("done")}>
        <Star className="size-3.5" />{t("Star on GitHub")}
      </a>
      <a href={KOFI_URL} target="_blank" rel="noopener noreferrer" className={LINK} onClick={() => close("done")}>
        <Coffee className="size-3.5" />{t("Support on Ko-fi")}
      </a>
      <span className="ml-auto flex flex-wrap gap-1">
        <Button size="xs" variant="secondary" onClick={() => close("later")}>{t("Later")}</Button>
        <Button size="xs" variant="secondary" onClick={() => close("done")}>{t("Don't show again")}</Button>
      </span>
    </aside>
  );
}
