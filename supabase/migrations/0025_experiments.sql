-- Lab › Experiments (2026-11-04): compare 2 (max 3) arms over nights, randomised, with a verdict per outcome.
--
-- Two kinds:
--   auto   — Sleep Lab switches the arm itself: each arm is an aircon curve; the experiments Edge Function sets
--            nights.curve_id for the upcoming night before the pre-cool (never over a curve chosen by hand: the new
--            nights.curve_source = 'user', set by set_night; that night then does not count). In the morning a night
--            whose curve is not its arm's (changed after it was applied) does not count either.
--   manual — the household does it (door open a crack vs closed, earplugs …): a 20:30 ICT push tells both of them
--            tonight's arm, an arm's tag (e.g. door_ajar) is set on the night, and a night marked "didn't follow"
--            (one tap in the app) does not count.
-- Assignment: balanced randomisation in blocks of (number of arms), reproducible from experiments.seed (core
-- assignArm); away nights get no assignment; a night that ends up without data repeats its slot. A night can be pinned
-- by hand ("Pin tonight"). Outcomes (core nightOutcomes) are computed from 10:00 ICT the morning after; the verdict
-- (core analyzeExperiment, Welch t posterior: P(better) and a 90 % interval per outcome) is stored in
-- experiments.analysis. Min 4 counted nights per arm (Autopilot: 6), at most 21, then it finishes on its own.
-- Autopilot (household_settings.autopilot, off by default): keeps one aircon experiment going, default curve vs the
-- next candidate, and adopts the candidate only when it is clearly better on the sleep score with no worse awakenings.
--
-- 1. curves: three safe variants for aircon experiments (is_default stays false; mirrors packages/core/src/curve.ts).
-- 2. household_settings.autopilot; nights.curve_source ('default' | 'user' | 'experiment', null = not recorded) and
--    set_night (0004) recreated to record 'user' when a curve is passed.
-- 3. public.experiments, public.experiment_nights, public.experiment_log: household members read.
-- 4. Writes: create_experiment(), pin_experiment_arm(), mark_experiment_night(), finish_experiment(), set_autopilot()
--    undo_adoption() (back to the curve before the last adoption)
--    (owner / member; definer in private + invoker in public, the pattern of 0020/0023/0024). Service role only:
--    experiment_apply_night(), experiment_finish(), adopt_default_curve().
-- 5. Tonight (2026-11-04 evening, night 2026-11-05) the door is open a crack: the "Door: open a crack vs closed"
--    experiment is started with that night pinned to 'open' (only when no manual experiment exists yet).
-- 6. pg_cron: the experiments function every 15 min.
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

-- ---------------------------------------------------------------- 1. curve variants

insert into public.curves (id, name, phases, min_c, max_c, is_default) values
(
  'warm-late-19-5-quiet-v1',
  '18.5 °C, 19.5 °C from 03:00 (quiet fan)',
  '[{"name":"precool","startMin":-30,"targetC":18.5,"fan":"auto"},
    {"name":"onset","startMin":0,"targetC":18.5,"fan":"low"},
    {"name":"deep","startMin":30,"targetC":18.5,"fan":"low"},
    {"name":"middle","startMin":300,"targetC":19.5,"fan":"low"},
    {"name":"late","startMin":360,"targetC":19.5,"fan":"low"},
    {"name":"wake","startMin":630,"targetC":19.5,"fan":"low"}]'::jsonb,
  17, 24, false
),
(
  'steady-19-5-quiet-v1',
  'Steady 19.5 °C, quiet fan',
  '[{"name":"precool","startMin":-30,"targetC":19.5,"fan":"auto"},
    {"name":"onset","startMin":0,"targetC":19.5,"fan":"low"},
    {"name":"deep","startMin":30,"targetC":19.5,"fan":"low"},
    {"name":"middle","startMin":270,"targetC":19.5,"fan":"low"},
    {"name":"late","startMin":360,"targetC":19.5,"fan":"low"},
    {"name":"wake","startMin":630,"targetC":19.5,"fan":"low"}]'::jsonb,
  17, 24, false
),
(
  'cool-early-warm-late-v1',
  '18 °C early, 19.5 °C from 03:00 (quiet fan)',
  '[{"name":"precool","startMin":-30,"targetC":18,"fan":"auto"},
    {"name":"onset","startMin":0,"targetC":18,"fan":"low"},
    {"name":"deep","startMin":30,"targetC":18,"fan":"low"},
    {"name":"middle","startMin":300,"targetC":19.5,"fan":"low"},
    {"name":"late","startMin":360,"targetC":19.5,"fan":"low"},
    {"name":"wake","startMin":630,"targetC":19.5,"fan":"low"}]'::jsonb,
  17, 24, false
)
on conflict (id) do update set name = excluded.name, phases = excluded.phases, min_c = excluded.min_c, max_c = excluded.max_c;

