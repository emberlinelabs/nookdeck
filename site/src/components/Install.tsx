import { useState } from 'react';
import { CommandChip } from '@/components/ui/knowns/blocks/marketing/hero';
import { cn, focusRing } from '@/lib/knowns/utils';

export interface InstallProps {
  label: string;
  mac: string;
  win: string;
  macHint: string;
  winHint: string;
  toggleLabel: string;
  commands: { mac: string; win: string };
  idPrefix?: string;
  big?: boolean;
}

export default function Install(p: InstallProps) {
  const [os, setOs] = useState<'mac' | 'win'>(() => {
    try {
      return /Win/i.test(navigator.platform || '') ? 'win' : 'mac';
    } catch {
      return 'mac';
    }
  });
  const id = p.idPrefix ?? 'i';
  const tabs: Array<'mac' | 'win'> = ['mac', 'win'];
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tabs[(i + 1) % tabs.length];
    setOs(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  };
  return (
    <div className="nd-install w-full min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="nd-install-label">{p.label}</span>
        <div role="tablist" aria-label={p.toggleLabel} className="nd-seg">
          {tabs.map((t, i) => (
            <button
              key={t}
              id={`${id}-tab-${t}`}
              role="tab"
              type="button"
              aria-selected={os === t}
              aria-controls={`${id}-panel`}
              tabIndex={os === t ? 0 : -1}
              onClick={() => setOs(t)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn('nd-seg-b', focusRing)}
            >
              {p[t]}
            </button>
          ))}
        </div>
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${os}`}>
        <CommandChip command={p.commands[os]} className={cn('nd-cmd', p.big && 'nd-cmd-big')} />
        <p className="nd-hint" aria-live="polite">{os === 'mac' ? p.macHint : p.winHint}</p>
      </div>
    </div>
  );
}
