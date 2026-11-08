'use client';
/**
 * Phone System root (docs/DESIGN.md §9.5, mock 07-system-390): a large "System" title, the featured Tonight's plan
 * card (mini curve + Starts / Coolest / Wake), then grouped lists whose rows show a value and a chevron. When signed
 * in, "Signed in as <email>" with Sign out sits under the title.
 */
import { useMemo, type ReactNode } from 'react';
import type { TemperatureCurve } from '@sleep-lab/core';
import { useAuth } from '@/lib/auth.tsx';
import { useData } from '@/lib/data/context.tsx';
import { useTonightCurve } from '@/lib/curve-store.ts';
import { useBandSync } from '@/lib/bands.ts';
import { useHealthLinks, usePushSubscribed } from '@/lib/system-status.ts';
import { fmt } from '@/lib/format.ts';
import { useTheme } from '@/lib/theme.tsx';
import { linePath, scale } from '../charts/common.tsx';
import { SYSTEM_GROUPS, systemHref, type SystemSlug } from '../nav.tsx';
import { Button, FeaturedCard, Group, PageHeader, Row, Skeleton, useWidth } from '../ui.tsx';
import { clock, driftAlerts, planTimes, tagLabel, useMorningReport, usePlanClock, useSetupProgress, useTonightTags } from './model.ts';
import { useAccountName } from '../Sidebar.tsx';
import { useCameraSummary } from './camera.tsx';
import { useAlertsSummary } from './alerts.tsx';
import { useLocationSummary } from './location.tsx';
import { usePresenceSummary } from './presence.tsx';
import s from './system.module.css';

const M0 = -120;
const M1 = 540;

function PlanMini({ curve }: { curve: TemperatureCurve }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const H = 84;
  const x = scale(M0, M1, 0, Math.max(w, 1));
  const y = scale(curve.minC, curve.maxC, H - 6, 6);
  const pts: { x: number; y: number }[] = [];
  curve.phases.forEach((p, i) => {
    const next = curve.phases[i + 1];
    pts.push({ x: x(Math.max(M0, p.startMin)), y: y(p.targetC) });
    pts.push({ x: x(next ? next.startMin : M1), y: y(p.ramp && next ? next.targetC : p.targetC) });
  });
  return (
    <div ref={ref} className={s.mini} aria-hidden>
      {w > 0 && (
        <svg width={w} height={H}>
          {[19, 21].map((t) => (
            <line key={t} x1={0} x2={w} y1={y(t)} y2={y(t)} stroke="var(--grid)" />
          ))}
          <path d={linePath(pts)} fill="none" stroke="var(--signal)" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </div>
  );
}

const MODE: Record<string, string> = { auto: 'Auto', light: 'Light', dark: 'Dark', night: 'Night' };

export function SystemRoot() {
  const { dataset, latest, sourceKind, mode: dataMode } = useData();
  const { mode } = useTheme();
  const { curve } = useTonightCurve();
  const pc = usePlanClock();
  const { tags } = useTonightTags();
  const [morningPref] = useMorningReport();
  // The device's push subscription wins over the stored choice (a cleared browser has none).
  const subscribed = usePushSubscribed();
  const morning = subscribed === undefined ? morningPref : subscribed === true;
  const setup = useSetupProgress();
  const presence = usePresenceSummary();
  const camera = useCameraSummary();
  const location = useLocationSummary();
  const alerts = useAlertsSummary();
  const auth = useAuth();
  const who = useAccountName();
  const member = auth.status === 'signed-in' && Boolean(auth.probe?.member);
  const { bands } = useBandSync(member);
  const links = useHealthLinks(member);
  const drift = useMemo(() => (dataset ? driftAlerts(dataset).length : null), [dataset]);
  const people = (dataset ?? latest)?.people;
  const ph = curve.phases;
  const times = planTimes(curve, pc.lightsOut, pc.wake);
  const healthIds = new Set([...Object.entries(links ?? {}).filter(([, v]) => v).map(([k]) => k), ...Object.values(bands ?? {}).filter((b) => b.lastSyncOk).map((b) => b.personId)]);
  const healthErr = Object.values(bands ?? {}).some((b) => b.lastSyncOk === false);
  const total = people?.length ?? 2;
  const health: ReactNode = !member
    ? 'Not connected'
    : bands === null && links === null
      ? <Skeleton w={52} h={14} r="text" inline />
      : healthErr
        ? <span className="sig">Sync errors</span>
        : healthIds.size === 0
          ? 'Not connected'
          : healthIds.size >= total
            ? 'Connected'
            : `${healthIds.size} of ${total} connected`;

  const values: Record<SystemSlug, ReactNode> = {
    plan: `${fmt(Math.min(...ph.map((p) => p.targetC)), 1)}° coolest`,
    presence,
    location,
    tags: tags.length ? (tags.length > 2 ? `${tags.length} tags` : tags.map(tagLabel).join(', ')) : 'None',
    general: `${MODE[mode]}${people ? ` · ${people.map((p) => p.name).join(', ')}` : ''}`,
    morning: morning ? 'On' : 'Off',
    alerts,
    data: sourceKind === 'sim' ? (dataMode === 'sim' ? 'Simulated' : 'Simulated for now') : 'Real data',
    health,
    camera,
    co2: drift === null ? <Skeleton w={52} h={14} r="text" inline /> : drift ? <span className="sig">{drift === 1 ? '1 alert' : `${drift} alerts`}</span> : 'No alerts',
    setup: `${setup.count} of ${setup.total}`,
    diagnostics: undefined,
  };

  return (
    <div className={s.root}>
      <PageHeader title="System" />
      {who && (
        <Group className={s.account}>
          <Row
            title={`Signed in as ${who.email}`}
            sub={who.name}
            trailing={
              <Button size="sm" variant="text" onClick={() => void auth.signOut()}>
                Sign out
              </Button>
            }
          />
        </Group>
      )}
      <FeaturedCard title="Tonight’s plan" action={{ label: 'Edit', href: systemHref('plan') }}>
        <PlanMini curve={curve} />
        <dl className={s.strip}>
          <div>
            <dt>Starts</dt>
            <dd className="num">{clock(times.starts)}</dd>
          </div>
          <div>
            <dt>Coolest</dt>
            <dd className="num">{fmt(times.coolest, 1)}°</dd>
          </div>
          <div>
            <dt>Wake</dt>
            <dd className="num">{clock(times.wake)}</dd>
          </div>
        </dl>
      </FeaturedCard>
      <nav aria-label="System" className={s.groups}>
        {SYSTEM_GROUPS.map((g) => {
          const pages = g.pages.filter((p) => p.slug !== 'plan');
          return (
            <Group key={g.label} label={g.label}>
              {pages.map((p) => (
                <Row key={p.slug} title={p.label} value={values[p.slug]} href={systemHref(p.slug)} />
              ))}
            </Group>
          );
        })}
      </nav>
      <p className={`cap ${s.rootFoot}`}>Most settings are shared with the household. Only appearance, names, the quiet-mode preview and setup ticks are kept on this device.</p>
    </div>
  );
}