-- ---------------------------------------------------------------- 2. household settings

alter table public.household_settings add column if not exists autopilot boolean not null default false;
comment on column public.household_settings.autopilot is
  'Experiments Autopilot: true = keep one aircon experiment running (default curve vs the next safe candidate) and '
  'adopt a candidate only when it is clearly better on the sleep score with no worse awakenings. Set with set_autopilot().';

-- Where a night's curve came from: 'user' (set_night with a curve: the engine never replaces it), 'experiment' (an
-- experiment arm), 'default' / null (the default at creation, or not recorded before 0025).
alter table public.nights add column if not exists curve_source text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'nights_curve_source_check' and conrelid = 'public.nights'::regclass) then
    alter table public.nights add constraint nights_curve_source_check check (curve_source is null or curve_source in ('default', 'user', 'experiment'));
  end if;
end $$;
comment on column public.nights.curve_source is
  'Where curve_id came from: user (chosen by hand with set_night; experiments and adoptions leave it alone), '
  'experiment (an experiment arm), default or null (the default curve).';

-- set_night (0004) unchanged except that a curve passed by hand is recorded as curve_source = 'user'.
create or replace function private.set_night(
  p_date date,
  p_lights_out timestamptz default null,
  p_wake timestamptz default null,
  p_tags text[] default null,
  p_curve_id text default null,
  p_ac_enabled boolean default null
) returns public.nights
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.nights;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_date < (now() at time zone 'Asia/Bangkok')::date - 7 or p_date > (now() at time zone 'Asia/Bangkok')::date + 7 then
    raise exception 'date % is outside ±7 days of today', p_date using errcode = '22023';
  end if;
  update public.nights n set
    lights_out = coalesce(p_lights_out, n.lights_out),
    wake = coalesce(p_wake, n.wake),
    tags = coalesce(p_tags, n.tags),
    curve_id = coalesce(p_curve_id, n.curve_id),
    curve_source = case when p_curve_id is not null then 'user' else n.curve_source end,
    ac_enabled = coalesce(p_ac_enabled, n.ac_enabled),
    updated_at = now()
  where n.date = p_date
  returning * into v_row;
  if not found then
    if p_lights_out is null or p_wake is null then
      raise exception 'new night % needs lights_out and wake', p_date;
    end if;
    insert into public.nights (date, lights_out, wake, tags, curve_id, curve_source, ac_enabled)
    values (p_date, p_lights_out, p_wake, coalesce(p_tags, '{}'),
            coalesce(p_curve_id, (select c.id from public.curves c where c.is_default)),
            case when p_curve_id is not null then 'user' else 'default' end,
            coalesce(p_ac_enabled, true))
    returning * into v_row;
  end if;
  return v_row;
end $$;
revoke all on function private.set_night(date, timestamptz, timestamptz, text[], text, boolean) from public, anon;
grant execute on function private.set_night(date, timestamptz, timestamptz, text[], text, boolean) to authenticated;

-- ---------------------------------------------------------------- 3. tables

create table if not exists public.experiments (
  id bigint generated always as identity primary key,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  title text not null check (length(title) between 1 and 120),
  kind text not null check (kind in ('auto', 'manual')),
  arms jsonb not null check (jsonb_typeof(arms) = 'array' and jsonb_array_length(arms) between 2 and 3),
  primary_outcome text not null default 'sleep_score' check (primary_outcome ~ '^[a-z0-9_]{1,40}$'),
  status text not null default 'running' check (status in ('running', 'finished', 'stopped')),
  started_on date not null,
  ended_on date,
  winner_arm text,
  seed integer not null,
  autopilot boolean not null default false,
  min_per_arm smallint not null default 4 check (min_per_arm between 2 and 14),
  max_nights smallint not null default 21 check (max_nights between 4 and 60),
  analysis jsonb,
  analyzed_at timestamptz,
  notes text check (notes is null or length(notes) <= 1000),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'auto' or not autopilot)
);
comment on table public.experiments is
  'Lab › Experiments. arms: [{key, label, curve_id? (auto), instruction? (manual), tag?}], the first arm is the control. '
  'status: running | finished | stopped (the live verdict running / leaning / clear_winner / no_difference is '
  'analysis.status). analysis: the latest core analyzeExperiment summary written by the experiments function.';
comment on column public.experiments.seed is 'Randomisation seed (core assignArm): same seed + same counted nights = same assignments.';
comment on column public.experiments.analysis is
  '{status, verdict, leader, winner, counts, counted, excluded, done, primary: {key, diff, lo, hi, pBetter}, line}.';

-- One running experiment per kind (one aircon experiment and one household experiment at a time).
create unique index if not exists experiments_one_running_per_kind on public.experiments (kind) where status = 'running';
create index if not exists experiments_started on public.experiments (started_on desc);

