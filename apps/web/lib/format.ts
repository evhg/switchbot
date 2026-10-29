// Display helpers. All times are shown in ICT (Asia/Bangkok, UTC+7, no DST), independent of the device zone.
const ICT = 7 * 3_600_000;
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const pad = (n: number) => String(n).padStart(2, '0');
const ict = (ts: number) => new Date(ts + ICT);

export const ictHour = (ts: number) => ict(ts).getUTCHours() + ict(ts).getUTCMinutes() / 60;
export const ictMinuteOfDay = (ts: number) => ict(ts).getUTCHours() * 60 + ict(ts).getUTCMinutes();
export const hm = (ts: number) => `${pad(ict(ts).getUTCHours())}:${pad(ict(ts).getUTCMinutes())}`;
export const hOnly = (ts: number) => pad(ict(ts).getUTCHours());
export const ictDate = (ts: number) => ict(ts).toISOString().slice(0, 10);

/** Epoch ms of local (ICT) midnight for a YYYY-MM-DD date. */
export const ictMidnight = (date: string) => Date.parse(`${date}T00:00:00Z`) - ICT;

export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
export const dayLabel = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WD_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
};
export const shortDate = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCDate()} ${MO[d.getUTCMonth()]}`;
};
export const shortDay = (date: string) => WD[weekdayOf(date)]!;

export function dur(min: number): string {
  if (!Number.isFinite(min)) return '–';
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  return h ? `${h}h\u00a0${pad(m % 60)}m` : `${m}m`;
}

/**
 * Brings report sentences from @sleep-lab/core in line with the app's formats: durations as `dur()` ("2h 04m"),
 * thousands separators, "60%" (no space), and words instead of bare comparison signs ("above 60%").
 */
export function tidyReport(text: string): string {
  return text
    .replace(/(\d+) h (\d+) m\b/g, (_, h: string, m: string) => `${h}h ${pad(Number(m))}m`)
    .replace(/(\d+) h\b(?! \d)/g, '$1h')
    .replace(/\b(\d+) m\b/g, '$1m')
    .replace(/(?<![\d.\-:])(\d{4,6})(?![\d.\-:])/g, (n: string) => Number(n).toLocaleString('en-US'))
    .replace(/(\d) %/g, '$1%')
    .replace(/ > (?=[\d.]+)/g, '\u00a0above\u00a0')
    .replace(/ < (?=[\d.]+)/g, '\u00a0below\u00a0')
    .replace(/(\d+)-night\b/g, '$1-night')
    // Never split a duration or a number from its unit across lines.
    .replace(/(\d+h) (\d{1,2}m)\b/g, '$1\u00a0$2')
    .replace(/(\d) (ppm|bpm|ms|min|°C)(?![\w])/g, '$1\u00a0$2');
}

export const fmt = (x: number | null | undefined, digits = 0) =>
  x === null || x === undefined || !Number.isFinite(x) ? '–' : x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const signed = (x: number, digits = 0) => (x > 0 ? '+' : x < 0 ? '−' : '±') + fmt(Math.abs(x), digits);

/** Hour ticks (every `stepH` hours, aligned to ICT clock) between two instants. */
export function hourTicks(from: number, to: number, stepH = 1): number[] {
  const out: number[] = [];
  const first = Math.ceil((from + ICT) / (stepH * HOUR)) * stepH * HOUR - ICT;
  for (let t = first; t <= to; t += stepH * HOUR) out.push(t);
  return out;
}

export function co2Band(ppm: number): { key: 'good' | 'warn' | 'serious' | 'critical'; label: string } {
  if (ppm < 800) return { key: 'good', label: 'Fresh' };
  if (ppm < 1000) return { key: 'warn', label: 'OK' };
  if (ppm < 1500) return { key: 'serious', label: 'Stuffy' };
  return { key: 'critical', label: 'Poor' };
}

export const CO2_BANDS = [
  { from: 0, to: 800, fill: 'var(--band-good)', key: 'good' },
  { from: 800, to: 1000, fill: 'var(--band-warn)', key: 'warn' },
  { from: 1000, to: 1500, fill: 'var(--band-serious)', key: 'serious' },
  { from: 1500, to: 5000, fill: 'var(--band-critical)', key: 'critical' },
] as const;

/** Round-number axis ticks covering [lo, hi] with about `count` steps (1/2/5 × 10^k). */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let t = Math.floor(lo / step) * step; t <= hi + step * 0.999; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}
