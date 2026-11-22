import { FooterWordmark } from '@/components/ui/knowns/blocks/marketing/footer-wordmark';

export default function FooterW(p: { made: string; formerly: string; credits: string; license: string; links: Array<{ label: string; href: string }> }) {
  return (
    <FooterWordmark
      word="Nookdeck"
      tagline={p.made}
      links={p.links}
      copyright={<>{p.license}. {p.formerly} {p.credits}</>}
      className="nd-footer"
    />
  );
}
