'use client';
/**
 * The front door (the camera moved to the villa's entrance on 2026-11-13; migration 0039).
 *
 *   useHomeNow()   who is home right now: the newest of (a) the person's last front-door pass with a direction and
 *                  (b) their phone's presence (public.presence_latest, which maps Cath to Erik's phone). Each person:
 *                  { state: 'home' | 'away' | null, since, via: 'door' | 'phone' }.
 *   <HomeNow>      one line per person ("Erik · home since 18:43 (front door)") plus when each last left and came back.
 *   <DoorTimeline> today's passes, newest first: time, who, Arriving / Leaving / Seen; unknown faces marked.
 *   <WhoWasIt>     an unknown pass with a clip (migration 0041): the clip, a snapshot per person and Cath / Erik /
 *                  Someone else / Don't know; the choice goes to the Mac (face_names) so it learns the face.
 */
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_PEOPLE } from '@sleep-lab/core';
import { useAuth } from '@/lib/auth.tsx';
import { doorDirection, sightingWho, useDoorActivity, type CameraSighting } from '@/lib/camera.ts';
import { personName, useData } from '@/lib/data/context.tsx';
import { supabaseClient } from '@/lib/data/supabase.ts';
import { dayLabel, hm, ictDate } from '@/lib/format.ts';
import { Button, Chip, EventList, Group, Input, Row, Status } from '../ui.tsx';

export interface HomeState {
  id: string;
  name: string;
  state: 'home' | 'away' | null;
  since: number | null;
  via: 'door' | 'phone' | null;
  lastLeft: number | null;
  lastBack: number | null;
}

function usePresenceLatest(enabled: boolean): Record<string, { state: 'home' | 'away'; at: number }> {
  const [rows, setRows] = useState<Record<string, { state: 'home' | 'away'; at: number }>>({});
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void supabaseClient()
      .from('presence_latest')
      .select('person_id,state,at')
      .then(({ data }) => {
        if (!alive || !data) return;
        const out: Record<string, { state: 'home' | 'away'; at: number }> = {};
        for (const r of data as { person_id: string; state: string; at: string }[]) {
          if (r.state === 'home' || r.state === 'away') out[r.person_id] = { state: r.state, at: Date.parse(r.at) };
        }
        setRows(out);
      });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return rows;
}

/** Who is home now, from the front door and the phones (see the header). */
export function useHomeNow(): { people: HomeState[]; events: CameraSighting[] | null; real: boolean; error: string | null } {
  const { dataset, latest } = useData();
  const auth = useAuth();
  const door = useDoorActivity(2);
  const phones = usePresenceLatest(door.real && auth.status === 'signed-in');
  const people = (dataset ?? latest)?.people ?? DEFAULT_PEOPLE;
  const list = useMemo(() => {
    const evs = door.events ?? [];
    return people.map((p) => {
      const mine = evs.filter((e) => e.personId === p.id);
      const lastDir = mine.find((e) => doorDirection(e) !== null) ?? null;
      const lastLeft = mine.find((e) => doorDirection(e) === 'leave')?.ts ?? null;
      const lastBack = mine.find((e) => doorDirection(e) === 'arrive')?.ts ?? null;
      const phone = phones[p.id] ?? null;
      let state: HomeState['state'] = null;
      let since: number | null = null;
      let via: HomeState['via'] = null;
      if (lastDir && (!phone || lastDir.ts >= phone.at)) {
        state = doorDirection(lastDir) === 'arrive' ? 'home' : 'away';
        since = lastDir.ts;
        via = 'door';
      } else if (phone) {
        state = phone.state;
        since = phone.at;
        via = 'phone';
      }
      return { id: p.id, name: (dataset ? personName(dataset, p.id) : null) ?? p.name, state, since, via, lastLeft, lastBack };
    });
  }, [door.events, phones, people, dataset]);
  return { people: list, events: door.events, real: door.real, error: door.error };
}

const when = (ts: number) => (ictDate(ts) === ictDate(Date.now()) ? hm(ts) : `${dayLabel(ictDate(ts))} ${hm(ts)}`);

