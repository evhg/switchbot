'use client';
/**
 * The map box on the Map page. With a Maps key: Google Maps (lib/gmaps.ts, loaded on first use); without one, or when
 * Google refuses the key or can't be reached: the SVG view (layers.ts). Either way the page gets one MapLayer through
 * `onLayer` (null while switching) and draws through it imperatively; the theme's person colours are read from the
 * CSS tokens and re-applied when the theme changes.
 */
import { useEffect, useRef, useState } from 'react';
import { loadGoogleMaps, onMapsAuthFailure } from '@/lib/gmaps.ts';
import { useTheme } from '@/lib/theme.tsx';
import { createGoogleLayer, createSvgLayer, type MapLayer } from './layers.ts';
import s from './map.module.css';

/** Person colours and the home colour as resolved CSS values (Google needs real colours, not var()). */
function readColors(el: HTMLElement): Record<string, string> {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return { a: v('--person-a', '#e4572e'), b: v('--person-b', '#2a9d8f'), home: v('--text-2', '#666') };
}

export function MapCanvas({ mapsKey, onLayer, label }: { mapsKey: string | null; onLayer: (l: MapLayer | null) => void; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const layerRef = useRef<MapLayer | null>(null);
  const { resolved } = useTheme();
  const dark = resolved !== 'light';
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const [failed, setFailed] = useState<string | null>(null);
  const onLayerRef = useRef(onLayer);
  onLayerRef.current = onLayer;

  useEffect(() => {
    if (!mapsKey) return;
    return onMapsAuthFailure((e) => setFailed(e.message));
  }, [mapsKey]);

  useEffect(() => {
    const el = surface.current;
    const host = box.current;
    if (!el || !host) return;
    let alive = true;
    const use = (l: MapLayer) => {
      layerRef.current = l;
      onLayerRef.current(l);
    };
    if (mapsKey && !failed) {
      loadGoogleMaps(mapsKey)
        .then((g) => {
          if (alive) use(createGoogleLayer(g, el, readColors(host), darkRef.current));
        })
        .catch((e: unknown) => alive && setFailed(e instanceof Error ? e.message : String(e)));
    } else {
      use(createSvgLayer(el, readColors(host)));
    }
    return () => {
      alive = false;
      layerRef.current?.destroy();
      layerRef.current = null;
      onLayerRef.current(null);
    };
  }, [mapsKey, failed]);

  useEffect(() => {
    // The theme attribute is set in an effect too; read the tokens a frame later.
    const id = requestAnimationFrame(() => {
      if (box.current) layerRef.current?.setTheme(readColors(box.current), dark);
    });
    return () => cancelAnimationFrame(id);
  }, [dark, resolved]);

  return (
    <div ref={box} className={s.box} aria-label={label} role="region">
      <div ref={surface} className={s.surface} />
      {mapsKey && failed && <p className={s.note}>Simple view · {failed}</p>}
    </div>
  );
}