create table if not exists public.experiment_nights (
  experiment_id bigint not null references public.experiments (id),
  night_date date not null,
  arm_key text not null check (length(arm_key) between 1 and 60),
  source text not null default 'random' check (source in ('random', 'pinned')),
  followed boolean not null default true,
  outcomes jsonb,
  computed_at timestamptz,
  applied_at timestamptz,
  apply_note text,
  applied_tag text,
  notified_at timestamptz,
  marked_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (experiment_id, night_date)
);
comment on table public.experiment_nights is
  'One row per experiment night (night_date = wake date, like nights.date). source: random (the engine) or pinned '
  '(by hand). followed = false: "didn''t follow" (not counted). outcomes: core NightOutcomes, computed from 10:00 ICT '
  'the morning after. applied_at: when the curve / tag was set on the night; notified_at: the 20:30 push.';
alter table public.experiment_nights add column if not exists applied_tag text;
comment on column public.experiment_nights.applied_tag is
  'The tag this experiment added to nights.tags (a tag that was already there is not recorded): the only tag it may '
  'take off again when the night is re-pinned.';
create index if not exists experiment_nights_date on public.experiment_nights (night_date desc);

create table if not exists public.experiment_log (
  id bigint generated always as identity primary key,
  experiment_id bigint references public.experiments (id),
  at timestamptz not null default now(),
  kind text not null check (length(kind) between 1 and 40),
  message text not null check (length(message) between 1 and 1000),
  data jsonb not null default '{}'::jsonb
);
comment on table public.experiment_log is
  'Every experiment and Autopilot decision (created, assigned, pinned, marked, applied, push, analysis, adopted, '
  'finished, autopilot …), newest last. Written by the RPCs and the experiments function.';
create index if not exists experiment_log_at on public.experiment_log (at desc);
create index if not exists experiment_log_experiment on public.experiment_log (experiment_id, at desc);

alter table public.experiments enable row level security;
alter table public.experiment_nights enable row level security;
alter table public.experiment_log enable row level security;
do $$
declare
  t text;
begin
  foreach t in array array['experiments', 'experiment_nights', 'experiment_log'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'household read') then
      execute format('create policy "household read" on public.%I for select to authenticated using ((select private.is_household_member()))', t);
    end if;
  end loop;
end $$;

revoke all on public.experiments, public.experiment_nights, public.experiment_log from public, anon, authenticated;
grant select on public.experiments, public.experiment_nights, public.experiment_log to authenticated;
grant all on public.experiments, public.experiment_nights, public.experiment_log to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------- 4. helpers (private)

-- The next night that has not started: wake date = tomorrow (ICT). From 12:00 this is also nightDateFor(now()).
create or replace function private.next_night_date() returns date
language sql stable set search_path = '' as $$
  select ((now() at time zone 'Asia/Bangkok')::date + 1)
$$;
revoke all on function private.next_night_date() from public, anon;
grant execute on function private.next_night_date() to authenticated, service_role;

create or replace function private.experiment_log_add(p_experiment bigint, p_kind text, p_message text, p_data jsonb default '{}'::jsonb)
returns void
language sql security definer set search_path = '' as $$
  insert into public.experiment_log (experiment_id, kind, message, data)
  values (p_experiment, p_kind, left(p_message, 1000), coalesce(p_data, '{}'::jsonb))
$$;
revoke all on function private.experiment_log_add(bigint, text, text, jsonb) from public, anon, authenticated;
grant execute on function private.experiment_log_add(bigint, text, text, jsonb) to service_role;

-- Make p_curve_id the default curve. Upcoming nights whose pre-cool has not started and that still run the old
-- default move to it (like 0019 did by hand).
create or replace function private.adopt_default_curve(p_curve_id text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_old text;
begin
  if not exists (select 1 from public.curves c where c.id = p_curve_id) then
    raise exception 'unknown curve %', p_curve_id using errcode = '22023';
  end if;
  select c.id into v_old from public.curves c where c.is_default;
  if v_old is not distinct from p_curve_id then
    return v_old;
  end if;
  update public.curves set is_default = false where is_default and id <> p_curve_id;
  update public.curves set is_default = true where id = p_curve_id;
  update public.nights n set curve_id = p_curve_id, curve_source = 'default', updated_at = now()
  where n.date >= (now() at time zone 'Asia/Bangkok')::date
    and not n.is_sim
    and n.curve_id is not distinct from v_old
    and n.curve_source is distinct from 'user'
    and n.lights_out - interval '45 minutes' > now();
  perform private.experiment_log_add(null, 'adopted', format('Default aircon curve is now %s (was %s)', p_curve_id, coalesce(v_old, 'none')),
    jsonb_build_object('curve_id', p_curve_id, 'previous', v_old));
  return v_old;
end $$;
revoke all on function private.adopt_default_curve(text) from public, anon, authenticated;

-- Apply an experiment night to the nights row (if it exists).
--   auto   → nights.curve_id = the arm's curve (curve_source 'experiment'), only before the pre-cool (lights-out −
--            45 min) and never over a curve chosen by hand (curve_source 'user'): that night is then not followed.
--   manual → the arm's tag is added (recorded in applied_tag when it wasn't there yet). Only a tag this experiment
--            added earlier for another arm (re-pin) is taken off; tags set by hand stay. A night that already carries
--            another arm's tag (set by hand) keeps it and is marked not followed.
-- Returns a short note; sets applied_at / apply_note.
create or replace function private.experiment_apply_night(p_experiment bigint, p_night date) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_exp public.experiments;
  v_en public.experiment_nights;
  v_night public.nights;
  v_arm jsonb;
  v_tag text;
  v_other_tags text[];
  v_tags text[];
  v_added text;
  v_conflict text;
  v_note text;
  v_followed boolean;
