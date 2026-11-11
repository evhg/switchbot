'use client';
/**
 * The bird BirdNET heard in a clip (sound_events.bird_*, migration 0036): its name, how sure the Mac is, and a photo of
 * that species from iNaturalist (public API, cached per species for the session), linking to its Wikipedia page.
 */
import { useEffect, useState } from 'react';

interface Taxon {
  photo: string | null;
  credit: string | null;
  wiki: string | null;
  common: string | null;
}
const cache = new Map<string, Promise<Taxon | null>>();

function lookup(species: string): Promise<Taxon | null> {
  let p = cache.get(species);
  if (!p) {
    p = fetch(`https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(species)}&rank=species&per_page=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { results?: { name?: string; preferred_common_name?: string; wikipedia_url?: string; default_photo?: { medium_url?: string; attribution?: string } }[] } | null) => {
        const t = j?.results?.[0];
        if (!t) return null;
        return { photo: t.default_photo?.medium_url ?? null, credit: t.default_photo?.attribution ?? null, wiki: t.wikipedia_url ?? null, common: t.preferred_common_name ?? null };
      })
      .catch(() => null);
    cache.set(species, p);
  }
  return p;
}

export function BirdCard({ bird }: { bird: { species: string; common: string | null; conf: number | null } }) {
  const [t, setT] = useState<Taxon | null>(null);
  useEffect(() => {
    let alive = true;
    void lookup(bird.species).then((x) => alive && setT(x));
    return () => {
      alive = false;
    };
  }, [bird.species]);
  const name = bird.common ?? t?.common ?? bird.species;
  const sure = bird.conf === null ? null : `${Math.round(bird.conf * 100)} % sure`;
  return (
    <span style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8 }}>
      {t?.photo && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={t.photo} alt={name} title={t.credit ?? undefined} width={72} height={72} loading="lazy" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 12, flex: 'none' }} />
      )}
      <span>
        <span style={{ display: 'block', color: 'var(--text)' }}>
          Bird: {t?.wiki ? <a href={t.wiki.replace(/^http:/, 'https:')} target="_blank" rel="noreferrer">{name}</a> : name}
        </span>
        <span className="sec" style={{ display: 'block' }}>
          <em>{bird.species}</em>
          {sure ? ` · ${sure} (BirdNET)` : ''}
        </span>
      </span>
    </span>
  );
}
