-- Bird ID (2026-11-11): which bird made a night sound.
--
-- The Mac runs BirdNET (Cornell's bird-call model, birdnetlib) on the night's clips, with Phuket's location and the
-- week of the year so only local species are considered. It gets the clips to check from the bird-id Edge Function
-- (GET: recent events with a clip and no bird check yet, with signed URLs) and posts back one result per event
-- (POST: species, common name, confidence; or none). The app shows the bird's name and a photo (iNaturalist) under
-- the clip. docs/mac-prompts/bird-id.md is the Mac's side.
--
--   sound_events.bird_species     scientific name, e.g. 'Eudynamys scolopaceus'; null = no bird found / not checked
--   sound_events.bird_common      English name, e.g. 'Asian Koel'
--   sound_events.bird_conf        BirdNET confidence 0..1
--   sound_events.bird_checked_at  when the Mac checked the clip (set with or without a bird)
-- Idempotent; no destructive statements.

alter table public.sound_events add column if not exists bird_species text;
alter table public.sound_events add column if not exists bird_common text;
alter table public.sound_events add column if not exists bird_conf real;
alter table public.sound_events add column if not exists bird_checked_at timestamptz;
comment on column public.sound_events.bird_species is 'BirdNET: scientific name of the bird heard in the clip (bird-id function); null = none found or not checked.';
comment on column public.sound_events.bird_common is 'BirdNET: English common name of that bird.';
comment on column public.sound_events.bird_conf is 'BirdNET confidence 0..1 for bird_species.';
comment on column public.sound_events.bird_checked_at is 'When the Mac ran BirdNET on this clip (set whether or not a bird was found).';
create index if not exists sound_events_bird_unchecked on public.sound_events (ts desc) where bird_checked_at is null and clip_path is not null;