begin
  select * into v_exp from public.experiments e where e.id = p_experiment;
  select * into v_en from public.experiment_nights x where x.experiment_id = p_experiment and x.night_date = p_night;
  if v_exp.id is null or v_en.experiment_id is null then
    return 'no such experiment night';
  end if;
  select * into v_night from public.nights n where n.date = p_night;
  if v_night.date is null then
    return 'night row not created yet';
  end if;
  select a into v_arm from jsonb_array_elements(v_exp.arms) a where a->>'key' = v_en.arm_key;
  if v_arm is null then
    return 'unknown arm';
  end if;
  v_followed := v_en.followed;
  v_added := v_en.applied_tag;
  if v_exp.kind = 'auto' then
    if v_night.curve_id is not distinct from (v_arm->>'curve_id') then
      v_note := 'curve already ' || (v_arm->>'curve_id');
    elsif v_night.curve_source is not distinct from 'user' then
      v_note := 'kept the curve chosen by hand: ' || coalesce(v_night.curve_id, 'default');
      v_followed := false;
    elsif v_night.lights_out - interval '45 minutes' <= now() then
      v_note := 'too late: pre-cool has started, curve stays ' || coalesce(v_night.curve_id, 'default');
      v_followed := false;
    else
      update public.nights n set curve_id = v_arm->>'curve_id', curve_source = 'experiment', updated_at = now() where n.date = p_night;
      v_note := 'curve set to ' || (v_arm->>'curve_id');
    end if;
  else
    v_tag := v_arm->>'tag';
    v_tags := coalesce(v_night.tags, '{}');
    -- Take off only the tag this experiment put there for another arm.
    if v_added is not null and v_added is distinct from v_tag then
      v_tags := array(select t from unnest(v_tags) t where t <> v_added);
      v_added := null;
    end if;
    select coalesce(array_agg(a->>'tag'), '{}') into v_other_tags
    from jsonb_array_elements(v_exp.arms) a where a ? 'tag' and a->>'key' <> v_en.arm_key and (a->>'tag') is distinct from v_tag;
    select t into v_conflict from unnest(v_tags) t where t = any (v_other_tags) limit 1;
    if v_tag is not null and not (v_tag = any (v_tags)) then
      v_tags := v_tags || v_tag;
      v_added := v_tag;
    end if;
    update public.nights n set tags = v_tags, updated_at = now() where n.date = p_night;
    if v_conflict is not null then
      v_note := 'kept tag ' || v_conflict || ' set by hand';
      v_followed := false;
    else
      v_note := case when v_tag is not null then 'tag ' || v_tag || ' set' else 'nothing to set' end;
    end if;
  end if;
  update public.experiment_nights x set applied_at = now(), apply_note = v_note, applied_tag = v_added, followed = v_followed, updated_at = now()
  where x.experiment_id = p_experiment and x.night_date = p_night;
  perform private.experiment_log_add(p_experiment, 'applied', format('%s: %s (%s)', p_night, v_arm->>'label', v_note),
    jsonb_build_object('night', p_night, 'arm', v_en.arm_key, 'note', v_note));
  return v_note;
end $$;
revoke all on function private.experiment_apply_night(bigint, date) from public, anon, authenticated;

-- Finish (or stop) an experiment; optionally adopt an auto arm's curve as the default. Upcoming nights that still run
-- one of its challenger curves (and whose pre-cool has not started) go back to the default.
create or replace function private.experiment_finish_core(p_experiment bigint, p_status text, p_adopt_arm text, p_actor uuid, p_reason text)
returns public.experiments
language plpgsql security definer set search_path = '' as $$
declare
  v_exp public.experiments;
  v_arm jsonb;
  v_winner text;
  v_curves text[];
