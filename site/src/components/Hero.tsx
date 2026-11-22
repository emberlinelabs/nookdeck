import { ScrollOverHero } from '@/components/ui/knowns/blocks/marketing/scroll-over-hero';
import Deck from './deck/Deck';
import { AnnouncementPill } from '@/components/ui/knowns/blocks/site/announcement-pill';
import Install, { type InstallProps } from './Install';

export interface HeroProps {
  title: string;
  sub: string;
  github: { label: string; href: string };
  window: string;
  install: Omit<InstallProps, 'idPrefix' | 'big'> & { note: string };
  soon: { label: string; text: string; title: string; desc: string; items: string[]; link: string; href: string };
}

export default function Hero({ title, sub, github, window: win, install, soon }: HeroProps) {
  const { note, ...inst } = install;
  return (
    <ScrollOverHero
      eyebrow={
        <AnnouncementPill
          label={soon.label}
          text={soon.text}
          card={{ title: soon.title, description: soon.desc, items: soon.items, link: { label: `${soon.link} →`, href: soon.href } }}
        />
      }
      title={title}
      description={sub}
      windowTitle={['Nookdeck', win]}
      scrollLength={0.8}
      extra={
        <div className="nd-hero-install">
          <Install {...inst} idPrefix="hero" big />
          <p className="nd-fine">
            {note} <a className="nd-link" href={github.href}>{github.label} <span aria-hidden="true">→</span></a>
          </p>
        </div>
      }
      media={
        <div className="nd-heromedia" data-theme="dark">
          <div className="nd-heromedia-in"><Deck auto /></div>
        </div>
      }
    />
  );
}