/** One row per person: home / away and since when, with last left and last back. */
export function HomeNow({ compact = false }: { compact?: boolean }) {
  const { people, real } = useHomeNow();
  return (
    <Group label={compact ? undefined : 'Who’s home'} footer={real ? 'From the front-door camera and Erik’s phone, whichever saw it last.' : 'Sample data.'}>
      {people.map((p) => (
        <Row
          key={p.id}
          title={p.name}
          sub={[
            p.since ? `${p.state === 'home' ? 'Home' : 'Out'} since ${when(p.since)}${p.via === 'door' ? ' (front door)' : p.via === 'phone' ? ' (phone)' : ''}` : 'No signal yet',
            p.lastLeft ? `left ${when(p.lastLeft)}` : null,
            p.lastBack ? `back ${when(p.lastBack)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          value={p.state === 'home' ? <Status tone="on">Home</Status> : p.state === 'away' ? <Status tone="off">Out</Status> : <Status tone="off">?</Status>}
        />
      ))}
    </Group>
  );
}

/** Signed URLs (1 h) for door-clips objects, keyed by path. */
function useDoorMedia(paths: string[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const key = paths.join('|');
  useEffect(() => {
    if (!paths.length) return;
    let alive = true;
    void supabaseClient()
      .storage.from('door-clips')
      .createSignedUrls(paths, 3600)
      .then(({ data }) => {
        if (!alive || !data) return;
        const out: Record<string, string> = {};
        for (const d of data) if (d.path && d.signedUrl) out[d.path] = d.signedUrl;
        setUrls(out);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return urls;
}

/** "Who was it?": the clip, a snapshot per person, and the name buttons. */
function WhoWasIt({ e, onNamed }: { e: CameraSighting; onNamed: () => void }) {
  const people = e.people ?? [];
  const paths = [e.clipPath, ...people.map((p) => p.snapshot)].filter((p): p is string => !!p);
  const urls = useDoorMedia(paths);
  const [busy, setBusy] = useState<number | null>(null);
  const [other, setOther] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const name = async (k: number, label: string) => {
    setBusy(k);
    setMsg(null);
    const { error } = await supabaseClient().rpc('name_door_face', { p_event_id: Number(e.id), p_person: k, p_label: label });
    setBusy(null);
    if (error) return setMsg(/lower-case/i.test(error.message) ? 'Use letters, digits, - or _ for the name.' : error.message);
    onNamed();
  };
  const labelText = (l: string) => (l === 'a' ? 'Cath' : l === 'b' ? 'Erik' : l === 'forget' ? 'Don’t know' : l);
  return (
    <span style={{ display: 'block', marginTop: 8 }}>
      {e.clipPath && urls[e.clipPath] && (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={urls[e.clipPath]} playsInline muted controls preload="metadata" style={{ display: 'block', width: '100%', maxWidth: 420, borderRadius: 12, background: '#000' }} />
      )}
      {people.map((p, k) => (
        <span key={k} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginTop: 10 }}>
          {p.snapshot && urls[p.snapshot] ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={urls[p.snapshot]} alt={`Person ${k + 1}`} width={64} height={64} style={{ width: 64, height: 64, borderRadius: 12, objectFit: 'cover', flex: 'none' }} />
          ) : (
            <span style={{ width: 64, height: 64, borderRadius: 12, background: 'var(--surface-2, #222)', flex: 'none' }} />
          )}
          <span style={{ display: 'block', flex: 1, minWidth: 0 }}>
            {p.label ? (
              <span className="sec">Named: {labelText(p.label)}</span>
            ) : (
              <>
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  <Chip disabled={busy === k} onClick={() => void name(k, 'a')}>Cath</Chip>
                  <Chip disabled={busy === k} onClick={() => void name(k, 'b')}>Erik</Chip>
                  <Chip disabled={busy === k} onClick={() => void name(k, 'forget')}>Don’t know</Chip>
                </span>
                <span style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <Input
                    aria-label="Someone else: name"
                    placeholder="Someone else: name"
                    value={other[k] ?? ''}
                    onChange={(ev) => setOther({ ...other, [k]: ev.target.value })}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <Button size="sm" disabled={busy === k || !(other[k] ?? '').trim()} onClick={() => void name(k, (other[k] ?? '').trim().toLowerCase().replace(/\s+/g, '-'))}>
                    Save
                  </Button>
                </span>
              </>
            )}
          </span>
        </span>
      ))}
      {msg && <span className="sig" style={{ display: 'block', marginTop: 6 }}>{msg}</span>}
    </span>
  );
}

/** Today's front-door passes, newest first. */
export function DoorTimeline() {
  const [nonce, setNonce] = useState(0);
  const { events, error, real } = useDoorActivity(2, nonce);
  const { dataset } = useData();
  const nameOf = (id: string) => personName(dataset, id);
  if (events === null) return <p className="sec">Loading the front door…</p>;
  if (!events.length)
    return (
      <p className="sec">
        Nobody passed the front door yet today.{error ? <span className="sig"> {error}</span> : ''}
      </p>
    );
  return (
    <>
      <EventList
        items={events.map((e) => {
          const dir = doorDirection(e);
          const stranger = !e.personId;
          return {
            time: hm(e.ts),
            title: (
              <span style={stranger ? { color: 'var(--alert, #e5484d)' } : undefined}>
                {sightingWho(e, nameOf)} {dir === 'arrive' ? 'arrived' : dir === 'leave' ? 'left' : 'at the door'}
              </span>
            ),
            detail: (
              <>
                {[ictDate(e.ts) !== ictDate(Date.now()) ? dayLabel(ictDate(e.ts)) : null, e.confidence !== null ? `${Math.round(e.confidence * 100)} % sure` : null, e.durationS ? `${e.durationS} s in view` : null]
                  .filter(Boolean)
                  .join(' · ')}
                {real && (e.clipPath || e.people?.length) ? <WhoWasIt e={e} onNamed={() => setNonce((n) => n + 1)} /> : null}
              </>
            ),
          };
        })}
      />
      {!real && <p className="cap">Sample passes: sign in to see the real front door.</p>}
    </>
  );
}