begin
  select * into v_exp from public.experiments e where e.id = p_experiment for update;
  if v_exp.id is null then
    raise exception 'no experiment %', p_experiment using errcode = '22023';
  end if;
  if v_exp.status <> 'running' then
    raise exception 'experiment % is already %', v_exp.slug, v_exp.status using errcode = '22023';
  end if;
  if p_status not in ('finished', 'stopped') then
    raise exception 'status must be finished or stopped' using errcode = '22023';
  end if;
  v_winner := coalesce(p_adopt_arm, v_exp.analysis->>'winner');
  if p_adopt_arm is not null then
    if v_exp.kind <> 'auto' then
      raise exception 'only aircon experiments can be adopted' using errcode = '22023';
    end if;
    select a into v_arm from jsonb_array_elements(v_exp.arms) a where a->>'key' = p_adopt_arm;
    if v_arm is null or not (v_arm ? 'curve_id') then
      raise exception 'arm % has no curve', p_adopt_arm using errcode = '22023';
    end if;
    perform private.adopt_default_curve(v_arm->>'curve_id');
  end if;
  update public.experiments e set
    status = p_status,
    ended_on = (now() at time zone 'Asia/Bangkok')::date,
    winner_arm = case when p_status = 'finished' then v_winner else null end,
    updated_at = now()
  where e.id = p_experiment
  returning * into v_exp;
  if v_exp.kind = 'auto' then
    select coalesce(array_agg(a->>'curve_id'), '{}') into v_curves from jsonb_array_elements(v_exp.arms) a where a ? 'curve_id';
    update public.nights n set curve_id = (select c.id from public.curves c where c.is_default), curve_source = 'default', updated_at = now()
    where n.date >= (now() at time zone 'Asia/Bangkok')::date
      and not n.is_sim
      and n.curve_id = any (v_curves)
      and n.curve_id is distinct from (select c.id from public.curves c where c.is_default)
      and n.curve_source is distinct from 'user'
      and n.lights_out - interval '45 minutes' > now();
  end if;
  perform private.experiment_log_add(p_experiment, p_status,
    format('%s %s%s%s', v_exp.title, p_status,
      case when p_adopt_arm is not null then ', adopted ' || (v_arm->>'label') else '' end,
      case when p_reason is not null then ': ' || p_reason else '' end),
    jsonb_build_object('winner', v_exp.winner_arm, 'adopted', p_adopt_arm, 'by', p_actor));
  return v_exp;
