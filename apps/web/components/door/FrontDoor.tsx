'use client';
/**
 * The front door (the camera moved to the villa's entrance on 2026-11-13; migration 0039).
 *
 *   useHomeNow()   who is home right now: the newest of (a) the person's last front-door pass with a direction and
 *                  (b) their phone's presence (public.presence_latest, which maps Cath to Erik's phone). Each person:
 *                  { state: 'home' | 'away' | null, since, via: 'door' | 'phone' }.
 *   <HomeNow>      one line per person ("Erik · home since 18:43 (front door)") plus when each last left and came back.
 *   <DoorTimeline> today's passes, newest first: time, who, Arriving / Leaving / Seen; unknown faces marked.
 */
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_PEOPLE } from '@sleep-lab/core';
import { useAuth } from '@/lib/auth.tsx';
import { doorDirection, sightingWho, useDoorActivity, type CameraSighting } from '@/lib/camera.ts';
import { personName, useData } from '@/lib/data/context.tsx';
import { supabaseClient } from '@/lib/data/supabase.ts';
import { dayLabel, hm, ictDate } from '@/lib/format.ts';
import { EventList, Group, Row, Status } from '../ui.tsx';

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

/** Today's front-door passes, newest first. */
export function DoorTimeline() {
  const { events, error, real } = useDoorActivity(1);
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
            detail: [e.confidence !== null ? `${Math.round(e.confidence * 100)} % sure` : null, e.durationS ? `${e.durationS} s in view` : null].filter(Boolean).join(' · ') || undefined,
          };
        })}
      />
      {!real && <p className="cap">Sample passes: sign in to see the real front door.</p>}
    </>
  );
}
