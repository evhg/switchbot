'use client';
/**
 * Plays a night-sound clip loud enough to hear. The bedroom camera's microphone records very quietly (peaks around
 * −40 to −65 dBFS), so the plain <audio> player is near-silent on laptop speakers. This fetches the clip, decodes it
 * with Web Audio, scales it so its loudest sample reaches −1 dBFS (at most +40 dB) and plays that. If fetching or
 * decoding fails, it falls back to the browser's own player.
 */
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui.tsx';

const TARGET_PEAK = 0.89; // −1 dBFS
const MAX_GAIN = 100; // +40 dB

let ctx: AudioContext | null = null;
function audioContext(): AudioContext {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  ctx ??= new AC();
  return ctx;
}

/** One clip playing at a time, across the page. */
let stopCurrent: (() => void) | null = null;

export function ClipPlayer({ url, label }: { url: string; label: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'fallback'>('idle');
  const [boost, setBoost] = useState<number | null>(null);
  const buf = useRef<AudioBuffer | null>(null);
  const src = useRef<AudioBufferSourceNode | null>(null);

  useEffect(() => () => src.current?.stop(), []);

  const stop = () => {
    try {
      src.current?.stop();
    } catch {
      /* already stopped */
    }
    src.current = null;
    setState('idle');
  };

  const play = async () => {
    stopCurrent?.();
    const ac = audioContext();
    // iOS needs the context resumed inside the tap.
    void ac.resume();
    try {
      if (!buf.current) {
        setState('loading');
        const r = await fetch(url);
        if (!r.ok) throw new Error(String(r.status));
        buf.current = await ac.decodeAudioData(await r.arrayBuffer());
      }
      const b = buf.current;
      let peak = 0;
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c);
        for (let i = 0; i < d.length; i++) {
          const v = Math.abs(d[i]!);
          if (v > peak) peak = v;
        }
      }
      const gain = peak > 0 ? Math.min(MAX_GAIN, TARGET_PEAK / peak) : 1;
      setBoost(Math.round(20 * Math.log10(gain)));
      const g = ac.createGain();
      g.gain.value = gain;
      const s = ac.createBufferSource();
      s.buffer = b;
      s.connect(g).connect(ac.destination);
      s.onended = () => {
        if (src.current === s) stop();
      };
      src.current = s;
      stopCurrent = stop;
      s.start();
      setState('playing');
    } catch {
      setState('fallback');
    }
  };

  if (state === 'fallback') {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio controls autoPlay src={url} style={{ display: 'block', width: '100%', maxWidth: 320, height: 36, marginTop: 6 }} aria-label={label} />;
  }
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
      <Button size="sm" variant="secondary" onClick={() => (state === 'playing' ? stop() : void play())} disabled={state === 'loading'} aria-label={`${state === 'playing' ? 'Stop' : 'Play'} ${label}`}>
        {state === 'loading' ? 'Loading…' : state === 'playing' ? '■ Stop' : '▶ Play'}
      </Button>
      {boost !== null && boost > 0 && <span className="sec">made {boost} dB louder</span>}
    </span>
  );
}
