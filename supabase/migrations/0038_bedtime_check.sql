-- Bedtime check (2026-11-13): one push 10 minutes before lights-out, only when something needs doing.
--
--   · a Fitbit under 30 %                       "Charge Cath's Fitbit (22 %) before bed, or tonight's sleep may be lost."
--   · the room's CO₂ already ≥ 900 ppm          "CO₂ 940 ppm already: open the door a crack tonight."
--   · the night listener not sending            "The night listener isn't running (no sound for 8 min): check Erik's Mac."
--   · the camera unreachable for the listener   (same line: the listener has nothing to send)
-- Nothing is sent when all is well, while away (active away period or "away" tonight), or twice for the same night.
-- Lights-out comes from tonight's nights row (date = tomorrow, ICT), else 22:00 ICT.
--   private.bedtime_check(p_now)   → the lines (null = all well); no side effects
--   private.send_bedtime_check()   cron every 5 min 20:00–23:55 ICT; sends once per night when now ≥ lights-out − 10 min
-- Idempotent; no destructive statements.

create or replace function private.bedtime_check(p_now timestamptz default now())
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_lines text[] := '{}';
  v_bands text;
  v_co2 int;
  v_last timestamptz;
begin
  select string_agg('Charge ' || p.name || '’s Fitbit (' || (b.devices->0->>'batteryLevel') || ' %) before bed', ' · ' order by p.id)
    into v_bands
  from public.band_sync b join public.people p on p.id = b.person_id
  where (b.devices->0->>'batteryLevel') ~ '^\d+$' and (b.devices->0->>'batteryLevel')::int < 30;
  if v_bands is not null then v_lines := v_lines || (v_bands || ', or tonight’s sleep may be lost.'); end if;

  select r.co2 into v_co2 from public.readings r
  where r.co2 is not null and r.ts > p_now - interval '15 minutes'
  order by r.ts desc limit 1;
  if v_co2 >= 900 then
    v_lines := v_lines || ('CO₂ ' || to_char(v_co2, 'FM9,999') || ' ppm already: open the door a crack tonight.');
  end if;

  select max(m.ts) into v_last from public.sound_minutes m where m.ts > p_now - interval '1 day';
  if not exists (select 1 from public.household_settings s where s.id = 1 and (s.sound_mode = 'off' or s.sound_paused_until > p_now))
     and (v_last is null or v_last < p_now - interval '6 minutes') then
    v_lines := v_lines || ('The night listener isn’t running'
      || coalesce(' (no sound for ' || round(extract(epoch from p_now - v_last) / 60) || ' min)', '')
      || ': check Erik’s Mac and the camera.');
  end if;

  return nullif(array_to_string(v_lines, E'\n'), '');
end $$;
revoke all on function private.bedtime_check(timestamptz) from public, anon, authenticated;

create or replace function private.send_bedtime_check()
returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_tonight date := ((now() at time zone 'Asia/Bangkok') - interval '12 hours')::date + 1; -- the wake date of tonight
  v_lo timestamptz;
  v_body text;
begin
  select n.lights_out into v_lo from public.nights n where n.date = v_tonight;
  v_lo := coalesce(v_lo, ((v_tonight - 1) + time '22:00') at time zone 'Asia/Bangkok');
  if now() < v_lo - interval '10 minutes' or now() > v_lo + interval '30 minutes' then return null; end if;
  if exists (select 1 from public.jarvis_notices j where j.kind = 'bedtime:' || v_tonight) then return null; end if;
  if exists (select 1 from public.away_periods a where a.active and v_tonight - 1 between a.from_date and a.to_date) then return null; end if;
  if exists (select 1 from public.nights n where n.date = v_tonight and n.presence_override = 'away') then return null; end if;
  v_body := private.bedtime_check(now());
  if v_body is null then
    insert into public.jarvis_notices (kind, title, body) values ('bedtime:' || v_tonight, 'Bedtime check', 'all well (not sent)');
    return null;
  end if;
  return private.jarvis_push('bedtime:' || v_tonight, 'Before bed', v_body);
end $$;
revoke all on function private.send_bedtime_check() from public, anon, authenticated;

-- 13:00–16:55 UTC = 20:00–23:55 ICT.
select cron.schedule('jarvis-bedtime-check', '*/5 13-16 * * *', $$select private.send_bedtime_check()$$);
