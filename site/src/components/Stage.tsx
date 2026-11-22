import { useState } from 'react';
import { ShowcaseStage } from '@/components/ui/knowns/illustrations/showcase-stage/showcase-stage';
import Deck from './deck/Deck';
import { cn, focusRing } from '@/lib/knowns/utils';

export interface StageProps {
  label: string;
  tabs: string[];
  lines: string[];
  comments: string[][];
}

// Tab -> phone screen: Control = Keys, Glance = Overview, AI coding = AI, Home = Home.
const SCREEN_FOR = [1, 0, 2, 3];
const TARGETS = [
  ['.dk-grid.on .dk-cy', '.dk-grid.on .dk-ap', '.dk-grid.on .dk-am'],
  ['.dk-grid.on .dk-clock', '.dk-grid.on .dk-weather', '.dk-grid.on .dk-np', '.dk-grid.on .dk-stat'],
  ['.dk-grid.on .dk-ring', '.dk-grid.on .dk-sess'],
  ['.dk-grid.on .dk-ac', '.dk-grid.on .dk-lamp', '.dk-grid.on .dk-in'],
];

export default function Stage({ label, tabs, lines, comments }: StageProps) {
  const [tab, setTab] = useState(0);
  return (
    <div className="nd-stage-wrap">
      <div className="nd-tabs" role="tablist" aria-label={label}>
        {tabs.map((t, i) => (
          <button key={t} role="tab" type="button" id={`stage-tab-${i}`} aria-selected={i === tab} aria-controls="stage-panel" tabIndex={i === tab ? 0 : -1} onClick={() => setTab(i)}
            onKeyDown={(e) => { if (e.key === 'ArrowRight') setTab((tab + 1) % tabs.length); if (e.key === 'ArrowLeft') setTab((tab + tabs.length - 1) % tabs.length); }}
            className={cn('nd-tab', focusRing)}>{t}</button>
        ))}
      </div>
      <p className="nd-tabline" aria-live="polite">{lines[tab]}</p>
      <div id="stage-panel" role="tabpanel" aria-labelledby={`stage-tab-${tab}`} data-theme="dark" className="nd-stage-dark">
        <ShowcaseStage
          key={tab}
          label={label}
          comments={comments[tab].map((text, i) => ({ target: TARGETS[tab][i], text }))}
        >
          <div className="nd-stage-deck"><Deck screen={SCREEN_FOR[tab]} pager={false} /></div>
        </ShowcaseStage>
      </div>
    </div>
  );
}