end $$;
revoke all on function private.experiment_finish_core(bigint, text, text, uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------- 4b. RPCs for the app (owner / member)

create or replace function private.create_experiment(
  p_title text,
  p_kind text,
  p_arms jsonb,
  p_primary text default 'sleep_score',
  p_slug text default null,
  p_notes text default null,
  p_started_on date default null,
  p_pin_tonight text default null
) returns public.experiments
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.experiments;
  v_arm jsonb;
  v_keys text[] := '{}';
  v_slug text;
  v_start date := coalesce(p_started_on, private.next_night_date());
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('auto', 'manual') then
    raise exception 'kind must be auto or manual' using errcode = '22023';
  end if;
  if p_title is null or length(trim(p_title)) not between 1 and 120 then
    raise exception 'title: 1 to 120 characters' using errcode = '22023';
  end if;
  if p_arms is null or jsonb_typeof(p_arms) <> 'array' or jsonb_array_length(p_arms) not between 2 and 3 then
    raise exception 'arms: 2 or 3 needed' using errcode = '22023';
  end if;
  if coalesce(p_primary, 'sleep_score') !~ '^[a-z0-9_]{1,40}$' then
    raise exception 'unknown primary outcome' using errcode = '22023';
  end if;
  if v_start < (now() at time zone 'Asia/Bangkok')::date - 7 or v_start > private.next_night_date() + 14 then
    raise exception 'start date out of range' using errcode = '22023';
  end if;
  for v_arm in select a from jsonb_array_elements(p_arms) a loop
    if jsonb_typeof(v_arm) <> 'object' or coalesce(v_arm->>'key', '') !~ '^[a-z0-9][a-z0-9._-]{0,59}$' then
      raise exception 'arm key: lower-case letters, digits, . _ - (max 60)' using errcode = '22023';
    end if;
    if v_arm->>'key' = any (v_keys) then
      raise exception 'arm keys must be different' using errcode = '22023';
    end if;
    v_keys := v_keys || (v_arm->>'key');
    if length(coalesce(v_arm->>'label', '')) not between 1 and 60 then
      raise exception 'arm label: 1 to 60 characters' using errcode = '22023';
    end if;
    if p_kind = 'auto' and not exists (select 1 from public.curves c where c.id = v_arm->>'curve_id') then
      raise exception 'arm %: unknown aircon curve', v_arm->>'key' using errcode = '22023';
    end if;
    if p_kind = 'manual' and length(coalesce(v_arm->>'instruction', '')) not between 1 and 120 then
      raise exception 'arm %: instruction needed (1 to 120 characters)', v_arm->>'key' using errcode = '22023';
    end if;
    if v_arm ? 'tag' and (v_arm->>'tag') not in ('alcohol', 'late_caffeine', 'late_meal', 'late_exercise', 'heavy_duvet', 'door_ajar', 'sick', 'travel') then
      raise exception 'arm %: unknown tag', v_arm->>'key' using errcode = '22023';
    end if;
  end loop;
  if exists (select 1 from public.experiments e where e.kind = p_kind and e.status = 'running') then
    raise exception 'another % experiment is running: finish it first', case when p_kind = 'auto' then 'aircon' else 'household' end
      using errcode = '23505';
  end if;
  v_slug := left(trim(both '-' from regexp_replace(lower(coalesce(nullif(p_slug, ''), p_title)), '[^a-z0-9]+', '-', 'g')), 80);
  if v_slug = '' then
    v_slug := 'experiment';
  end if;
  if exists (select 1 from public.experiments e where e.slug = v_slug) then
    v_slug := v_slug || '-' || to_char(now() at time zone 'Asia/Bangkok', 'YYYYMMDD-HH24MI');
  end if;
  insert into public.experiments (slug, title, kind, arms, primary_outcome, started_on, seed, notes, created_by)
  values (v_slug, trim(p_title), p_kind, p_arms, coalesce(p_primary, 'sleep_score'), v_start,
          floor(random() * 2147483647)::integer, nullif(trim(coalesce(p_notes, '')), ''), (select auth.uid()))
  returning * into v_row;
  perform private.experiment_log_add(v_row.id, 'created', format('Started "%s" from the night of %s', v_row.title, v_start),
    jsonb_build_object('arms', p_arms, 'primary', v_row.primary_outcome, 'by', (select auth.uid())));
  if p_pin_tonight is not null then
    perform private.pin_experiment_arm(v_row.id, private.next_night_date(), p_pin_tonight);
  end if;
  return v_row;
end $$;

-- Pin a night's arm by hand (also replaces a random assignment); applied to the night at once when its row exists.
create or replace function private.pin_experiment_arm(p_experiment bigint, p_night date, p_arm text)
returns public.experiment_nights
language plpgsql security definer set search_path = '' as $$
declare
  v_exp public.experiments;
  v_row public.experiment_nights;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  select * into v_exp from public.experiments e where e.id = p_experiment;
  if v_exp.id is null or v_exp.status <> 'running' then
    raise exception 'no running experiment %', p_experiment using errcode = '22023';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_exp.arms) a where a->>'key' = p_arm) then
    raise exception 'unknown arm %', p_arm using errcode = '22023';
  end if;
  if p_night is null or p_night < v_exp.started_on or p_night < private.next_night_date() - 7 or p_night > private.next_night_date() + 7 then
    raise exception 'night % is outside the experiment or ±7 days', p_night using errcode = '22023';
  end if;
  insert into public.experiment_nights (experiment_id, night_date, arm_key, source, followed, marked_by)
  values (p_experiment, p_night, p_arm, 'pinned', true, (select auth.uid()))
  on conflict (experiment_id, night_date) do update set
    arm_key = excluded.arm_key, source = 'pinned', followed = true, applied_at = null, apply_note = null,
    marked_by = excluded.marked_by, updated_at = now()
  returning * into v_row;
  perform private.experiment_log_add(p_experiment, 'pinned', format('%s pinned to %s', p_night,
    (select a->>'label' from jsonb_array_elements(v_exp.arms) a where a->>'key' = p_arm)),
    jsonb_build_object('night', p_night, 'arm', p_arm, 'by', (select auth.uid())));
  perform private.experiment_apply_night(p_experiment, p_night);
  select * into v_row from public.experiment_nights x where x.experiment_id = p_experiment and x.night_date = p_night;
  return v_row;
end $$;

-- "Didn't follow" (p_followed = false) / undo (true). An aircon night that has started can only count when the
-- night really ran its arm's curve.
create or replace function private.mark_experiment_night(p_experiment bigint, p_night date, p_followed boolean)
returns public.experiment_nights
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.experiment_nights;
  v_exp public.experiments;
  v_curve text;
  v_ran text;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_followed is null then
    raise exception 'p_followed must be true or false' using errcode = '22023';
  end if;
  if p_followed then
    select * into v_exp from public.experiments e where e.id = p_experiment;
    if v_exp.kind = 'auto' and p_night <= (now() at time zone 'Asia/Bangkok')::date then
      select a->>'curve_id' into v_curve
      from public.experiment_nights x
      cross join lateral jsonb_array_elements(v_exp.arms) a
      where x.experiment_id = p_experiment and x.night_date = p_night and a->>'key' = x.arm_key;
      select n.curve_id into v_ran from public.nights n where n.date = p_night;
      if v_curve is distinct from v_ran then
        raise exception 'that night ran %, not the arm''s curve %: it can''t count', coalesce(v_ran, 'no curve'), coalesce(v_curve, '?')
          using errcode = '22023';
      end if;
    end if;
  end if;
  update public.experiment_nights x set followed = p_followed, marked_by = (select auth.uid()), updated_at = now()
  where x.experiment_id = p_experiment and x.night_date = p_night
  returning * into v_row;
  if v_row.experiment_id is null then
    raise exception 'no experiment night % / %', p_experiment, p_night using errcode = '22023';
  end if;
  perform private.experiment_log_add(p_experiment, 'marked',
    format('%s marked %s', p_night, case when p_followed then 'followed' else 'didn''t follow' end),
    jsonb_build_object('night', p_night, 'followed', p_followed, 'by', (select auth.uid())));
  return v_row;
