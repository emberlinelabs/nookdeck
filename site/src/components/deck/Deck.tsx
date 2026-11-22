import { useCallback, useEffect, useRef, useState } from 'react';
import '../../styles/deck.css';
import { Ic } from './icons';

export const SCREENS = ['Overview', 'Keys', 'AI', 'Home'] as const;

interface Live {
  now: Date | null;
  cpu: number;
  spark: number[];
  ram: number;
  net: number;
  load: number;
  prog: number;
}

const FIXED = new Date(2026, 10, 18, 12, 11, 4);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const TRACK = 214;

function useLive(playing: boolean, motion: boolean): Live {
  const [l, setL] = useState<Live>({ now: null, cpu: 37, spark: [30, 33, 31, 36, 34, 38, 35, 40, 37, 36, 39, 37], ram: 8.2, net: 2.4, load: 1.2, prog: 83 });
  useEffect(() => {
    const t = setInterval(() => {
      setL((p) => {
        const cpu = motion ? Math.round(clamp(p.cpu + (Math.random() - 0.5) * 12, 22, 58)) : p.cpu;
        return {
          now: new Date(),
          cpu,
          spark: motion ? [...p.spark.slice(1), cpu] : p.spark,
          ram: motion ? Math.round(clamp(p.ram + (Math.random() - 0.5) * 0.2, 7.8, 8.8) * 10) / 10 : p.ram,
          net: motion ? Math.round(clamp(p.net + (Math.random() - 0.5) * 1.4, 0.3, 6.5) * 10) / 10 : p.net,
          load: motion ? Math.round(clamp(p.load + (Math.random() - 0.5) * 0.3, 0.6, 2.4) * 100) / 100 : p.load,
          prog: playing ? (p.prog + 1) % TRACK : p.prog,
        };
      });
    }, 1000);
    return () => clearInterval(t);
  }, [playing, motion]);
  return l;
}

