import type { AcCommand, AcState, FanSpeed, Ms, OutdoorReading, RoomReading, TemperatureCurve } from '../types.ts';
import { decideAcCommand, evaluateLanding } from '../control/controller.ts';
import type { RemoteProfile } from '../control/remote.ts';
import { DAY_MIN, nightRng, type NightPlan } from './plan.ts';
import { MIN } from './time.ts';

/** Saturation vapour density, g/m³ (Magnus). */
export const satGm3 = (t: number) => (6.112 * Math.exp((17.67 * t) / (t + 243.5)) * 216.74) / (273.15 + t);

// Two-node thermal model (air + furnishings/walls), sized for ~120 m³.
const CA_PER_M3 = 12_500; // J/K per m³ of room: air plus fast-coupled furnishings
const CM_PER_M3 = 25_000; // slow mass
const UA_AIR_OUT = 35; // W/K glazing + envelope to air
const UA_AIR_MASS = 120;
const UA_MASS_OUT = 45;
const RHO_CP = 1210; // J/(m³·K)
const T_HOUSE = 28.5;
const AC_CAP: Record<FanSpeed, number> = { low: 2800, medium: 3600, high: 4600, auto: 3900 };
const AC_FLOW: Record<FanSpeed, number> = { low: 480, medium: 650, high: 850, auto: 700 };
const IR_MISS_P = 0.03;
// Hygroscopic buffer (bedding, wood, plaster): capacity as a multiple of the room air, exchange rate 1/h.
const BUF_CAP = 2;
const BUF_K = 0.6;

/** Physical state carried from one simulated day to the next (at 12:00 ICT). */
export interface RoomState {
  ta: number;
  tm: number;
  c: number;
  w: number;
  wb: number;
  tf: number;
  rhf: number;
  coil: number;
}

export interface RoomSim {
  readings: RoomReading[];
  /** True bed-height air temperature / RH / CO2 per minute (before sensor effects). */
  tempTrue: Float64Array;
  rhTrue: Float64Array;
  co2True: Float64Array;
  ac: AcCommand[];
  missed: AcCommand[];
  outdoor: OutdoorReading[];
  /** State at the end (12:00 on the wake date), the next night's starting point. */
  end: RoomState;
}

interface Drivers {
  gen: Float64Array; // CO2 L/s
  heat: Float64Array; // W
  moist: Float64Array; // g/min
  door: Float64Array; // extra exchange 1/h
}

function drivers(plan: NightPlan, seed: number): Drivers {
  const gen = new Float64Array(DAY_MIN);
  const heat = new Float64Array(DAY_MIN);
  const moist = new Float64Array(DAY_MIN);
  const door = new Float64Array(DAY_MIN);
  const srng = nightRng(seed, plan.date, 3);
  const inSpans = (spans: { start: number; end: number }[], m: number) => spans.some((s) => m >= s.start && m < s.end);
  for (const p of plan.persons) {
    if (!p.present) continue;
    const asleepFrom = p.bedIn + p.latency;
    for (const span of p.inRoom) {
      for (let m = Math.max(0, span.start); m < Math.min(DAY_MIN, span.end); m++) {
        const active = inSpans(p.active, m) || inSpans(p.trips, m);
        const asleep = !active && m >= asleepFrom && m < p.rise;
        const k = asleep ? 1 : active ? 1.8 : 1.3;
        gen[m]! += p.co2Lps * k;
        heat[m]! += asleep ? 60 : active ? 110 : 80;
        moist[m]! += (asleep ? 32 : active ? 70 : 45) / 60;
      }
    }
    for (const s of p.showers) {
      // Effective moisture reaching the bed-height meter (most condenses on bathroom surfaces / leaves via the fan gap).
      const grams = 580 + srng.next() * 380;
      const watts = 700 + srng.next() * 600;
      const dur = s.end - s.start;
      for (let m = s.start; m < s.end && m < DAY_MIN; m++) {
        moist[m]! += grams / dur;
        heat[m]! += watts;
      }
    }
  }
  for (const d of plan.doors) {
    for (let m = Math.max(0, d.start); m < Math.min(DAY_MIN, d.end); m++) door[m]! += d.ach;
  }
  return { gen, heat, moist, door };
}

