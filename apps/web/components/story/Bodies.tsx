'use client';
// Scene 5 · Your bodies (docs/DESIGN.md §9.1). One finding sentence, one stage bar per person, then the You | Erik
// table against each person's own typical night. "Open Body" and the 14-night history are one tap away.
import type { PersonNightMetrics } from '@sleep-lab/core';
import type { Dataset, NightDetail } from '@/lib/data/types.ts';
import { dur } from '@/lib/format.ts';
import { Reveal } from '../motion.tsx';
import { Button, Placeholder } from '../ui.tsx';
import { VitalsTable } from '../Vitals.tsx';
import { personScope, Scene, SceneCols, SceneText } from './parts.tsx';
import type { HeroPerson } from './Verdict.tsx';
import s from './story.module.css';

const word = (r: number | null) => (r === null ? null : r >= 80 ? 'well' : r >= 65 ? 'about as usual' : 'less than usual');

export function bodiesHeadline(people: HeroPerson[]): string {
  const here = people.filter((p) => !p.away && Number.isFinite(p.sleep));
  if (!here.length) return 'No body data last night.';
  if (here.some((p) => p.recovery === null)) return 'Reading recovery…';
  const [a, b] = here;
  const wa = word(a!.recovery)!;
  if (!b) return `${a!.name} recovered ${wa}.`;
  const wb = word(b.recovery)!;
  if (wa === wb) return `You both recovered ${wa}.`;
  // Lead with the better recovery.
  const [first, second] = (a!.recovery ?? 0) >= (b.recovery ?? 0) ? [a!, b] : [b, a!];
  const n1 = first.name === 'You' ? 'You' : first.name;
  const n2 = second.name === 'You' ? 'You' : second.name;
  return `${n1} recovered ${word(first.recovery)}. ${n2}, ${word(second.recovery)}.`;
}

const SEG: { key: keyof PersonNightMetrics; name: string; stage: string }[] = [
  { key: 'deepMin', name: 'Deep', stage: 'deep' },
  { key: 'lightMin', name: 'Light', stage: 'light' },
  { key: 'remMin', name: 'REM', stage: 'rem' },
  { key: 'awakeMin', name: 'Awake', stage: 'awake' },
];

function StageBars({ dataset, index }: { dataset: Dataset; index: number }) {
  return (
    <div className={s.stages}>
      {dataset.people.map((p, i) => {
        const m = dataset.person[p.id]?.[index] ?? null;
        if (!m)
          return (
            <div key={p.id} className={personScope(i)}>
              <div className={s.stageTop}>
                <span className={s.vName}>
                  <i aria-hidden />
                  {p.name}
                </span>
                <span className="sec">Away</span>
              </div>
            </div>
          );
        const total = SEG.reduce((a, g) => a + ((m[g.key] as number) || 0), 0) || 1;
        return (
          <div key={p.id} className={personScope(i)}>
            <div className={s.stageTop}>
              <span className={s.vName}>
                <i aria-hidden />
                {p.name}
              </span>
              <span className="body num">
                {dur(m.totalSleepMin)} <span className="sec">asleep</span>
              </span>
            </div>
            <div className={s.stageBar} role="img" aria-label={`${p.name}: ${SEG.map((g) => `${g.name} ${dur(m[g.key] as number)}`).join(', ')}`}>
              {SEG.map((g) => (
                <i key={g.name} style={{ width: `${(((m[g.key] as number) || 0) / total) * 100}%`, background: `var(--stage-${g.stage})` }} />
              ))}
            </div>
            <div className={`cap ${s.stageKey}`}>
              {SEG.map((g) => (
                <span key={g.name}>
                  {g.name} <b className="num">{dur(m[g.key] as number)}</b>
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Bodies({ people, dataset, index, detail, ready, onHistory }: { people: HeroPerson[]; dataset: Dataset; index: number; detail: NightDetail | null; ready: boolean; onHistory: () => void }) {
  return (
    <Scene id="bodies" title="Your bodies">
      <SceneCols
        text={
          <SceneText
            label="Your bodies"
            title={bodiesHeadline(people)}
            lede="Each figure is compared with that person’s own typical night over the last 30, not with each other."
          >
            <Reveal className={s.textActions} delay={180}>
              <Button variant="secondary" href="/body" icon="chevron-right">
                Open Body
              </Button>
              <Button variant="text" onClick={onHistory}>
                Last 14 nights
              </Button>
            </Reveal>
          </SceneText>
        }
      >
        <Reveal>
          <StageBars dataset={dataset} index={index} />
        </Reveal>
        <Reveal delay={100}>{ready ? <VitalsTable dataset={dataset} index={index} detail={detail} /> : <Placeholder height={420} text="Comparing with each person’s last 30 nights…" />}</Reveal>
      </SceneCols>
    </Scene>
  );
}
