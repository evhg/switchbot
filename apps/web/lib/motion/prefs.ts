// Motion preferences without React (for imperative code) — the hook lives in components/motion.tsx.

export type MotionLevel = 'full' | 'calm' | 'none';

export const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

export function prefersReduced(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.(REDUCED_QUERY).matches;
}

export function isNightTheme(): boolean {
  return typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'night';
}

/** 'full' = day themes; 'calm' = night mode (fades only, short, no ambient motion); 'none' = reduced motion. */
export function motionLevel(): MotionLevel {
  if (prefersReduced()) return 'none';
  return isNightTheme() ? 'calm' : 'full';
}

/** Easing used by count-ups and draws (matches --ease-out ≈ cubic-bezier(.22,1,.36,1)). */
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 4);
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Maps p in [a, b] to [0, 1], clamped. */
export function remap(p: number, a = 0, b = 1): number {
  if (b <= a) return p >= b ? 1 : 0;
  const v = (p - a) / (b - a);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Linear interpolation. */
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