export function outdoorAt(plan: NightPlan, noise: number[], m: number): { t: number; rh: number } {
  const hour = (12 + m / 60) % 24;
  const i = Math.floor(m / 60);
  const f = m / 60 - i;
  const n = (noise[i] ?? 0) * (1 - f) + (noise[i + 1] ?? 0) * f;
  const t = plan.outMean + plan.outAmp * Math.cos((2 * Math.PI * (hour - 14.5)) / 24) + n;
  const rh = Math.min(95, Math.max(62, 79 - 3.2 * (t - 29) + 2 * n));
  return { t, rh };
}

export function simulateRoom(
  plan: NightPlan,
  seed: number,
  curve: TemperatureCurve,
  remote: RemoteProfile,
  volume: number,
  init?: RoomState,
): RoomSim {
  const rng = nightRng(seed, plan.date, 4);
  const d = drivers(plan, seed);
  const noise = Array.from({ length: 26 }, () => rng.normal(0, 0.35));
  const ca = CA_PER_M3 * volume;
  const cm = CM_PER_M3 * volume;
  const infil = (RHO_CP * volume * plan.ach) / 3600;
  const kAch = 1 - Math.exp(-plan.ach / 60);

  // State at 12:00: the previous day's end state when given, else an empty sealed room, CO2 still decaying.
  const out0 = outdoorAt(plan, noise, 0);
  const coldTa = out0.t - 1.5 + rng.next() * 1.5;
  const coldC = plan.cOut + 60 + rng.next() * 200;
  const coldRh = 64 + rng.next() * 8;
  let ta = init?.ta ?? coldTa;
  let tm = init?.tm ?? ta + 0.3;
  let c = init?.c ?? coldC;
  let w = init?.w ?? (satGm3(ta) * coldRh) / 100;
  let wb = init?.wb ?? w;
  let tf = init?.tf ?? ta;
  let rhf = init?.rhf ?? (100 * w) / satGm3(ta);

  let ac: AcState = { power: false, setpointC: 24, mode: 'cool', fan: 'auto' };
  let compressor = false;
  let offFor = 99;
  let qDel = 0;
  let coil = init?.coil ?? 0;

  const t0 = plan.t0;
  const lightsOutMs = t0 + plan.lightsOut * MIN;
  const wakeMs = t0 + plan.wake * MIN;
  const ctrlFrom = plan.lightsOut + Math.min(0, curve.phases[0]?.startMin ?? 0) - 1;
  const ctrlTo = plan.wake + 30 + 180;

  const readings: RoomReading[] = new Array(DAY_MIN);
  const tempTrue = new Float64Array(DAY_MIN);
  const rhTrue = new Float64Array(DAY_MIN);
  const co2True = new Float64Array(DAY_MIN);
  const log: AcCommand[] = [];
  const missed: AcCommand[] = [];
  const kSensor = 1 - Math.exp(-1 / 4);
  const kRh = 1 - Math.exp(-1 / 3);
  const kQ = 1 - Math.exp(-1 / 4);

  for (let m = 0; m < DAY_MIN; m++) {
    const ts = t0 + m * MIN;
    const o = outdoorAt(plan, noise, m);
    const wOut = (satGm3(o.t) * o.rh) / 100;
    const hour = (12 + m / 60) % 24;
    const sun = hour > 7 && hour < 19 ? 300 * plan.cloud * Math.sin((Math.PI * (hour - 7)) / 12) : 0;
    const nightHouse = m >= plan.lightsOut && m < plan.wake;
    const cHouse = nightHouse ? plan.cOut + 40 : plan.cHouse;

    // Controller sees only meter readings, as in production.
    if (m >= ctrlFrom && m <= ctrlTo && m > 0) {
      const recent = readings.slice(Math.max(0, m - 60), m);
      const last = log[log.length - 1];
      const cmd = decideAcCommand({
        now: ts,
        lightsOut: lightsOutMs,
        wake: wakeMs,
        curve,
        remote,
        lastCommand: last,
        commandsTonight: log.length,
        recent,
        tonight: log,
      });
      if (cmd) {
        log.push(cmd);
        if (rng.chance(IR_MISS_P)) missed.push(cmd);
        else ac = { ...cmd.state };
      }
    }

    if (plan.override && m === plan.override.at && ac.power) ac = { ...ac, setpointC: plan.override.setpointC };

    // Ducted AC: thermostat on the return-air thermistor, inverter capacity, compressor hysteresis.
    const tRet = ta - plan.bedOffset;
    let removal = 0;
    let reevap = 0;
    if (ac.power) {
      const sp = ac.setpointC;
      // Inverter modulates down to ~35 %; below that it thermo-offs and the coil re-wets the air.
      if (compressor && tRet < sp - 1) {
        compressor = false;
        offFor = 0;
      } else if (!compressor && tRet > sp - 0.2 && offFor >= 3) compressor = true;
      const cap = AC_CAP[ac.fan] * plan.acCapScale;
      const qT = compressor ? cap * Math.min(1, Math.max(0.35, 0.35 + (0.65 * (tRet - sp + 0.5)) / 1.5)) : 0;
      qDel += (qT - qDel) * kQ;
      if (compressor && qDel > 300) {
        const tCoil = tRet - 8 - (8 * qDel) / cap;
        removal = ((AC_FLOW[ac.fan] / 60) * 0.75 * Math.max(0, w - satGm3(tCoil))) / volume;
        coil = Math.min(120, coil + removal * volume);
      } else {
        reevap = Math.min(coil, 4);
        coil -= reevap;
      }
    } else {
      compressor = false;
      qDel *= 1 - kQ;
      reevap = Math.min(coil, 1);
      coil -= reevap;
    }
    if (!compressor) offFor++;

    // Heat balance (1-min explicit step; time constants are hours, so stable).
    const dTa = (60 / ca) * (UA_AIR_OUT * (o.t - ta) + infil * (o.t - ta) + UA_AIR_MASS * (tm - ta) + d.heat[m]! - qDel);
    const dTm = (60 / cm) * (UA_AIR_MASS * (ta - tm) + UA_MASS_OUT * (o.t - tm) + sun);
    ta += dTa;
    tm += dTm;

    // Moisture (g/m³): occupants + showers, infiltration, coil, sorption buffer (bedding/wood).
    const sorb = (BUF_K / 60) * (w - wb);
    w += (d.moist[m]! + reevap) / volume - removal + kAch * (wOut - w) - sorb;
    wb += sorb / BUF_CAP;

    // CO2 mass balance, exact per step for constant generation.
    const g = d.gen[m]!;
    const gPpmPerH = (g * 1000 * 3600) / volume;
    c = plan.ach > 0 ? plan.cOut + gPpmPerH / plan.ach + (c - plan.cOut - gPpmPerH / plan.ach) * (1 - kAch) : c + gPpmPerH / 60;

    // Door: mix with house air.
    const door = d.door[m]!;
    if (door > 0) {
      const f = 1 - Math.exp(-door / 60);
      c += f * (cHouse - c);
      ta += f * 0.5 * (T_HOUSE - ta); // furnishings buffer part of it
      w += f * ((satGm3(T_HOUSE) * 0.68) - w);
    }

    const sat = satGm3(ta);
    if (w > sat * 0.93) w = sat * 0.93;
    const rh = (100 * w) / sat;
    tf += (ta - tf) * kSensor;
    rhf += (rh - rhf) * kRh;
    tempTrue[m] = ta;
    rhTrue[m] = rh;
    co2True[m] = c;
    readings[m] = {
      ts,
      tempC: Math.round((tf + rng.normal(0, 0.03)) * 10) / 10,
      // Meter Pro CO2 is rated 10–90 % (±5 % above); it saturates rather than reading 97.
      rh: Math.round(Math.min(94, rhf + rng.normal(0, 0.4))),
      co2: Math.round(c + rng.normal(0, 6)),
      source: 'sim',
    };
  }

  // Close out landing checks the controller never got to (a newer command came first, or the night ended).
  for (let i = 0; i < log.length; i++) {
    const cmd = log[i]!;
    if (cmd.landed !== null && cmd.landed !== undefined) continue;
    const until = Math.min(log[i + 1]?.ts ?? Infinity, cmd.ts + 40 * MIN);
    const from = Math.round((cmd.ts - t0) / MIN);
    const to = Math.min(DAY_MIN, Math.round((until - t0) / MIN));
    cmd.landed = evaluateLanding(cmd, readings.slice(from, to));
  }

  const outdoor: OutdoorReading[] = [];
  for (let m = 0; m <= DAY_MIN; m += 60) {
    const o = outdoorAt(plan, noise, m);
    outdoor.push({ ts: t0 + m * MIN, tempC: Math.round(o.t * 10) / 10, rh: Math.round(o.rh) });
  }
  return { readings, tempTrue, rhTrue, co2True, ac: log, missed, outdoor, end: { ta, tm, c, w, wb, tf, rhf, coil } };
}
