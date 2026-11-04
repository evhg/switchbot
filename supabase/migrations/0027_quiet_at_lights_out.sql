-- Quiet fan at lights-out, not half an hour later (2026-11-04).
--
-- The household asked for no beep once they are in bed: the fan-only "cool 17 low" step moves from 22:30
-- (lights-out + 30) to 22:00 (lights-out). The quiet curves' onset phase now runs fan low, so the night's commands
-- are 21:30 "17 cool auto", 22:00 "cool 17 low", 09:00 "off" and nothing in between. Mirrors packages/core/src/curve.ts.
-- The experiment variants get the same onset change; the two with a 03:00 warming step are no longer offered to
-- experiments or Autopilot (core EXPERIMENT_CURVES), their rows stay for nights that stored them.
-- Idempotent: only rewrites phase 1 (onset) of the named curves.

update public.curves
set phases = jsonb_set(phases, '{1,fan}', '"low"'::jsonb)
where id in ('steady-18-5-quiet-v1', 'steady-19-5-quiet-v1', 'warm-late-19-5-quiet-v1', 'cool-early-warm-late-v1')
  and phases -> 1 ->> 'name' = 'onset';
