-- Presence of the people not in household_settings.presence_people follows those who are (2026-11-08).
--
-- Cath and Erik are always together and only Erik's phone reports (0031: presence_people = {b}). public.presence_latest
-- now gives every household person a row: people in presence_people (or everyone, when it is NULL/empty) keep their own
-- latest event; the others take the newest event of the presence_people. So "everyone away" and the app's Presence
-- card follow Erik's phone for both of them, with no Edge Function redeploy needed (functions also filter by
-- presence_people in _shared/presence.ts loadPresence once redeployed; both agree).
-- Same columns, order and options (security_invoker) as before.
create or replace view public.presence_latest with (security_invoker = true) as
with own as (
  select distinct on (e.person_id) e.person_id, e.state, e.at, e.source
  from public.presence_events e
  order by e.person_id, e.at desc
),
cfg as (
  select coalesce(cardinality(h.presence_people), 0) > 0 as limited, coalesce(h.presence_people, '{}') as ids
  from public.household_settings h
  where h.id = 1
)
select p.id as person_id, x.state, x.at, x.source
from public.people p
left join cfg on true
join lateral (
  select o.state, o.at, o.source
  from own o
  where case
    when coalesce(cfg.limited, false) and not (p.id = any (cfg.ids)) then o.person_id = any (cfg.ids)
    else o.person_id = p.id
  end
  order by o.at desc
  limit 1
) x on true;
