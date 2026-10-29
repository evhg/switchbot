'use client';
// 05 · Your bodies — normal scroll (docs/DESIGN.md §10.05). Generated two-tone headline, a person card per sleeper
// (sleep + recovery counting up over a corner wash in their colour), then the vitals comparison table.
import Link from 'next/link';
import type { Dataset } from '@/lib/data/types.ts';
import { writePref } from '@/lib/prefs.ts';
import { Chapter, CountUp, Reveal } from '../motion.tsx';
import { Placeholder, SectionHeader } from '../ui.tsx';
import { VitalsTable } from '../Vitals.tsx';
import type { HeroPerson } from './Verdict.tsx';
import s from './story.module.css';

export function bodiesHeadline(people: HeroPerson[]): [string, string] {
  const here = people.filter((p) => !p.away && Number.isFinite(p.sleep));
  const two = here.length > 1;
  const first = two ? 'Two bodies,' : here.length === 1 ? 'One body,' : 'No body data';
  if (!here.length) return [first, 'nothing synced.'];
  if (here.some((p) => p.recovery === null)) return [first, 'reading recovery…'];
  const low = here.filter((p) => (p.recovery ?? 0) < 60);
  const high = here.filter((p) => (p.recovery ?? 0) >= 75);
  if (!low.length && high.length === here.length) return [first, two ? 'both recovered.' : 'recovered.'];
  if (low.length === here.length) return [first, two ? 'both need rest.' : 'needs rest.'];
  if (low.length) return [first, `${low[0]!.name === 'You' ? 'you need' : `${low[0]!.name} needs`} rest.`];
  return [first, two ? 'holding steady.' : 'holding steady.'];
}

export function Bodies({ people, dataset, index, ready }: { people: HeroPerson[]; dataset: Dataset; index: number; ready: boolean }) {
  const [l1, l2] = bodiesHeadline(people);
  return (
    <Chapter id="bodies" n={5} title="Your bodies" accent="bodies" className="bleed">
      <SectionHeader n={5} kicker="Your bodies" lines={[l1, l2]} tone="muted" />
      <Reveal stagger className={s.bodHead} style={{ gridTemplateColumns: `repeat(${Math.max(1, people.length)}, minmax(0, 1fr))` }}>
        {people.map((p) => (
          <Link
            key={p.id}
            prefetch={false}
            href="/body"
            onClick={() => writePref('bodyPerson', p.id)}
            className={`${s.bp} tap`}
            style={{ ['--pc' as string]: p.color }}
            aria-label={`${p.name}: ${p.away ? 'away' : `sleep ${Math.round(p.sleep)}, recovery ${p.recovery ?? 'pending'}`}. Open Body`}
          >
            <div className={s.bpName}>
              <i />
              {p.name}
            </div>
            {p.away ? (
              <div className={s.bpRow}>
                <div>
                  <b className="muted">–</b>
                  <span className={s.bpLbl}>Away</span>
                </div>
              </div>
            ) : (
              <div className={s.bpRow}>
                <div>
                  <CountUp value={p.sleep} className={s.bpNum} />
                  <span className={s.bpLbl}>Sleep</span>
                </div>
                <div>
                  {p.recovery !== null ? <CountUp value={p.recovery} className={s.bpNum} /> : <b className={`${s.bpNum} muted`}>–</b>}
                  <span className={s.bpLbl}>Recovery</span>
                </div>
              </div>
            )}
          </Link>
        ))}
      </Reveal>
      {ready ? <VitalsTable dataset={dataset} index={index} /> : <div style={{ marginTop: 18 }}><Placeholder height={460} text="Comparing with each person's 30-night baseline…" /></div>}
    </Chapter>
  );
}
