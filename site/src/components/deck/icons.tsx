import type { ReactNode } from 'react';

const P: Record<string, ReactNode> = {
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>,
  paste: <><rect x="8" y="3" width="8" height="4" rx="1" /><path d="M16 5h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  camera: <><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" /><circle cx="12" cy="13" r="3" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>,
  windows: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  lock: <><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>,
  prev: <><path d="M19 20 9 12l10-8z" /><path d="M5 19V5" /></>,
  play: <path d="M7 4l13 8-13 8z" />,
  pause: <><path d="M8 5v14" /><path d="M16 5v14" /></>,
  next: <><path d="m5 4 10 8-10 8z" /><path d="M19 5v14" /></>,
  voldown: <><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /></>,
  volup: <><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M19 5a9 9 0 0 1 0 14" /></>,
  mute: <><path d="M11 5 6 9H2v6h4l5 4z" /><path d="m22 9-6 6" /><path d="m16 9 6 6" /></>,
  terminal: <><path d="m4 17 6-6-6-6" /><path d="M12 19h8" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" /></>,
  code: <><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></>,
  folder: <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.600 3.900A2 2 0 0 0 7.900 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z" />,
  music: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
  chat: <path d="M7.900 20A9 9 0 1 0 4 16.100L2 22z" />,
  mail: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-8.970 5.700a1.940 1.940 0 0 1-2.060 0L2 7" /></>,
  note: <><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></>,
  snow: <><path d="M12 2v20" /><path d="M2 12h20" /><path d="m4.900 4.900 14.200 14.200" /><path d="m19.100 4.900-14.200 14.200" /></>,
  bulb: <><path d="M15 14c.2-1 .7-1.700 1.500-2.500 1-.9 1.500-2.200 1.500-3.500A6 6 0 0 0 6 8c0 1 .2 2.200 1.500 3.500.7.7 1.300 1.500 1.500 2.500" /><path d="M9 18h6" /><path d="M10 22h4" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.900 4.900l1.400 1.400M17.700 17.700l1.400 1.400M2 12h2M20 12h2M4.900 19.100l1.400-1.400M17.700 6.300l1.400-1.400" /></>,
  cloud: <path d="M17.500 19H9a7 7 0 1 1 6.700-9h1.800a4.500 4.500 0 0 1 0 9z" />,
  moon: <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />,
  home: <><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M9 22V12h6v10" /></>,
  target: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>,
  spark: <><path d="M12 3v18" /><path d="M3 12h18" /><path d="m5.600 5.600 12.800 12.800" /><path d="m18.400 5.600-12.800 12.800" /></>,
  power: <><path d="M12 2v10" /><path d="M18.400 6.600a9 9 0 1 1-12.800 0" /></>,
};

export function Ic({ n, size = 24, sw = 2 }: { n: string; size?: number; sw?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[n]}
    </svg>
  );
}
