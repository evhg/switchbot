'use client';
/**
 * Google Maps JavaScript API, loaded on demand (Map page only), with the household's browser key
 * (household_settings.maps_browser_key). No npm package: one <script> tag with `loading=async` and a global callback,
 * and the small slice of the API the map uses typed by hand below.
 *
 *   loadGoogleMaps(key)  resolves to the `google.maps` namespace; one load per page (a second key is refused: reload)
 *   onMapsAuthFailure(f) Google refused the key (may come after the load resolved)
 *   DARK_STYLE           a styles array for the dark themes (no mapId needed)
 *
 * A refused key (wrong referrer, API not enabled, billing) calls window.gm_authFailure; that rejects the promise
 * too, so the page can fall back to its own drawing and say why.
 */

export interface LatLngLiteral {
  lat: number;
  lng: number;
}

/* The parts of google.maps this app uses. */
export interface GMap {
  fitBounds(b: GLatLngBounds, padding?: number | { top: number; right: number; bottom: number; left: number }): void;
  panTo(p: LatLngLiteral): void;
  setZoom(z: number): void;
  getZoom(): number | undefined;
  getBounds(): GLatLngBounds | null | undefined;
  setOptions(o: Record<string, unknown>): void;
}
export interface GLatLngBounds {
  extend(p: LatLngLiteral): GLatLngBounds;
  contains(p: LatLngLiteral): boolean;
  isEmpty(): boolean;
}
/** google.maps.MVCArray of LatLng: edited in place so a growing track doesn't resend every vertex each frame. */
export interface GMVCArray {
  getLength(): number;
  push(p: unknown): number;
  pop(): unknown;
  setAt(i: number, p: unknown): void;
  clear(): void;
}
export interface GPolyline {
  setPath(p: LatLngLiteral[]): void;
  getPath(): GMVCArray;
  setOptions(o: Record<string, unknown>): void;
  setMap(m: GMap | null): void;
}
export interface GCircle {
  setCenter(p: LatLngLiteral): void;
  setRadius(r: number): void;
  setOptions(o: Record<string, unknown>): void;
  setMap(m: GMap | null): void;
}
export interface GProjection {
  fromLatLngToDivPixel(p: unknown): { x: number; y: number } | null;
}
export interface GOverlayView {
  setMap(m: GMap | null): void;
  getPanes(): { overlayMouseTarget: HTMLElement; overlayLayer: HTMLElement } | null;
  getProjection(): GProjection;
  onAdd?(): void;
  draw?(): void;
  onRemove?(): void;
}
export interface GoogleMapsNS {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => GMap;
  LatLngBounds: new () => GLatLngBounds;
  LatLng: new (lat: number, lng: number) => unknown;
  Polyline: new (opts: Record<string, unknown>) => GPolyline;
  Circle: new (opts: Record<string, unknown>) => GCircle;
  OverlayView: new () => GOverlayView;
}

type Win = Window & { google?: { maps?: GoogleMapsNS }; gm_authFailure?: () => void; __sleeplabMapsReady?: () => void };

let loading: { key: string; promise: Promise<GoogleMapsNS> } | null = null;
let authFailed = false;
const authListeners = new Set<(e: Error) => void>();
const AUTH_FAILED = 'Google refused the Maps key (check its website restriction and that the Maps JavaScript API is enabled).';

/** Called when Google refuses the key, which can happen after the script has loaded. Returns an unsubscribe. */
export function onMapsAuthFailure(f: (e: Error) => void): () => void {
  if (authFailed) f(new Error(AUTH_FAILED));
  authListeners.add(f);
  return () => authListeners.delete(f);
}

export function loadGoogleMaps(key: string): Promise<GoogleMapsNS> {
  if (loading) return loading.key === key ? loading.promise : Promise.reject(new Error('The Maps key changed. Reload the page.'));
  const w = window as Win;
  const promise = new Promise<GoogleMapsNS>((resolve, reject) => {
    if (w.google?.maps?.Map) return resolve(w.google.maps);
    w.__sleeplabMapsReady = () => {
      const g = w.google?.maps;
      if (g?.Map) resolve(g);
      else reject(new Error('Google Maps loaded without its map library.'));
    };
    w.gm_authFailure = () => {
      authFailed = true;
      const e = new Error(AUTH_FAILED);
      reject(e);
      authListeners.forEach((f) => f(e));
    };
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&libraries=geometry&loading=async&callback=__sleeplabMapsReady`;
    s.async = true;
    s.onerror = () => {
      loading = null;
      s.remove();
      reject(new Error('Google Maps couldn’t be loaded (offline, or blocked by the browser).'));
    };
    document.head.appendChild(s);
  });
  loading = { key, promise };
  return promise;
}

/** Quiet dark map: dark land, muted roads and labels, no points of interest. */
export const DARK_STYLE: Record<string, unknown>[] = [
  { elementType: 'geometry', stylers: [{ color: '#1b1b1d' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8a8983' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0e0e0f' }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#38383b' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ visibility: 'on' }, { color: '#18221b' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2a2d' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#151516' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#3a3a3e' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0b1620' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4c5a66' }] },
];

/** Light theme: only hide points of interest and transit, so the tracks stand out. */
export const LIGHT_STYLE: Record<string, unknown>[] = [
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ visibility: 'on' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
];
