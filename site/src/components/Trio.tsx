import { FeatureTrio } from '@/components/ui/knowns/blocks/marketing/feature-trio';
import Deck from './deck/Deck';
import PluginDemo, { type PluginDemoProps } from './PluginDemo';

export interface TrioProps {
  plugins: { mark: string; lead: string; text: string; cta: string; href: string; tileLabel: string; consent: PluginDemoProps['consent'] };
  privacy: { mark: string; lead: string; text: string; cta: string; href: string; pin: string };
  old: { mark: string; lead: string; text: string; sizes: string };
  fileLabel: string;
}

export default function Trio({ plugins, privacy, old, fileLabel }: TrioProps) {
  const pin = ['4', '0', '7', '1', '9', '2'];
  return (
    <FeatureTrio
      className="nd-trio"
      cards={[
        {
          mark: plugins.mark,
          lead: plugins.lead,
          text: plugins.text,
          visual: (
            <div>
              <PluginDemo fileLabel={fileLabel} tileLabel={plugins.tileLabel} consent={plugins.consent} />
              <a className="nd-link nd-trio-link" href={plugins.href}>{plugins.cta} <span aria-hidden="true">→</span></a>
            </div>
          ),
        },
        {
          mark: privacy.mark,
          lead: privacy.lead,
          text: privacy.text,
          visual: (
            <div className="nd-pair">
              <span className="nd-pair-l">{privacy.pin}</span>
              <span className="nd-pins" role="img" aria-label={privacy.pin}>{pin.map((d, i) => <i key={i} style={{ ['--i' as string]: i }}>{d}</i>)}</span>
              <a className="nd-link" href={privacy.href}>{privacy.cta} <span aria-hidden="true">→</span></a>
            </div>
          ),
        },
        {
          mark: old.mark,
          lead: old.lead,
          text: old.text,
          visual: (
            <div className="nd-old">
              <div className="nd-old-deck" data-theme="dark"><Deck screen={3} pager={false} /></div>
              <p className="nd-fine">{old.sizes}</p>
            </div>
          ),
        },
      ]}
    />
  );
}
