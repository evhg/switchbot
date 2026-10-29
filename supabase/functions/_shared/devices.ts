// Device ids come from METER_DEVICE_ID / AC_DEVICE_ID when set, otherwise from the devices table, which
// discoverDevices() fills from the SwitchBot device list (so the user never has to look ids up).
import type { SwitchBotDevice, SwitchBotIrRemote } from '../../../packages/core/src/switchbot/client.ts';
import { optEnv } from './env.ts';
import type { QuotaSession } from './switchbot.ts';
import type { Db } from './supabase.ts';

type Kind = 'meter' | 'ac';
const ENV: Record<Kind, string> = { meter: 'METER_DEVICE_ID', ac: 'AC_DEVICE_ID' };
const AC_NAME = /bedroom/i;

export async function knownDeviceId(db: Db, kind: Kind): Promise<string | null> {
  const fromEnv = optEnv(ENV[kind]);
  if (fromEnv) return fromEnv;
  const { data } = await db.from('devices').select('device_id').eq('kind', kind)
    .eq('meta->>discovered', 'true').order('created_at').limit(1).maybeSingle();
  return (data as { device_id?: string } | null)?.device_id ?? null;
}

export interface Discovery {
  meter: string | null;
  ac: string | null;
  devices: { id: string; name: string; type: string }[];
  remotes: { id: string; name: string; type: string }[];
}

/** One SwitchBot list call; upserts the meter, hub, camera and the bedroom aircon remote. */
export async function discoverDevices(db: Db, sb: QuotaSession): Promise<Discovery> {
  const { deviceList = [], infraredRemoteList = [] } = await sb.client.listDevices();
  const meter = deviceList.find((d: SwitchBotDevice) => d.deviceType === 'MeterPro(CO2)') ?? null;
  const acs = infraredRemoteList.filter((r: SwitchBotIrRemote) => r.remoteType === 'Air Conditioner');
  const ac = acs.find((r) => AC_NAME.test(r.deviceName)) ?? acs[0] ?? null;

  const kindOf = (d: SwitchBotDevice) =>
    d === meter ? 'meter' : /hub/i.test(d.deviceType) ? 'hub' : /cam/i.test(d.deviceType) ? 'camera' : 'other';
  const rows = [
    ...deviceList.map((d) => ({
      device_id: d.deviceId, kind: kindOf(d), name: d.deviceName,
      meta: { discovered: true, deviceType: d.deviceType, hubDeviceId: d.hubDeviceId ?? null },
    })),
    ...(ac ? [{
      device_id: ac.deviceId, kind: 'ac', name: ac.deviceName,
      meta: { discovered: true, remoteType: ac.remoteType, hubDeviceId: ac.hubDeviceId ?? null },
    }] : []),
  ];
  if (rows.length) {
    const { error } = await db.from('devices').upsert(rows, { onConflict: 'device_id' });
    if (error) throw new Error(`devices: ${error.message}`);
  }
  return {
    meter: meter?.deviceId ?? null,
    ac: ac?.deviceId ?? null,
    devices: deviceList.map((d) => ({ id: d.deviceId, name: d.deviceName, type: d.deviceType })),
    remotes: infraredRemoteList.map((r) => ({ id: r.deviceId, name: r.deviceName, type: r.remoteType })),
  };
}
