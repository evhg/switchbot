/* Shared shell, data and chart helpers for the Precision Instrument mocks. */
(function () {
  const q = new URLSearchParams(location.search);
  const forced = q.get('theme') || document.documentElement.dataset.forceTheme;
  if (forced) document.documentElement.dataset.theme = forced;
  if (q.get('still') || matchMedia('(prefers-reduced-motion: reduce)').matches) document.documentElement.classList.add('still');
})();

const ICON = {
  today: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z"/>',
  room: '<path d="M4 10.5 12 4l8 6.5V20H4z"/><path d="M10 20v-5h4v5"/>',
  body: '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>',
  lab: '<path d="M9 3h6M10 3v6l-5.5 9.5A1.6 1.6 0 0 0 5.9 21h12.2a1.6 1.6 0 0 0 1.4-2.5L14 9V3"/><path d="M7.5 15h9"/>',
  system: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  chev: '<path d="m9 5 7 7-7 7"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};
const svgI = (n, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;

const TABS = [['today', 'Today'], ['room', 'Room'], ['body', 'Body'], ['lab', 'Lab'], ['system', 'System']];
function renderShell(active) {
  const rail = document.querySelector('.rail');
  if (rail) rail.innerHTML = `
    <div class="brand"><i></i>Sleep Lab</div>
    <div class="nightpick">
      <div class="t"><b>Thu 29 Oct</b><span>Night of Wed 28</span></div>
      <button class="iconbtn" aria-label="Previous night">${svgI('left')}</button>
      <button class="iconbtn" aria-label="Next night" disabled>${svgI('right')}</button>
    </div>
    <nav class="nav">${TABS.map(([k, l]) => `<a href="#" ${k === active ? 'aria-current="page"' : ''}>${svgI(k)}${l}</a>`).join('')}</nav>
    <div class="grow"></div>
    <div class="live">
      <div class="row"><span>Bedroom now</span><b class="num">24.6°</b></div>
      <div class="row"><span>CO₂</span><b class="num">612 ppm</b></div>
      <div class="row"><span>Humidity</span><b class="num">58%</b></div>
      <div class="src"><span class="dot"></span>Simulated data · 14:55</div>
    </div>`;
  const tb = document.querySelector('.tabbar');
  if (tb) tb.innerHTML = TABS.map(([k, l]) => `<a href="#" ${k === active ? 'aria-current="page"' : ''}>${svgI(k)}${l}</a>`).join('');
  const top = document.querySelector('.topbar');
  if (top) addEventListener('scroll', () => top.classList.toggle('scrolled', scrollY > 4), { passive: true });
}

/* ---------- Reveal on scroll ---------- */
function initReveal() {
  const els = document.querySelectorAll('.rv');
  if (document.documentElement.classList.contains('still')) { els.forEach((e) => e.classList.add('in')); return; }
  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -12% 0px' });
  els.forEach((e) => io.observe(e));
}

/* ---------- Data (mirrors the simulator's night of Wed 28 → Thu 29 Oct) ---------- */
const M = (h, m) => (h < 12 ? h + 24 : h) * 60 + m;          // minutes, night-continuous
const clock = (t) => { t = Math.round(t) % 1440; return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
function rng(seed) { return function () { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const NIGHT = { x0: M(23, 0), x1: M(7, 0), lightsOut: M(23, 17), wake: M(6, 40) };
const STAGES = ['Awake', 'REM', 'Light', 'Deep'];

function hypno(seed, inBed, onset, end, deepPlan, remPlan) {
  const r = rng(seed); const seg = [];
  const push = (s, e, st) => { if (e > s) seg.push({ s, e, st }); };
  push(inBed, onset, 0);
  let t = onset, c = 0;
  while (t < end - 5) {
    const L1 = 14 + r() * 14, D = deepPlan[c] ?? 0, L2 = 8 + r() * 10, R = remPlan[c] ?? 30;
    for (const [len, st] of [[L1, 2], [D, 3], [L2, 2], [R, 1]]) { const e = Math.min(end, t + len); push(t, e, st); t = e; if (t >= end) break; }
    if (t < end - 20 && r() < .55) { const e = t + 2 + r() * 4; push(t, e, 0); t = e; }
    c++;
  }
  push(t, end, 0);
  return seg;
}
const HYP = {
  you: hypno(7, M(23, 34), M(23, 52), NIGHT.wake, [38, 30, 14, 6, 0], [9, 17, 24, 29, 34]),
  erik: hypno(11, M(23, 12), M(23, 29), NIGHT.wake, [34, 23, 18, 8, 0], [10, 16, 22, 30, 36]),
};
const stageAt = (seg, t) => { for (const s of seg) if (t >= s.s && t < s.e) return s.st; return -1; };

/* Plan (relative to lights-out 23:17) */
const PLAN = [
  { name: 'Pre-cool', rel: -90, temp: 20.5 },
  { name: 'Falling asleep', rel: 0, temp: 20.0 },
  { name: 'Deep window', rel: 40, temp: 19.0 },
  { name: 'Middle', rel: 240, temp: 19.0, ramp: true },
  { name: 'Late / REM', rel: 360, temp: 21.5 },
  { name: 'Wake', rel: 450, temp: 22.0 },
];
const relFmt = (m) => (m < 0 ? '−' : '+') + Math.floor(Math.abs(m) / 60) + ':' + String(Math.abs(m) % 60).padStart(2, '0');
function planAt(t, plan = PLAN, lo = NIGHT.lightsOut) {
  let v = plan[0].temp;
  for (let i = 0; i < plan.length; i++) {
    const s = lo + plan[i].rel; const n = plan[i + 1];
    if (t >= s) {
      v = plan[i].temp;
      if (plan[i].ramp && n) { const ns = lo + n.rel; if (t < ns) v = plan[i].temp + (n.temp - plan[i].temp) * (t - s) / (ns - s); else v = n.temp; }
    }
  }
  return v;
}
/* Room temperature (°C), 21:30 → 07:00 */
function roomTemp(t) {
  const r = Math.sin(t * 0.37) * .06 + Math.sin(t * 0.091) * .08;
  if (t < M(21, 47)) return 29.0 + r * .5;
  if (t < M(23, 17)) { const k = (t - M(21, 47)); return 20.2 + 8.8 * Math.exp(-k / 19) + (k > 64 ? 0 : 0) + r; }
  const pts = [[M(23, 17), 20.2], [M(23, 57), 19.4], [M(0, 30), 19.1], [M(2, 52), 19.2], [M(3, 55), 19.4], [M(4, 29), 20.3], [M(4, 58), 21.0], [M(5, 48), 22.2], [M(6, 40), 21.7], [M(7, 0), 21.8]];
  for (let i = 0; i < pts.length - 1; i++) if (t <= pts[i + 1][0]) { const [a, va] = pts[i], [b, vb] = pts[i + 1]; const k = (t - a) / (b - a); const e = k * k * (3 - 2 * k); return va + (vb - va) * e + r; }
  return 21.8 + r;
}
/* CO₂ ppm: 570 at lights-out, crosses 1,000 at 02:44, peaks 1,257 at 06:40 (clamped: one truth) */
function co2(t) {
  if (t <= NIGHT.lightsOut) return 570;
  const k = (t - NIGHT.lightsOut) / (NIGHT.wake - NIGHT.lightsOut);
  const base = 570 + 687 * (1 - Math.pow(1 - k, 1.62));
  const n = Math.sin(t * .7) * 6 + Math.sin(t * .23) * 9;
  return Math.min(1257, Math.round(base + (t >= NIGHT.wake ? 0 : n * (k < .98 ? 1 : 0))));
}
const AIRCON = [
  { t: M(21, 47), set: '20°', what: 'Curve · pre-cool start, target 20.5°' },
  { t: M(23, 17), set: '20°', what: 'Curve · onset, fan low' },
  { t: M(23, 57), set: '19°', what: 'Curve · deep phase, target 19°' },
  { t: M(3, 55), set: '20°', what: 'Correction · +1 (room 0.6° below target)' },
  { t: M(4, 29), set: '21°', what: 'Curve · middle phase, target 20.5°' },
  { t: M(4, 58), set: '22°', what: 'Curve · middle phase, target 21.1°' },
  { t: M(7, 20), set: 'Off', what: 'Schedule · off (wake + 30 min)' },
];
const fmtN = (n) => Math.round(n).toLocaleString('en-US');

/* ---------- SVG helpers ---------- */
const NS = 'http://www.w3.org/2000/svg';
function line(pts) { return pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(''); }
function sample(fn, a, b, step = 2) { const o = []; for (let t = a; t <= b; t += step) o.push([t, fn(t)]); return o; }
