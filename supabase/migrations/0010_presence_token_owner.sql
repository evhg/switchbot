-- Presence tokens: only the person themselves (the household member linked to them) or the household owner may create
-- or rotate a person's token. Before this any owner/member could mint another person's token, post presence as them
-- and silently break their Shortcut (review 2026-10-29). Same signature, so public.rotate_presence_token() and its
-- grants are unchanged.
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

create or replace function private.rotate_presence_token(p_person_id text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_token text := 'slp_' || encode(extensions.gen_random_bytes(32), 'hex');
begin
  if not private.is_household_writer() then
    raise exception 'not allowed: owner or member role required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.people p where p.id = p_person_id) then
    raise exception 'unknown person %', p_person_id using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.household_members m
    where m.user_id = (select auth.uid()) and (m.role = 'owner' or m.person_id = p_person_id)
  ) then
    raise exception 'not allowed: only the own person or the household owner can change this token' using errcode = '42501';
  end if;
  insert into private.presence_tokens (person_id, token_hash, created_at, created_by, last_used_at)
  values (p_person_id, private.presence_token_hash(v_token), now(), (select auth.uid()), null)
  on conflict (person_id) do update set
    token_hash = excluded.token_hash, created_at = excluded.created_at, created_by = excluded.created_by, last_used_at = null;
  return v_token;
end $$;
revoke all on function private.rotate_presence_token(text) from public, anon;
grant execute on function private.rotate_presence_token(text) to authenticated;
