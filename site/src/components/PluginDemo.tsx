import { useEffect, useState } from 'react';
import '../styles/deck.css';

export interface PluginDemoProps {
  fileLabel: string;
  tileLabel: string;
  consent: { label: string; name: string; id: string; unreviewed: string; lead: string; network: string; cancel: string; allow: string };
}

const J = ({ k, children }: { k?: boolean; children: string }) => <span className={k ? 'j-k' : 'j-s'}>{children}</span>;

export default function PluginDemo({ fileLabel, tileLabel, consent }: PluginDemoProps) {
  const [price, setPrice] = useState(67412);
  const [delta, setDelta] = useState(0.4);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => {
      setPrice((p) => {
        const n = Math.round(p + (Math.random() - 0.48) * 60);
        setDelta(Math.round(((n - 67412) / 67412) * 1000) / 10);
        return n;
      });
    }, 2200);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="nd-pd">
      <figure className="nd-file">
        <figcaption>{fileLabel}</figcaption>
        <pre><code>
{'{\n  '}<J k>"id"</J>{': '}<J>"dev.alice.crypto"</J>{',\n  '}<J k>"nookdeck"</J>{': '}<J>{'">=0.2.0"'}</J>{',\n  '}<J k>"permissions"</J>{': { '}<J k>"network"</J>{': ['}<J>"api.coingecko.com"</J>{'] },\n  '}<J k>"widgets"</J>{': [{\n    '}<J k>"render"</J>{': '}<J>"stat"</J>{',\n    '}<J k>"sizes"</J>{': ['}<J>"2x1"</J>{', '}<J>"2x2"</J>{'],\n    '}<J k>"source"</J>{': {\n      '}<J k>"http"</J>{': { '}<J k>"url"</J>{': '}<J>"https://api.coingecko.com/…"</J>{',\n               '}<J k>"every"</J>{': 60 },\n      '}<J k>"map"</J>{': {\n        '}<J k>"value"</J>{': '}<J>"$.bitcoin.usd"</J>{',\n        '}<J k>"unit"</J>{': '}<J>"USD"</J>{',\n        '}<J k>"label"</J>{': '}<J>"bitcoin"</J>{'\n      }\n    }\n  }]\n}'}
        </code></pre>
      </figure>
      <div className="nd-pd-right">
        <figure className="nd-tilewrap">
          <div className="dk-screen nd-mini">
            <div className="dk-t dk-stat" style={{ ['--c' as string]: '#34d399' }}>
              <span className="dk-cap" style={{ color: '#8c95a1' }}>bitcoin</span>
              <span className="dk-big" style={{ fontSize: 40 }}>{price.toLocaleString('en-US')}<small style={{ fontSize: 15 }}>USD</small></span>
              <span className="dk-sub" style={{ color: delta >= 0 ? '#34d399' : '#f87171' }}>{delta >= 0 ? '↑' : '↓'} {Math.abs(delta)}%</span>
            </div>
          </div>
          <figcaption>{tileLabel}</figcaption>
        </figure>
        <figure className="nd-consent" aria-label={consent.label}>
          <div className="nd-consent-card">
            <div className="nd-consent-h">
              <b>{consent.name}</b>
              <code>{consent.id}</code>
              <span>{consent.unreviewed}</span>
            </div>
            <p>{consent.lead}</p>
            <div className="nd-access"><em>{consent.network}</em><code>api.coingecko.com</code></div>
            <div className="nd-consent-b">
              <button type="button" onClick={() => setOn(false)}>{consent.cancel}</button>
              <button type="button" className={on ? 'on' : ''} onClick={() => setOn(true)} aria-pressed={on}>{on ? '✓ ' : ''}{consent.allow}</button>
            </div>
          </div>
          <figcaption>{consent.label}</figcaption>
        </figure>
      </div>
    </div>
  );
}