end $$;

-- Finish; p_adopt = true makes the winning arm's curve the default (auto only). p_arm overrides the computed winner.
create or replace function private.finish_experiment(p_experiment bigint, p_adopt boolean default false, p_arm text default null)
returns public.experiments
language plpgsql security definer set search_path = '' as $$
declare
  v_exp public.experiments;
  v_arm text;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  select * into v_exp from public.experiments e where e.id = p_experiment;
  if v_exp.id is null then
    raise exception 'no experiment %', p_experiment using errcode = '22023';
  end if;
  if coalesce(p_adopt, false) then
    v_arm := coalesce(p_arm, v_exp.analysis->>'winner');
    if v_arm is null then
      raise exception 'no winner to adopt yet' using errcode = '22023';
    end if;
  end if;
  return private.experiment_finish_core(p_experiment, 'finished', v_arm, (select auth.uid()), 'by hand');
end $$;

create or replace function private.set_autopilot(p_on boolean) returns public.household_settings
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.household_settings;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'p_on must be true or false' using errcode = '22023';
  end if;
  insert into public.household_settings (id) values (1) on conflict (id) do nothing;
  update public.household_settings s set autopilot = p_on, updated_at = now(), updated_by = (select auth.uid())
  where s.id = 1
  returning * into v_row;
  perform private.experiment_log_add(null, 'autopilot', case when p_on then 'Autopilot switched on' else 'Autopilot switched off' end,
    jsonb_build_object('on', p_on, 'by', (select auth.uid())));
  return v_row;
end $$;

-- Undo the last adoption: the default curve goes back to the one before it (from the newest 'adopted' log entry).
-- One step only: after an undo there is nothing more to undo until the next adoption.
create or replace function private.undo_adoption() returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_prev text;
  v_cur text;
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  -- The newest adoption, unless an undo came after it (an undo writes its own 'adopted' row first, then 'undo').
  select case when l.kind = 'adopted' then l.data->>'previous' end, l.data->>'curve_id' into v_prev, v_cur
  from public.experiment_log l where l.kind in ('adopted', 'undo') order by l.at desc, l.id desc limit 1;
  if v_prev is null then
    raise exception 'nothing to undo' using errcode = '22023';
  end if;
  if not exists (select 1 from public.curves c where c.id = v_cur and c.is_default) then
    raise exception 'the default curve changed since: nothing to undo' using errcode = '22023';
  end if;
  perform private.adopt_default_curve(v_prev);
  perform private.experiment_log_add(null, 'undo', format('Undo: default aircon curve back to %s', v_prev),
    jsonb_build_object('curve_id', v_prev, 'from', v_cur, 'by', (select auth.uid())));
  return v_prev;
end $$;
revoke all on function private.undo_adoption() from public, anon;
grant execute on function private.undo_adoption() to authenticated;

create or replace function public.undo_adoption() returns text
language sql security invoker set search_path = '' as $$
  select private.undo_adoption()
$$;
revoke all on function public.undo_adoption() from public, anon;
grant execute on function public.undo_adoption() to authenticated;

revoke all on function private.create_experiment(text, text, jsonb, text, text, text, date, text) from public, anon;
revoke all on function private.pin_experiment_arm(bigint, date, text) from public, anon;
revoke all on function private.mark_experiment_night(bigint, date, boolean) from public, anon;
revoke all on function private.finish_experiment(bigint, boolean, text) from public, anon;
revoke all on function private.set_autopilot(boolean) from public, anon;
grant execute on function private.create_experiment(text, text, jsonb, text, text, text, date, text) to authenticated;
grant execute on function private.pin_experiment_arm(bigint, date, text) to authenticated;
grant execute on function private.mark_experiment_night(bigint, date, boolean) to authenticated;
grant execute on function private.finish_experiment(bigint, boolean, text) to authenticated;
grant execute on function private.set_autopilot(boolean) to authenticated;

create or replace function public.create_experiment(
  p_title text,
  p_kind text,
  p_arms jsonb,
  p_primary text default 'sleep_score',
  p_slug text default null,
  p_notes text default null,
  p_started_on date default null,
  p_pin_tonight text default null
) returns public.experiments
language sql security invoker set search_path = '' as $$
  select * from private.create_experiment(p_title, p_kind, p_arms, p_primary, p_slug, p_notes, p_started_on, p_pin_tonight)
$$;

