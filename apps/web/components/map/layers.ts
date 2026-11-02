'use client';
/**
 * The Map page's drawing surface, behind one imperative interface so the page doesn't care whether Google Maps is
 * loaded (a Maps key is saved) or not (the no-dependency SVG view). Everything here is called from effects and from the
 * timelapse's animation frame: nothing re-renders React per frame.
 *
 *   MapLayer.setTracks(t)        faint full tracks, per person (timelapse)
 *   MapLayer.setTrails(t)        the bright part of each track (grows during playback; trackUpTo's output)
 *   MapLayer.setMarker(id, m)    a person's dot (first letter), accuracy circle, greyed when stale; null hides it
 *   MapLayer.setHome(h)          home point + radius circle
 *   MapLayer.fit(points)         frame these points
 *   MapLayer.keepInView(points)  refit only when one of them has left the view ("Follow")
 *   MapLayer.setTheme(colors, dark)  person colours (resolved CSS values) and the map style
 *
 * createGoogleLayer(g, el, …) and createSvgLayer(el, …) build the two. The SVG view is an equirectangular projection
 * fit to the data's bounds (longitude scaled by cos(latitude)), with a scale bar: no tiles, but the tracks, home and
 * markers are true to scale.
 */
import type { TrackPoint } from '@sleep-lab/core';
import type { Home } from '@/lib/location.ts';
import { DARK_STYLE, LIGHT_STYLE, type GCircle, type GLatLngBounds, type GMap, type GOverlayView, type GPolyline, type GoogleMapsNS, type LatLngLiteral } from '@/lib/gmaps.ts';
import s from './map.module.css';

export interface LatLon {
  lat: number;
  lon: number;
}
export interface MarkerState extends LatLon {
  label: string;
  accM?: number | null;
  stale?: boolean;
}
export type Tracks = Record<string, readonly TrackPoint[]>;

export interface MapLayer {
  setTracks(t: Tracks): void;
  setTrails(t: Tracks): void;
  setMarker(id: string, m: MarkerState | null): void;
  setHome(h: Home | null): void;
  fit(points: readonly LatLon[]): void;
  keepInView(points: readonly LatLon[]): void;
  setTheme(colors: Record<string, string>, dark: boolean): void;
  destroy(): void;
}

const ll = (p: LatLon): LatLngLiteral => ({ lat: p.lat, lng: p.lon });
const M_PER_DEG = 111_320;

function markerEl(id: string, home = false): { root: HTMLDivElement; dot: HTMLSpanElement } {
  const root = document.createElement('div');
  root.className = home ? `${s.marker} ${s.homeMarker}` : s.marker!;
  root.dataset.person = id;
  const dot = document.createElement('span');
  dot.className = s.dot!;
  root.appendChild(dot);
  return { root, dot };
}

function paintMarker(el: { root: HTMLDivElement; dot: HTMLSpanElement }, m: MarkerState) {
  if (el.dot.textContent !== m.label) el.dot.textContent = m.label;
  const st = m.stale ? '1' : '';
  if ((el.root.dataset.stale ?? '') !== st) {
    if (st) el.root.dataset.stale = st;
    else delete el.root.dataset.stale;
  }
}

/** Keeps a growing track cheap: the committed points change only when a new fix is passed, the tip every frame. */
function trailKey(t: readonly TrackPoint[]): { n: number; first: number } {
  return { n: t.length, first: t[0]?.ts ?? NaN };
}

// ───────────────────────────────────────── Google Maps ─────────────────────────────────────────

