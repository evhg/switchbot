'use client';
/**
 * Face ID / passkeys for the signed-in account (lib/passkey.ts): the list of this account's passkeys and "Add Face ID".
 * Used on /signin (right after a sign-in) and in System › General › Account.
 */
import { useCallback, useEffect, useState } from 'react';
import { addPasskey, listPasskeys, passkeysSupported, type PasskeyRow } from '@/lib/passkey.ts';
import { Button, Group, Row, Status } from '../ui.tsx';
import s from './account.module.css';

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

export function Passkeys({ compact = false }: { compact?: boolean }) {
  const [rows, setRows] = useState<PasskeyRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  const load = useCallback(() => {
    listPasskeys()
      .then(setRows)
      .catch(() => setRows([]));
  }, []);
  useEffect(() => {
    setSupported(passkeysSupported());
    load();
  }, [load]);

  const add = async () => {
    setBusy(true);
    setMsg(null);
    const e = await addPasskey();
    setBusy(false);
    if (e === 'cancelled') return;
    setMsg(e ?? 'Face ID is set. Next time, tap “Sign in with Face ID”: no Google, no email, in any tab or the home-screen app.');
    load();
  };

  if (!supported) return <p className={s.note}>This browser can’t use passkeys. Safari on iPhone and Mac can.</p>;

  return (
    <>
      {!compact && rows && rows.length > 0 && (
        <Group>
          {rows.map((r) => (
            <Row key={r.id} title={r.device ?? 'Passkey'} sub={`Added ${day(r.created_at)}${r.last_used_at ? ` · last used ${day(r.last_used_at)}` : ''}`} value={<Status tone="on">On</Status>} />
          ))}
        </Group>
      )}
      <div className={s.actions} style={{ marginTop: compact ? 0 : 'var(--sp-4)' }}>
        <Button variant={rows && rows.length > 0 ? 'text' : compact ? 'secondary' : 'primary'} disabled={busy} onClick={() => void add()}>
          {busy ? 'Waiting for Face ID…' : rows && rows.length > 0 ? 'Add Face ID on another device' : 'Set up Face ID sign-in'}
        </Button>
      </div>
      {msg && (
        <p className={s.note} role="status">
          {msg}
        </p>
      )}
    </>
  );
}