create or replace function public.pin_experiment_arm(p_experiment bigint, p_night date, p_arm text)
returns public.experiment_nights
language sql security invoker set search_path = '' as $$
  select * from private.pin_experiment_arm(p_experiment, p_night, p_arm)
$$;

create or replace function public.mark_experiment_night(p_experiment bigint, p_night date, p_followed boolean)
returns public.experiment_nights
language sql security invoker set search_path = '' as $$
  select * from private.mark_experiment_night(p_experiment, p_night, p_followed)
$$;

create or replace function public.finish_experiment(p_experiment bigint, p_adopt boolean default false, p_arm text default null)
returns public.experiments
language sql security invoker set search_path = '' as $$
  select * from private.finish_experiment(p_experiment, p_adopt, p_arm)
$$;

create or replace function public.set_autopilot(p_on boolean) returns public.household_settings
language sql security invoker set search_path = '' as $$
  select * from private.set_autopilot(p_on)
$$;

revoke all on function public.create_experiment(text, text, jsonb, text, text, text, date, text) from public, anon;
revoke all on function public.pin_experiment_arm(bigint, date, text) from public, anon;
revoke all on function public.mark_experiment_night(bigint, date, boolean) from public, anon;
revoke all on function public.finish_experiment(bigint, boolean, text) from public, anon;
revoke all on function public.set_autopilot(boolean) from public, anon;
grant execute on function public.create_experiment(text, text, jsonb, text, text, text, date, text) to authenticated;
grant execute on function public.pin_experiment_arm(bigint, date, text) to authenticated;
grant execute on function public.mark_experiment_night(bigint, date, boolean) to authenticated;
grant execute on function public.finish_experiment(bigint, boolean, text) to authenticated;
grant execute on function public.set_autopilot(boolean) to authenticated;

-- ---------------------------------------------------------------- 4c. service role only (the experiments function)

create or replace function public.experiment_apply_night(p_experiment bigint, p_night date) returns text
language sql security invoker set search_path = '' as $$
  select private.experiment_apply_night(p_experiment, p_night)
$$;

create or replace function public.experiment_finish(p_experiment bigint, p_status text, p_adopt_arm text default null, p_reason text default null)
returns public.experiments
language sql security invoker set search_path = '' as $$
  select * from private.experiment_finish_core(p_experiment, p_status, p_adopt_arm, null, p_reason)
$$;

create or replace function public.adopt_default_curve(p_curve_id text) returns text
language sql security invoker set search_path = '' as $$
  select private.adopt_default_curve(p_curve_id)
$$;

revoke all on function public.experiment_apply_night(bigint, date) from public, anon, authenticated;
revoke all on function public.experiment_finish(bigint, text, text, text) from public, anon, authenticated;
revoke all on function public.adopt_default_curve(text) from public, anon, authenticated;
grant execute on function private.experiment_apply_night(bigint, date) to service_role;
grant execute on function private.experiment_finish_core(bigint, text, text, uuid, text) to service_role;
grant execute on function private.adopt_default_curve(text) to service_role;
grant execute on function public.experiment_apply_night(bigint, date) to service_role;
grant execute on function public.experiment_finish(bigint, text, text, text) to service_role;
grant execute on function public.adopt_default_curve(text) to service_role;

-- ---------------------------------------------------------------- 5. tonight: door open a crack

insert into public.experiments (slug, title, kind, arms, primary_outcome, started_on, seed, notes)
select
  'door-open-vs-closed',
  'Door: open a crack vs closed',
  'manual',
  '[{"key":"closed","label":"Door closed","instruction":"Door CLOSED"},
    {"key":"open","label":"Door open a crack","instruction":"Door OPEN a crack","tag":"door_ajar"}]'::jsonb,
  'sleep_score',
  date '2026-11-05',
  20261105,
  'Started with migration 0025: on the evening of 2026-11-04 the bedroom door is left open a crack.'
where not exists (select 1 from public.experiments e where e.kind = 'manual')
on conflict (slug) do nothing;

insert into public.experiment_nights (experiment_id, night_date, arm_key, source)
select e.id, date '2026-11-05', 'open', 'pinned'
from public.experiments e
where e.slug = 'door-open-vs-closed' and e.status = 'running'
on conflict (experiment_id, night_date) do nothing;

select private.experiment_apply_night(e.id, date '2026-11-05')
from public.experiments e
where e.slug = 'door-open-vs-closed' and e.status = 'running'
  and exists (select 1 from public.nights n where n.date = date '2026-11-05');

-- ---------------------------------------------------------------- 6. pg_cron

-- Every 15 min (cron.schedule replaces the job of the same name): tonight's assignment from 12:00 ICT, the 20:30
-- push for household experiments, outcomes + verdict from 10:00 ICT, Autopilot.
select cron.schedule('sleeplab-experiments', '*/15 * * * *',
  $$select private.invoke_edge_function('experiments', '{}', 60000)$$);