export function createGoogleLayer(g: GoogleMapsNS, el: HTMLElement, colors: Record<string, string>, dark: boolean): MapLayer {
  const map: GMap = new g.Map(el, {
    center: { lat: 13.7563, lng: 100.5018 },
    zoom: 12,
    disableDefaultUI: true,
    zoomControl: true,
    fullscreenControl: true,
    gestureHandling: 'greedy',
    clickableIcons: false,
    maxZoom: 19,
    styles: dark ? DARK_STYLE : LIGHT_STYLE,
    backgroundColor: dark ? '#1b1b1d' : '#f4f3ef',
  });
  let cols = colors;

  class HtmlMarker extends g.OverlayView {
    pos: LatLon = { lat: 0, lon: 0 };
    view: ReturnType<typeof markerEl>;
    constructor(id: string, home = false) {
      super();
      this.view = markerEl(id, home);
    }
    onAdd() {
      (home(this) ? this.getPanes()?.overlayLayer : this.getPanes()?.overlayMouseTarget)?.appendChild(this.view.root);
    }
    draw() {
      const proj = this.getProjection();
      const p = proj?.fromLatLngToDivPixel(new g.LatLng(this.pos.lat, this.pos.lon));
      if (p) this.view.root.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    onRemove() {
      this.view.root.remove();
    }
    move(p: LatLon) {
      this.pos = p;
      this.draw();
    }
  }
  const home = (m: HtmlMarker) => m.view.root.classList.contains(s.homeMarker!);

  const faint = new Map<string, GPolyline>();
  const bright = new Map<string, { line: GPolyline; key: { n: number; first: number } }>();
  const markers = new Map<string, { m: HtmlMarker; acc: GCircle; on: boolean }>();
  let homeView: { m: HtmlMarker; circle: GCircle } | null = null;

  const lineOpts = (id: string, strong: boolean) => ({
    strokeColor: cols[id] ?? '#888',
    strokeOpacity: strong ? 0.95 : 0.28,
    strokeWeight: strong ? 3.5 : 3,
    clickable: false,
    zIndex: strong ? 2 : 1,
  });

  const layer: MapLayer = {
    setTracks(t) {
      for (const [id, pts] of Object.entries(t)) {
        let line = faint.get(id);
        if (!line) {
          line = new g.Polyline({ ...lineOpts(id, false), map });
          faint.set(id, line);
        }
        line.setPath(pts.map((p) => ({ lat: p.lat, lng: p.lon })));
      }
      for (const [id, line] of faint) if (!(id in t)) line.setPath([]);
    },
    setTrails(t) {
      for (const [id, pts] of Object.entries(t)) {
        let b = bright.get(id);
        if (!b) {
          b = { line: new g.Polyline({ ...lineOpts(id, true), map }), key: { n: 0, first: NaN } };
          bright.set(id, b);
        }
        const k = trailKey(pts);
        const path = b.line.getPath();
        const last = pts.at(-1);
        // Same start and a few points more or the same: edit the tail in place; otherwise replace the path.
        if (k.first === b.key.first && k.n >= b.key.n && k.n - b.key.n < 64 && path.getLength() === b.key.n) {
          if (b.key.n > 0) {
            const prevLast = pts[b.key.n - 1]!;
            path.setAt(b.key.n - 1, new g.LatLng(prevLast.lat, prevLast.lon));
          }
          for (let i = b.key.n; i < k.n; i++) path.push(new g.LatLng(pts[i]!.lat, pts[i]!.lon));
          if (last && k.n > 0) path.setAt(k.n - 1, new g.LatLng(last.lat, last.lon));
        } else {
          b.line.setPath(pts.map((p) => ({ lat: p.lat, lng: p.lon })));
        }
        b.key = k;
      }
      for (const [id, b] of bright)
        if (!(id in t)) {
          b.line.setPath([]);
          b.key = { n: 0, first: NaN };
        }
    },
    setMarker(id, st) {
      let v = markers.get(id);
      if (!st) {
        if (v?.on) {
          v.m.setMap(null);
          v.acc.setMap(null);
          v.on = false;
        }
        return;
      }
      if (!v) {
        v = {
          m: new HtmlMarker(id),
          acc: new g.Circle({ strokeColor: cols[id], strokeOpacity: 0.5, strokeWeight: 1, fillColor: cols[id], fillOpacity: 0.1, clickable: false, radius: 1, center: ll(st) }),
          on: false,
        };
        markers.set(id, v);
      }
      if (!v.on) {
        v.m.setMap(map);
        v.acc.setMap(map);
        v.on = true;
      }
      paintMarker(v.m.view, st);
      v.m.move(st);
      v.acc.setCenter(ll(st));
      v.acc.setRadius(Math.max(0, st.accM ?? 0));
      v.acc.setOptions({ visible: !st.stale && (st.accM ?? 0) > 0 });
    },
    setHome(h) {
      if (!h) {
        if (homeView) {
          homeView.m.setMap(null);
          homeView.circle.setMap(null);
          homeView = null;
        }
        return;
      }
      if (!homeView) {
        homeView = {
          m: new HtmlMarker('home', true),
          circle: new g.Circle({ strokeColor: cols.home, strokeOpacity: 0.6, strokeWeight: 1.5, fillColor: cols.home, fillOpacity: 0.05, clickable: false, center: ll(h), radius: h.radiusM, zIndex: 0 }),
        };
        homeView.m.setMap(map);
        homeView.circle.setMap(map);
      }
      homeView.m.move(h);
      homeView.circle.setCenter(ll(h));
      homeView.circle.setRadius(h.radiusM);
    },
    fit(points) {
      if (!points.length) return;
      if (points.length === 1 || spanM(points) < 120) {
        map.panTo(ll(points[0]!));
        map.setZoom(16);
        return;
      }
      const b: GLatLngBounds = new g.LatLngBounds();
      for (const p of points) b.extend(ll(p));
      map.fitBounds(b, 48);
    },
    keepInView(points) {
      const b = map.getBounds();
      if (!b || points.every((p) => b.contains(ll(p)))) return;
      layer.fit(points);
    },
    setTheme(colors2, dark2) {
      cols = colors2;
      map.setOptions({ styles: dark2 ? DARK_STYLE : LIGHT_STYLE, backgroundColor: dark2 ? '#1b1b1d' : '#f4f3ef' });
      for (const [id, l] of faint) l.setOptions(lineOpts(id, false));
      for (const [id, b] of bright) b.line.setOptions(lineOpts(id, true));
      for (const [id, v] of markers) v.acc.setOptions({ strokeColor: cols[id], fillColor: cols[id] });
      homeView?.circle.setOptions({ strokeColor: cols.home, fillColor: cols.home });
    },
    destroy() {
      for (const l of faint.values()) l.setMap(null);
      for (const b of bright.values()) b.line.setMap(null);
      for (const v of markers.values()) {
        v.m.setMap(null);
        v.acc.setMap(null);
      }
      homeView?.m.setMap(null);
      homeView?.circle.setMap(null);
      el.replaceChildren();
    },
  };
  return layer;
}

/** Largest distance (approx., m) between the first point and any other. */
function spanM(points: readonly LatLon[]): number {
  const a = points[0]!;
  let max = 0;
  for (const p of points) {
    const dy = (p.lat - a.lat) * M_PER_DEG;
    const dx = (p.lon - a.lon) * M_PER_DEG * Math.cos((a.lat * Math.PI) / 180);
    max = Math.max(max, Math.hypot(dx, dy));
  }
  return max;
}

// ───────────────────────────────────────── SVG fallback ─────────────────────────────────────────

const SVG = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}) => {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};

