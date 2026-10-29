import { simulateLiveReading, type Ms, type RoomReading } from '@sleep-lab/core';
import { addDays, ictDate, ictHour, MIN } from '../format.ts';
import { runEngine } from './engine-client.ts';
import type { Dataset, DataSource, NightDetail } from './types.ts';

export const SIM_SEED = 42;
export const SIM_NIGHTS = 90;

/** Before 08:00 ICT this morning's night is still in progress, so the last complete night is yesterday's. */
export function simEndDate(now: Ms): string {
  const today = ictDate(now);
  return ictHour(now) < 8 ? addDays(today, -1) : today;
}

export function createSimSource(seed = SIM_SEED, nights = SIM_NIGHTS): DataSource {
  let dataset: Promise<Dataset> | null = null;
  const partialSubs = new Set<(ds: Dataset) => void>();
  const progressSubs = new Set<(msg: string) => void>();
  let lastPartial: Dataset | null = null;
  const details = new Map<string, Promise<NightDetail>>();
  return {
    kind: 'sim',
    label: `Simulator (seed ${seed}, ${nights} nights)`,
    loadDataset(onProgress, onPartial) {
      if (onPartial) {
        partialSubs.add(onPartial);
        if (lastPartial) onPartial(lastPartial);
      }
      if (onProgress) progressSubs.add(onProgress);
      if (!dataset) {
        const now = Date.now();
        dataset = runEngine<Dataset>({ type: 'simulate', params: { seed, nights, endDate: simEndDate(now), clipTs: now } }, (m) => {
          if (m.partial) {
            lastPartial = m.partial as Dataset;
            for (const f of partialSubs) f(lastPartial);
          }
          if (m.progress) for (const f of progressSubs) f(m.progress);
        });
        const clear = () => {
          partialSubs.clear();
          progressSubs.clear();
        };
        dataset.then(clear, clear);
      }
      return dataset;
    },
    loadNightDetail(date) {
      let d = details.get(date);
      if (!d) {
        d = runEngine<NightDetail>({ type: 'detail', date });
        details.set(date, d);
        d.catch(() => details.delete(date));
      }
      return d;
    },
    async liveReading(now) {
      return simulateLiveReading(now, { seed });
    },
    async liveWindow(from, to) {
      const out: RoomReading[] = [];
      for (let t = Math.floor(from / MIN) * MIN; t <= to; t += MIN) out.push(simulateLiveReading(t, { seed }));
      return out;
    },
  };
}
