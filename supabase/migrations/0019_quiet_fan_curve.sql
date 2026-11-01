-- Steady 18.5 °C with a quiet fan (decided 2026-11-01, live from the night of 2026-11-02).
--
-- On 2026-11-01 the steady-18-5-v1 night ran as planned, but the aircon's fan on auto was too loud to fall asleep.
-- 'steady-18-5-quiet-v1' (mirrors DEFAULT_CURVE in packages/core/src/curve.ts) keeps the 21:30 pre-cool on fan auto
-- (fast pull-down) and switches to fan low at lights-out + 30 min (22:30), same 18.5 °C target, so the same setpoint
-- (17 with the bias −2): one fan-only command, the learned "cool 17 low" button. Low all night, OFF at wake + 30 (09:00).
--
-- 1. curves: insert the new curve and make it the only default (the previous default is kept, is_default = false).
--    The old row keeps its phases; only its display name changes, so stored nights and their scoring are unchanged.
-- 2. nights: real nights from 2026-11-02 on that still use 'steady-18-5-v1' move to the new curve (tonight included).
--    A night row created later by ac-curve (ensureNight) takes the default curve, i.e. the new one.
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

-- ---------------------------------------------------------------- 1. the quiet-fan curve

update public.curves set is_default = false where is_default and id <> 'steady-18-5-quiet-v1';

insert into public.curves (id, name, phases, min_c, max_c, is_default) values (
  'steady-18-5-quiet-v1',
  'Steady 18.5 °C, quiet fan (default)',
  '[{"name":"precool","startMin":-30,"targetC":18.5,"fan":"auto"},
    {"name":"onset","startMin":0,"targetC":18.5,"fan":"auto"},
    {"name":"deep","startMin":30,"targetC":18.5,"fan":"low"},
    {"name":"middle","startMin":270,"targetC":18.5,"fan":"low"},
    {"name":"late","startMin":360,"targetC":18.5,"fan":"low"},
    {"name":"wake","startMin":630,"targetC":18.5,"fan":"low"}]'::jsonb,
  17, 24, true
)
on conflict (id) do update set
  name = excluded.name, phases = excluded.phases, min_c = excluded.min_c, max_c = excluded.max_c, is_default = true;

update public.curves set name = 'Steady 18.5 °C (v1, fan auto)' where id = 'steady-18-5-v1';

-- ---------------------------------------------------------------- 2. upcoming nights

update public.nights n set
  curve_id = 'steady-18-5-quiet-v1'
where n.date >= date '2026-11-02'
  and not n.is_sim
  and n.curve_id = 'steady-18-5-v1';
