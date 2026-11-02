-- Sign-in allow-list (2026-11-01): Sleep Lab is private to the household's two people.
--
-- private.allowed_emails holds the only addresses that may own an account. A trigger on auth.users refuses any other
-- new user and any change of email to an address not on the list, whichever way the account is made (Google sign-in,
-- email code, admin invite). GoTrue reports the refusal as "Database error saving new user"; the app's sign-in page
-- turns that into "That account can't sign in".
--
-- The addresses themselves are NOT in this file (the repo is public). Add them once with the service role / SQL editor:
--   insert into private.allowed_emails (email) values ('person-a@example.com'), ('person-b@example.com');
-- Existing accounts keep working; RLS (household membership) still decides what any account can read.
--
-- Written without destructive statements (the Supabase MCP asks an interactive confirmation for those).

create table if not exists private.allowed_emails (
  email text primary key check (email = lower(email)),
  note text,
  created_at timestamptz not null default now()
);
comment on table private.allowed_emails is 'The only addresses that may own a Sleep Lab account (trigger enforce_allowed_email on auth.users). Lower case.';
revoke all on private.allowed_emails from public, anon, authenticated;
grant all on private.allowed_emails to service_role;

create or replace function private.enforce_allowed_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is null or not exists (select 1 from private.allowed_emails a where a.email = lower(new.email)) then
    raise exception 'not on the Sleep Lab allow-list' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function private.enforce_allowed_email() from public, anon, authenticated;

drop trigger if exists enforce_allowed_email on auth.users;
create trigger enforce_allowed_email
  before insert or update of email on auth.users
  for each row execute function private.enforce_allowed_email();