/** Nice round scale-bar length (m) close to `m`. */
function niceM(m: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(m, 1)));
  const f = m / p;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
}

export function createSvgLayer(el: HTMLElement, colors: Record<string, string>): MapLayer {
  let cols = colors;
  const svg = svgEl('svg', { class: s.svg!, role: 'img', 'aria-label': 'Map of the tracks (simple view)' });
  const gHome = svgEl('g');
  const gFaint = svgEl('g');
  const gBright = svgEl('g');
  const gAcc = svgEl('g');
  svg.append(gHome, gFaint, gBright, gAcc);
  const overlay = document.createElement('div');
  overlay.className = s.svgOverlay!;
  const scaleBar = document.createElement('div');
  scaleBar.className = s.scale!;
  el.append(svg, overlay, scaleBar);

  let w = el.clientWidth || 320;
  let h = el.clientHeight || 320;
  // View: centre and metres per pixel.
  let view = { lat: 13.7563, lon: 100.5018, mpp: 20 };
  let fitted: readonly LatLon[] = [];

  const x = (p: LatLon) => w / 2 + ((p.lon - view.lon) * M_PER_DEG * Math.cos((view.lat * Math.PI) / 180)) / view.mpp;
  const y = (p: LatLon) => h / 2 - ((p.lat - view.lat) * M_PER_DEG) / view.mpp;
  const pt = (p: LatLon) => `${x(p).toFixed(1)},${y(p).toFixed(1)}`;

  let tracks: Tracks = {};
  let trails: Tracks = {};
  const faint = new Map<string, SVGPolylineElement>();
  const bright = new Map<string, { line: SVGPolylineElement; committed: string; key: { n: number; first: number } }>();
  const markers = new Map<string, { view: ReturnType<typeof markerEl>; acc: SVGCircleElement; st: MarkerState | null }>();
  let home: Home | null = null;
  let homeView: { view: ReturnType<typeof markerEl>; circle: SVGCircleElement } | null = null;

  const placeDiv = (d: HTMLElement, p: LatLon) => {
    d.style.transform = `translate(${x(p)}px, ${y(p)}px)`;
  };

  const drawFaint = () => {
    for (const [id, pts] of Object.entries(tracks)) {
      let line = faint.get(id);
      if (!line) {
        line = svgEl('polyline', { fill: 'none', 'stroke-width': '3', 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-opacity': '0.28' });
        faint.set(id, line);
        gFaint.appendChild(line);
      }
      line.setAttribute('stroke', cols[id] ?? 'currentColor');
      line.setAttribute('points', pts.map(pt).join(' '));
    }
    for (const [id, line] of faint) if (!(id in tracks)) line.setAttribute('points', '');
  };

  const drawTrails = (full: boolean) => {
    for (const [id, pts] of Object.entries(trails)) {
      let b = bright.get(id);
      if (!b) {
        const line = svgEl('polyline', { fill: 'none', 'stroke-width': '3.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' });
        gBright.appendChild(line);
        b = { line, committed: '', key: { n: 0, first: NaN } };
        bright.set(id, b);
      }
      b.line.setAttribute('stroke', cols[id] ?? 'currentColor');
      const k = trailKey(pts);
      // All but the tip (the interpolated "now" point) are committed; extend the string when the count grows.
      if (full || k.first !== b.key.first || k.n < b.key.n) b.committed = pts.slice(0, Math.max(0, k.n - 1)).map(pt).join(' ');
      else if (k.n > b.key.n) {
        const add = pts.slice(Math.max(0, b.key.n - 1), Math.max(0, k.n - 1)).map(pt).join(' ');
        if (add) b.committed = b.committed ? `${b.committed} ${add}` : add;
      }
      b.key = k;
      const tip = pts.at(-1);
      b.line.setAttribute('points', tip ? (b.committed ? `${b.committed} ${pt(tip)}` : pt(tip)) : '');
    }
    for (const [id, b] of bright)
      if (!(id in trails)) {
        b.line.setAttribute('points', '');
        b.committed = '';
        b.key = { n: 0, first: NaN };
      }
  };

  const drawMarker = (id: string) => {
    const v = markers.get(id);
    if (!v) return;
    const st = v.st;
    v.view.root.style.display = st ? '' : 'none';
    if (!st) {
      v.acc.setAttribute('r', '0');
      return;
    }
    paintMarker(v.view, st);
    placeDiv(v.view.root, st);
    v.acc.setAttribute('cx', x(st).toFixed(1));
    v.acc.setAttribute('cy', y(st).toFixed(1));
    v.acc.setAttribute('r', st.stale || !st.accM ? '0' : (st.accM / view.mpp).toFixed(1));
    v.acc.setAttribute('fill', cols[id] ?? 'currentColor');
    v.acc.setAttribute('stroke', cols[id] ?? 'currentColor');
  };

  const drawHome = () => {
    if (!home) {
      if (homeView) {
        homeView.view.root.remove();
        homeView.circle.remove();
        homeView = null;
      }
      return;
    }
    if (!homeView) {
      homeView = { view: markerEl('home', true), circle: svgEl('circle', { 'fill-opacity': '0.05', 'stroke-opacity': '0.6', 'stroke-width': '1.5', 'stroke-dasharray': '4 4' }) };
      overlay.appendChild(homeView.view.root);
      gHome.appendChild(homeView.circle);
    }
    placeDiv(homeView.view.root, home);
    homeView.circle.setAttribute('cx', x(home).toFixed(1));
    homeView.circle.setAttribute('cy', y(home).toFixed(1));
    homeView.circle.setAttribute('r', (home.radiusM / view.mpp).toFixed(1));
    homeView.circle.setAttribute('fill', cols.home ?? 'currentColor');
    homeView.circle.setAttribute('stroke', cols.home ?? 'currentColor');
  };

  const drawScale = () => {
    const m = niceM(view.mpp * Math.min(120, w / 3));
    scaleBar.style.setProperty('--w', `${Math.round(m / view.mpp)}px`);
    scaleBar.textContent = m >= 1000 ? `${m / 1000} km` : `${m} m`;
  };

  const redraw = () => {
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', String(w));
    svg.setAttribute('height', String(h));
    drawHome();
    drawFaint();
    drawTrails(true);
    for (const id of markers.keys()) drawMarker(id);
    drawScale();
  };

  const fitTo = (points: readonly LatLon[]) => {
    fitted = points;
    if (!points.length) return redraw();
    let [s0, n0, w0, e0] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const p of points) {
      s0 = Math.min(s0, p.lat);
      n0 = Math.max(n0, p.lat);
      w0 = Math.min(w0, p.lon);
      e0 = Math.max(e0, p.lon);
    }
    const lat = (s0 + n0) / 2;
    const lon = (w0 + e0) / 2;
    const pad = 40;
    const hM = (n0 - s0) * M_PER_DEG;
    const wM = (e0 - w0) * M_PER_DEG * Math.cos((lat * Math.PI) / 180);
    const mpp = Math.max(hM / Math.max(h - 2 * pad, 40), wM / Math.max(w - 2 * pad, 40), 1.5);
    view = { lat, lon, mpp };
    redraw();
  };

  const ro = new ResizeObserver(() => {
    const nw = el.clientWidth;
    const nh = el.clientHeight;
    if (!nw || !nh || (nw === w && nh === h)) return;
    w = nw;
    h = nh;
    fitTo(fitted);
  });
  ro.observe(el);
  redraw();

  return {
    setTracks(t) {
      tracks = t;
      drawFaint();
    },
    setTrails(t) {
      trails = t;
      drawTrails(false);
    },
    setMarker(id, st) {
      let v = markers.get(id);
      if (!v) {
        v = { view: markerEl(id), acc: svgEl('circle', { 'fill-opacity': '0.1', 'stroke-opacity': '0.5', 'stroke-width': '1' }), st: null };
        markers.set(id, v);
        overlay.appendChild(v.view.root);
        gAcc.appendChild(v.acc);
      }
      v.st = st;
      drawMarker(id);
    },
    setHome(hh) {
      home = hh;
      drawHome();
    },
    fit(points) {
      fitTo(points);
    },
    keepInView(points) {
      const inside = (p: LatLon) => {
        const px = x(p);
        const py = y(p);
        return px >= 16 && px <= w - 16 && py >= 16 && py <= h - 16;
      };
      if (!points.every(inside)) fitTo(points);
    },
    setTheme(c) {
      cols = c;
      redraw();
    },
    destroy() {
      ro.disconnect();
      el.replaceChildren();
    },
  };
}