function Spark({ pts, color }: { pts: number[]; color: string }) {
  const max = Math.max(...pts, 60), min = Math.min(...pts, 10);
  const d = pts.map((v, i) => `${(i / (pts.length - 1)) * 76} ${24 - ((v - min) / (max - min || 1)) * 22}`).join(' L');
  return (
    <svg className="dk-spark" viewBox="0 0 76 26" aria-hidden="true">
      <path d={`M${d}`} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Stat({ label, value, unit, color, spark }: { label: string; value: string | number; unit: string; color: string; spark?: number[] }) {
  return (
    <div className="dk-t dk-stat" style={{ ['--c' as string]: color }}>
      <span className="dk-cap">{label}</span>
      <span className="dk-big">{value}<small>{unit}</small></span>
      {spark ? <Spark pts={spark} color={color} /> : <i className="dk-bars" aria-hidden="true" />}
    </div>
  );
}

function Overview({ live, playing, setPlaying }: { live: Live; playing: boolean; setPlaying: (v: boolean) => void }) {
  const d = live.now ?? FIXED;
  const hh = String(d.getHours()).padStart(2, '0'), mi = String(d.getMinutes()).padStart(2, '0'), ss = String(d.getSeconds()).padStart(2, '0');
  const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  return (
    <>
      <div className="dk-t dk-clock" style={{ gridColumn: '1 / 4', gridRow: 1 }}>
        <span className="dk-time">{hh}:{mi}<small>:{ss}</small></span>
        <span className="dk-sub">{day}</span>
      </div>
      <div className="dk-t dk-quota" style={{ gridColumn: '1 / 4', gridRow: 2 }}>
        <div className="dk-qh"><span className="dk-badge" style={{ background: '#e07a52' }}><Ic n="spark" size={13} sw={2.4} /></span><b>Claude</b><em>Max 5x</em><span className="dk-pct">34%<small> 5 hours</small></span></div>
        <div className="dk-bar"><i style={{ width: '34%', background: '#e07a52' }} /></div>
        <span className="dk-sub">34% used · 66% left · resets in 2h 10m</span>
      </div>
      <div className="dk-t dk-weather" style={{ gridColumn: '4 / 6', gridRow: '1 / 3' }}>
        <div className="dk-wh"><b>Home</b><span style={{ color: '#f5c04a' }}><Ic n="sun" size={20} /></span></div>
        <span className="dk-temp">31°</span>
        <span className="dk-sub">Partly cloudy<br />H:34° L:25°</span>
        <div className="dk-hours">
          {[['Now', 'sun', '31°'], ['1 PM', 'sun', '32°'], ['2 PM', 'cloud', '32°'], ['3 PM', 'cloud', '30°']].map(([h, ic, t]) => (
            <span key={h}><em>{h}</em><Ic n={ic} size={15} /><b>{t}</b></span>
          ))}
        </div>
      </div>
      <div className="dk-t dk-np" style={{ gridColumn: '6 / 9', gridRow: '1 / 3' }}>
        <div className="dk-np-top"><span className="dk-art" aria-hidden="true" /><span><b>Midnight Circuit</b><em>Neon Harbor</em></span></div>
        <div className="dk-prog"><i style={{ width: `${(live.prog / TRACK) * 100}%` }} /></div>
        <div className="dk-times"><span>{mmss(live.prog)}</span><span>-{mmss(TRACK - live.prog)}</span></div>
        <div className="dk-ctl">
          <button type="button" aria-label="Previous"><Ic n="prev" size={20} /></button>
          <button type="button" className="dk-pp" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Pause' : 'Play'}><Ic n={playing ? 'pause' : 'play'} size={20} sw={2.6} /></button>
          <button type="button" aria-label="Next"><Ic n="next" size={20} /></button>
        </div>
      </div>
      <div style={{ gridColumn: '1 / 3', gridRow: 3, display: 'grid' }}><Stat label="CPU" value={live.cpu} unit="%" color="#22d3ee" spark={live.spark} /></div>
      <div style={{ gridColumn: '3 / 5', gridRow: 3, display: 'grid' }}><Stat label="RAM" value={live.ram.toFixed(1)} unit="GB" color="#a78bfa" spark={live.spark.map((v) => 70 - v)} /></div>
      <div style={{ gridColumn: '5 / 7', gridRow: 3, display: 'grid' }}><Stat label="Network" value={live.net.toFixed(1)} unit="MB/s" color="#f5a524" spark={live.spark.map((v, i) => (v * (i % 3 + 1)) % 55)} /></div>
      <div style={{ gridColumn: '7 / 9', gridRow: 3, display: 'grid' }}><Stat label="System load" value={live.load.toFixed(2)} unit="" color="#34d399" /></div>
    </>
  );
}

type Key = { n: string; l: string; k: 'cy' | 'am' | 'gr' | 'ap' };
const KEYS: Key[] = [
  { n: 'globe', l: 'Browser', k: 'ap' }, { n: 'terminal', l: 'Terminal', k: 'ap' }, { n: 'code', l: 'Editor', k: 'ap' }, { n: 'folder', l: 'Files', k: 'ap' },
  { n: 'music', l: 'Music', k: 'ap' }, { n: 'chat', l: 'Chat', k: 'ap' }, { n: 'mail', l: 'Mail', k: 'ap' }, { n: 'note', l: 'Notes', k: 'ap' },
  { n: 'copy', l: 'Copy', k: 'cy' }, { n: 'paste', l: 'Paste', k: 'cy' }, { n: 'undo', l: 'Undo', k: 'cy' }, { n: 'redo', l: 'Redo', k: 'cy' },
  { n: 'camera', l: 'Screenshot', k: 'cy' }, { n: 'search', l: 'Spotlight', k: 'cy' }, { n: 'windows', l: 'Windows', k: 'cy' }, { n: 'lock', l: 'Lock', k: 'cy' },
  { n: 'prev', l: 'Previous', k: 'am' }, { n: 'play', l: 'Play / Pause', k: 'am' }, { n: 'next', l: 'Next', k: 'am' }, { n: 'voldown', l: 'Volume down', k: 'am' },
  { n: 'volup', l: 'Volume up', k: 'am' }, { n: 'mute', l: 'Mute', k: 'am' }, { n: 'power', l: 'System', k: 'gr' }, { n: 'home', l: 'Overview', k: 'gr' },
];

function Keys({ press }: { press: (l: string) => void }) {
  return (
    <>
      {KEYS.map((k) => (
        <button type="button" key={k.l} className={`dk-key dk-${k.k}`} onClick={() => press(k.l)} aria-label={k.l}>
          <span className="dk-cap-i"><Ic n={k.n} size={26} /></span>
          <em>{k.l}</em>
        </button>
      ))}
    </>
  );
}

function AI({ ask, setAsk }: { ask: boolean; setAsk: (v: boolean) => void }) {
  const bar = (name: string, tag: string, pct: number, win: string, left: string, color: string, ic: string) => (
    <div className="dk-t dk-quota">
      <div className="dk-qh"><span className="dk-badge" style={{ background: color }}><Ic n={ic} size={13} sw={2.4} /></span><b>{name}</b><em>{tag}</em><span className="dk-pct">{pct}%<small> {win}</small></span></div>
      <div className="dk-bar"><i style={{ width: `${pct}%`, background: color }} /></div>
      <span className="dk-sub">{pct}% used · {100 - pct}% left · {left}</span>
    </div>
  );
  return (
    <>
      <div style={{ gridColumn: '1 / 4', gridRow: '1 / 3', display: 'grid' }}>
        <div className="dk-t dk-ring">
          <div className="dk-qh"><span className="dk-badge" style={{ background: '#e07a52' }}><Ic n="spark" size={13} sw={2.4} /></span><b>Claude</b><em>Max 5x</em></div>
          <div className="dk-ringrow">
            <svg viewBox="0 0 80 80" width="86" height="86" aria-hidden="true"><circle cx="40" cy="40" r="32" fill="none" stroke="#3a2a24" strokeWidth="9" /><circle cx="40" cy="40" r="32" fill="none" stroke="#e07a52" strokeWidth="9" strokeLinecap="round" strokeDasharray={`${0.34 * 201} 201`} transform="rotate(-90 40 40)" /><text x="40" y="46" textAnchor="middle" fill="#fff" fontSize="19" fontWeight="700">34%</text></svg>
            <div className="dk-wins"><span><i style={{ background: '#e07a52' }} />5 hours<b>34%</b></span><em>resets in 2h 10m</em><span><i style={{ background: '#b5614a' }} />7 days<b>61%</b></span><em>resets in 3d 4h</em></div>
          </div>
        </div>
      </div>
      <div style={{ gridColumn: '4 / 7', gridRow: 1, display: 'grid' }}>{bar('Codex', 'Plus', 12, '5 hours', 'resets in 1h 35m', '#6f7cf5', 'terminal')}</div>
      <div style={{ gridColumn: '4 / 7', gridRow: 2, display: 'grid' }}>{bar('Antigravity', '', 5, 'Today', 'resets in 8h', '#4f8cff', 'spark')}</div>
      <div className="dk-t dk-sess" style={{ gridColumn: '7 / 9', gridRow: '1 / 4' }}>
        <span className="dk-cap">AI sessions</span>
        {[['#34d399', 'api-server', 'Codex · gpt-5', '00:22'], ['#f5a524', 'web-app', 'Claude · Opus', '04:02'], ['#6b7280', 'docs', 'Claude · Sonnet', '52 min']].map(([c, n, m, t]) => (
          <div className="dk-s" key={n}><i style={{ background: c }} /><span><b>{n}</b><em>{m}</em></span><time>{t}</time></div>
        ))}
      </div>
      <div style={{ gridColumn: '4 / 6', gridRow: 3, display: 'grid' }}><Stat label="CPU" value="37" unit="%" color="#22d3ee" /></div>
      <div style={{ gridColumn: '6 / 7', gridRow: 3, display: 'grid' }}><Stat label="RAM" value="51" unit="%" color="#f472b6" /></div>
      <div style={{ gridColumn: '1 / 4', gridRow: 3 }} className="dk-t dk-sess-note"><span className="dk-cap">Permission requests</span><span className="dk-sub">Allow or deny from here. No answer in time? It asks in the terminal.</span></div>
      {ask && (
        <div className="dk-ask" role="alertdialog" aria-label="Claude Code is asking you">
          <div className="dk-ask-h"><span className="dk-badge" style={{ background: '#e07a52' }}><Ic n="spark" size={13} sw={2.4} /></span><span><b>Claude Code</b> wants to run a command</span><time>0:58</time></div>
          <code>bun run build</code>
          <div className="dk-ask-b"><button type="button" onClick={() => setAsk(false)}>Deny</button><button type="button" className="dk-allow" onClick={() => setAsk(false)}>Allow</button></div>
        </div>
      )}
    </>
  );
}

function Home({ lamps, toggle }: { lamps: boolean[]; toggle: (i: number) => void }) {
  const dots = ['#ffc9a0', '#ffffff', '#00e5ff', '#ff2bd6', '#ffa500'];
  const lamp = (i: number, name: string, tint: string, bg: string, cols: string, rows: string, dotsOn: boolean) => (
    <button type="button" aria-pressed={lamps[i]} className={`dk-t dk-lamp ${lamps[i] ? 'on' : ''}`} style={{ gridColumn: cols, gridRow: rows, ['--tint' as string]: tint, ['--bg' as string]: bg }} onClick={() => toggle(i)}>
      <span className="dk-lh"><Ic n="bulb" size={20} /><span><b>{name}</b><em>{lamps[i] ? 'On · 80%' : 'Off'}</em></span></span>
      {dotsOn && <span className="dk-dots">{dots.map((c) => <i key={c} style={{ background: c }} />)}</span>}
    </button>
  );
  const key = (n: string, l: string, k: string) => (
    <button type="button" className={`dk-key dk-${k}`} key={l} aria-label={l}><span className="dk-cap-i"><Ic n={n} size={26} /></span><em>{l}</em></button>
  );
  return (
    <>
      <div className="dk-t dk-ac" style={{ gridColumn: '1 / 3', gridRow: '1 / 3' }}>
        <span style={{ color: '#60a5fa' }}><Ic n="snow" size={24} /></span><span className="dk-tag">Cool</span>
        <span className="dk-temp" style={{ color: '#60a5fa', marginTop: 'auto' }}>26°</span><b>Office AC</b><em>Room 27.5° · 62%</em>
      </div>
      {lamp(0, 'RGB Lamp', '#e879f9', '#4a1646', '3 / 6', '1', true)}
      {lamp(1, 'Ball Lamp', '#fbbf24', '#4a3216', '3 / 6', '2', true)}
      {lamp(2, 'Tail Lamp', '#fb923c', '#43301b', '6 / 8', '1', false)}
      <div className="dk-t dk-sensor" style={{ gridColumn: '6 / 8', gridRow: 2 }}><Ic n="sun" size={18} /><b>28.4<small>°C</small></b><em>Temperature</em></div>
      <div className="dk-t dk-pur" style={{ gridColumn: 8, gridRow: '1 / 3' }}><Ic n="power" size={20} /><b>Purifier</b><em>On · 60%</em></div>
      {[key('bulb', 'Lights on', 'am'), key('bulb', 'Lights off', 'gr'), key('snow', 'AC 26°', 'cy'), key('power', 'AC off', 'gr'), key('target', 'Focus', 'in'), key('moon', 'Night', 'in'), key('home', 'Home', 'gr'), key('home', 'Overview', 'gr')].map((k, i) => <span key={i} style={{ gridRow: 3, display: 'contents' }}>{k}</span>)}
    </>
  );
}

export interface DeckProps {
  /** Controlled screen index (0 Overview, 1 Keys, 2 AI, 3 Home). Omit to let the deck own it. */
  screen?: number;
  /** Cycle through the screens by itself until a visitor touches it. */
  auto?: boolean;
  /** Show the Claude Code permission prompt on the AI screen straight away. */
  askNow?: boolean;
  /** Show the page dots. Default true. */
  pager?: boolean;
  className?: string;
}

export default function Deck({ screen, auto = false, askNow = false, pager = true, className }: DeckProps) {
  const [own, setOwn] = useState(0);
  const cur = screen ?? own;
  const [scale, setScale] = useState(0);
  const [motion, setMotion] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [toast, setToast] = useState('');
  const [ask, setAsk] = useState(true);
  const [lamps, setLamps] = useState([true, true, false]);
  const touched = useRef(0);
  const fit = useRef<HTMLDivElement>(null);
  const live = useLive(playing, motion);

  useEffect(() => {
    const el = fit.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 880));
    ro.observe(el);
    setScale(el.clientWidth / 880);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const m = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    setMotion(!m);
  }, []);

  useEffect(() => {
    if (!auto || !motion) return;
    const t = setInterval(() => {
      if (Date.now() - touched.current < 14000) return;
      setOwn((c) => (c + 1) % SCREENS.length);
    }, 5200);
    return () => clearInterval(t);
  }, [auto, motion]);

  useEffect(() => {
    if (cur === 2 && !askNow) { setAsk(false); const t = setTimeout(() => setAsk(true), 1400); return () => clearTimeout(t); }
  }, [cur]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 1300);
    return () => clearTimeout(t);
  }, [toast]);

  const go = useCallback((i: number) => { touched.current = Date.now(); setOwn(i); }, []);
  const press = (l: string) => { touched.current = Date.now(); setToast(l); };

  return (
    <div className={`dk-fit ${className ?? ''}`} ref={fit} style={{ height: scale ? 426 * scale : undefined, aspectRatio: scale ? undefined : '880 / 426' }} onPointerDown={() => (touched.current = Date.now())}>
      <div className="dk-phone" style={{ transform: `scale(${scale || 1})`, opacity: scale ? 1 : 0 }} role="group" aria-label="Live demo of a Nookdeck screen. Tap the tiles.">
        <div className="dk-screen">
          <i className="dk-cam" aria-hidden="true" />
          <div className="dk-head"><span className="dk-live" /><b>My computer</b><span>CPU {live.cpu}%</span><span>RAM {Math.round((live.ram / 16) * 100)}%</span><em>{SCREENS[cur]}</em></div>
          {SCREENS.map((s, i) => (
            <div key={s} className={`dk-grid ${i === cur ? 'on' : ''}`} aria-hidden={i !== cur} inert={i !== cur}>
              {i === 0 && <Overview live={live} playing={playing} setPlaying={setPlaying} />}
              {i === 1 && <Keys press={press} />}
              {i === 2 && <AI ask={ask} setAsk={setAsk} />}
              {i === 3 && <Home lamps={lamps} toggle={(n) => setLamps((p) => p.map((v, j) => (j === n ? !v : v)))} />}
            </div>
          ))}
          <div className={`dk-toast ${toast ? 'on' : ''}`} role="status">{toast && `${toast} · sent`}</div>
          {pager && <div className="dk-pager" role="tablist" aria-label="Screens">
            {SCREENS.map((s, i) => (
              <button key={s} type="button" role="tab" aria-selected={i === cur} aria-label={s} className={i === cur ? 'on' : ''} onClick={() => go(i)} />
            ))}
          </div>}
        </div>
      </div>
    </div>
  );
}
