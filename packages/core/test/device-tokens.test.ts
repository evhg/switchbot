import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Migration 0028 (device tokens): static checks, the behaviour was exercised against Postgres 16 when written.
const read = (f: string) => readFileSync(new URL(`../../../supabase/migrations/${f}`, import.meta.url), 'utf8');
const sql = read('0028_device_tokens.sql');
const fn = (name: string) => {
  const m = new RegExp(`create or replace function ${name.replace('.', '\\.')}\\([\\s\\S]*?\\$\\$;`).exec(sql);
  expect(m, name).not.toBeNull();
  return m![0];
};

describe('migration 0028 device tokens', () => {
  it('has no destructive statement words, not even in comments', () => {
    expect(sql).not.toMatch(/drop|delete|truncate/i);
  });

  it('generates and hashes tokens exactly like presence tokens', () => {
    const gen = "'slp_' || encode(extensions.gen_random_bytes(32), 'hex')";
    expect(read('0010_presence_token_owner.sql')).toContain(gen);
    expect(fn('private.create_device_token')).toContain(gen);
    expect(fn('private.create_device_token')).toContain('private.presence_token_hash(v_token)');
    expect(sql).toMatch(/token_hash bytea not null unique/);
  });

  it('is idempotent', () => {
    expect(sql).toMatch(/create table if not exists private\.device_tokens/);
    expect(sql).toMatch(/if not exists \(\s*select 1 from pg_policies/);
    expect(sql.match(/^create (?!or replace|table if not exists|index if not exists|extension if not exists)/gim)).toBeNull();
  });

  it('keeps the signatures the Edge Functions call', () => {
    expect(sql).toContain('create or replace function public.presence_token_person(p_token text) returns text');
    expect(sql).toContain('create or replace function public.presence_token_person_kinds(p_token text, p_kinds text[]) returns text');
    expect(sql).toContain('grant execute on function public.presence_token_person_kinds(text, text[]) to service_role;');
    expect(sql).toContain("create or replace function public.record_presence(p_token text, p_state text, p_source text default 'shortcut')");
    expect(fn('public.record_presence')).toContain('returns table (person_id text, state text, at timestamptz)');
  });

  it('resolves only non-revoked device tokens, and record_presence only phone/device kinds', () => {
    const kinds = fn('private.presence_token_person_kinds');
    expect(kinds).toMatch(/volatile/);
    expect(kinds.match(/d\.revoked_at is null/g)?.length).toBe(2);
    expect(kinds.match(/p_kinds is null or d\.kind = any \(p_kinds\)/g)?.length).toBe(2);
    expect(kinds).toMatch(/interval '60 seconds'/);
    const person = fn('private.presence_token_person');
    expect(person).toMatch(/volatile/);
    expect(person).toContain('private.presence_token_person_kinds(p_token, null)');
    const rec = fn('public.record_presence');
    expect(rec).toMatch(/d\.revoked_at is null/);
    expect(rec).toMatch(/d\.kind in \('phone', 'device'\)/);
  });

  it('never returns hashes and keeps the table closed to clients', () => {
    expect(fn('private.list_device_tokens')).not.toMatch(/token_hash/);
    expect(sql).toMatch(/revoke all on private\.device_tokens from public, anon, authenticated/);
    expect(sql).toMatch(/using \(false\) with check \(false\)/);
    for (const f of ['create_device_token(text, text, text)', 'revoke_device_token(bigint)', 'list_device_tokens()']) {
      expect(sql).toContain(`revoke all on function public.${f} from public, anon;`);
      expect(sql).toContain(`grant execute on function public.${f} to authenticated;`);
    }
  });

  it('applies the 0010 rule: own person or household owner', () => {
    expect(fn('private.may_manage_person_tokens')).toMatch(/m\.role = 'owner' or m\.person_id = p_person_id/);
    expect(fn('private.create_device_token')).toContain('private.may_manage_person_tokens(p_person_id)');
    expect(fn('private.revoke_device_token')).toContain('private.may_manage_person_tokens(v_person)');
  });
});
