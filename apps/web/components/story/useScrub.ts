'use client';
import { useLayoutEffect, useRef, type DependencyList } from 'react';
import { useChapterProgress } from '../motion.tsx';

/**
 * useChapterProgress that also re-applies the last progress when `deps` change (new data, a re-measured chart),
 * so imperative readouts never show a stale state until the next scroll.
 */
export function useScrub(cb: (p: number) => void, range: readonly [number, number] = [0, 1], deps: DependencyList = []) {
  const p = useRef(0);
  const f = useRef(cb);
  f.current = cb;
  useChapterProgress((v) => {
    p.current = v;
    f.current(v);
  }, range);
  useLayoutEffect(() => {
    f.current(p.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
