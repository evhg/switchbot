-- Sleep talk: clips and transcripts of talking in our sleep (2026-11-05, asked by Cath; both household members agreed
-- to the bedroom recording).
--
-- Until now speech was never clipped. With "Save sleep talk" on (household_settings.sound_sleeptalk, default true) the
-- night-sound Edge Function also hands out upload URLs for speech events (the whole speech run, up to 30 s, at most 20
-- a night on top of the 40 other clips) and stores the transcript the Mac made locally (mlx-whisper; the audio itself
-- only goes to the signed upload URL). The next morning nightly-report judges every speech event with a clip or transcript against
-- both people's sleep stages (core judgeSleepTalk):
--   sleep_talk = true   at least one person was in a non-awake stage at that moment (talker_hint = the only one asleep)
--   sleep_talk = false  both were awake or outside their sleep sessions: a conversation. transcript / transcript_lang
--                       are cleared at once; the clip object is removed from Storage and clip_path cleared once the row
--                       is 2 h 30 min old (no signed upload can land after that): conversations are not kept.
--   sleep_talk = null   not judged yet (waits for both people's sleep sync, or 13:00 ICT with whatever exists).
-- The morning push then carries a "Sleep talk: …" line (or a separate "Sleep talk from last night" push once a night
-- when the report went out before the judging; dedupe in alert_state key 'sleeptalk').
--
-- 1. sound_events: transcript (≤ 2000 chars), transcript_lang, sleep_talk, talker_hint ('a' | 'b'), judged_at.
-- 2. household_settings.sound_sleeptalk + set_sound_sleeptalk(p_on), the definer-in-private + invoker-wrapper pattern
--    of 0020/0023/0024.
-- Grants are unchanged: members read sound_events (and update only hidden); the function (service role) writes.
-- Idempotent (if not exists / create or replace / guarded constraints). Written without destructive statements.

-- ---------------------------------------------------------------- 1. sound_events columns

alter table public.sound_events add column if not exists transcript text;
alter table public.sound_events add column if not exists transcript_lang text;
alter table public.sound_events add column if not exists sleep_talk boolean;
alter table public.sound_events add column if not exists talker_hint text;
alter table public.sound_events add column if not exists judged_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sound_events_transcript_len' and conrelid = 'public.sound_events'::regclass) then
    alter table public.sound_events add constraint sound_events_transcript_len
      check (transcript is null or char_length(transcript) between 1 and 2000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sound_events_transcript_lang_len' and conrelid = 'public.sound_events'::regclass) then
    alter table public.sound_events add constraint sound_events_transcript_lang_len
      check (transcript_lang is null or char_length(transcript_lang) between 1 and 10);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sound_events_talker_hint' and conrelid = 'public.sound_events'::regclass) then
    alter table public.sound_events add constraint sound_events_talker_hint
      check (talker_hint is null or talker_hint in ('a', 'b'));
  end if;
end $$;

comment on column public.sound_events.transcript is
  'What was said, transcribed on the Mac (mlx-whisper) for speech events while "Save sleep talk" is on; ≤ 2000 chars. '
  'Cleared the next morning when the judge finds both were awake (a conversation).';
comment on column public.sound_events.transcript_lang is 'Language the transcriber detected (en, nl, th, …).';
comment on column public.sound_events.sleep_talk is
  'Speech events only. null = not judged yet; true = at least one person was asleep at that moment (sleep talk, kept); '
  'false = both awake or outside their sleep sessions (a conversation: transcript cleared at once, clip removed once no upload can land, about 2.5 h after the event).';
comment on column public.sound_events.talker_hint is
  'a (Cath) or b (Erik) when exactly that person was asleep at the moment: probably the one talking. null otherwise.';
comment on column public.sound_events.judged_at is 'When the morning judge (nightly-report) set sleep_talk.';

create index if not exists sound_events_speech_unjudged on public.sound_events (night_date)
  where kind = 'speech' and sleep_talk is null;

-- ---------------------------------------------------------------- 2. household settings

alter table public.household_settings add column if not exists sound_sleeptalk boolean not null default true;
comment on column public.household_settings.sound_sleeptalk is
  'true = night-sound also keeps clips of talking (≤ 30 s, ≤ 20 a night) and the Mac''s transcripts; the next morning '
  'clips where both were awake are removed. false = speech is never clipped and transcripts are not kept. '
  'Set with set_sound_sleeptalk().';

create or replace function private.set_sound_sleeptalk(p_on boolean) returns public.household_settings
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
  update public.household_settings s set
    sound_sleeptalk = p_on,
    updated_at = now(),
    updated_by = (select auth.uid())
  where s.id = 1
  returning * into v_row;
  return v_row;
end $$;
revoke all on function private.set_sound_sleeptalk(boolean) from public, anon;
grant execute on function private.set_sound_sleeptalk(boolean) to authenticated;

create or replace function public.set_sound_sleeptalk(p_on boolean) returns public.household_settings
language sql security invoker set search_path = '' as $$
  select * from private.set_sound_sleeptalk(p_on)
$$;
revoke all on function public.set_sound_sleeptalk(boolean) from public, anon;
grant execute on function public.set_sound_sleeptalk(boolean) to authenticated;
