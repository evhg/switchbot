-- Whose phone decides home / away (2026-11-08).
--
-- Cath and Erik are always together, and only Erik's phone runs OwnTracks. household_settings.presence_people limits
-- the people whose presence signals count for the pre-cool gate and the night listener (_shared/presence.ts
-- loadPresence): when set, only those people's latest signals are read and "everyone away" means everyone in this
-- list. NULL (the default) keeps every household person. Set to {b}: Erik's phone stands in for both.
alter table public.household_settings add column if not exists presence_people text[];
comment on column public.household_settings.presence_people is
  'Person ids whose presence signals decide home/away (pre-cool gate, night listener). NULL = everyone in public.people.';
update public.household_settings set presence_people = '{b}' where id = 1 and presence_people is null;
