'use client';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';

export function Card({ title, sub, meta, children, id, className = '', style }: { title?: ReactNode; sub?: ReactNode; meta?: ReactNode; children: ReactNode; id?: string; className?: string; style?: CSSProperties }) {
  return (
    <section className={`card ${className}`} id={id} style={style}>
      {(title || meta) && (
        <div className="card-head">
          <div style={{ minWidth: 0 }}>
            {title && <h2 className="card-title">{title}</h2>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {meta && <div className="card-meta">{meta}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { value: T; label: ReactNode }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type KeyShape = 'line' | 'dash' | 'dot' | 'rect';
export function Legend({ items }: { items: { label: ReactNode; color: string; shape?: KeyShape }[] }) {
  return (
    <div className="legend">
      {items.map((it, i) => (
        <span key={i}>
          <Key color={it.color} shape={it.shape ?? 'line'} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export function Key({ color, shape = 'line' }: { color: string; shape?: KeyShape }) {
  if (shape === 'dot') return <i className="key-dot" style={{ background: color }} />;
  if (shape === 'rect') return <i className="key-rect" style={{ background: color }} />;
  return <i className={shape === 'dash' ? 'key-dash' : 'key-line'} style={{ color }} />;
}

export function Loading({ text = 'Loading…' }: { text?: string }) {
  return (
    <div className="loading" role="status">
      <div>
        <div className="spinner" style={{ margin: '0 auto 10px' }} />
        {text}
      </div>
    </div>
  );
}

export function Placeholder({ height = 160, text = 'Analysing…' }: { height?: number; text?: string }) {
  return (
    <div style={{ height, display: 'grid', placeItems: 'center', color: 'var(--muted)', fontSize: 13 }} role="status">
      {text}
    </div>
  );
}

/** Measures its own width so custom SVG charts can draw at device pixels. */
export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw) setW(Math.round(cw));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Accessible table fallback behind a toggle (every chart value stays reachable without hovering). */
export function TableView({ columns, rows, caption }: { columns: string[]; rows: (string | number)[][]; caption?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="table-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Hide table' : 'Show table'}
      </button>
      {open && (
        <div className="scroll-x" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table className="data-table">
            {caption && <caption className="hidden">{caption}</caption>}
            <thead>
              <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function StatusDot({ status }: { status: 'good' | 'warn' | 'serious' | 'critical' }) {
  return <i className="status-dot" style={{ background: `var(--${status})` }} aria-hidden />;
}
