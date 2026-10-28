// Virtual IR air conditioner (Hub Mini). See docs/research/openapi.md §4.
import type { AcCommand, AcMode, AcState, FanSpeed } from '../types.ts';

export const SETALL_MODE: Record<AcMode, number> = { auto: 1, cool: 2, dry: 3, fan: 4, heat: 5 };
export const SETALL_FAN: Record<FanSpeed, number> = { auto: 1, low: 2, medium: 3, high: 4 };
export const SETALL_MIN_C = 16;
export const SETALL_MAX_C = 30;

export interface SwitchBotCommandBody {
  commandType: 'command' | 'customize';
  command: string;
  parameter: string;
}

/** "{temp},{mode},{fan},{on|off}", e.g. "19,2,1,on". Temperature must be an integer (fractional values misbehave). */
export function acStateToSetAllParam(state: AcState): string {
  if (!Number.isFinite(state.setpointC)) throw new RangeError(`invalid setpoint: ${state.setpointC}`);
  const temp = Math.min(SETALL_MAX_C, Math.max(SETALL_MIN_C, Math.round(state.setpointC)));
  const mode = SETALL_MODE[state.mode];
  const fan = SETALL_FAN[state.fan];
  if (mode === undefined || fan === undefined) throw new RangeError(`invalid mode/fan: ${state.mode}/${state.fan}`);
  return `${temp},${mode},${fan},${state.power ? 'on' : 'off'}`;
}

/** Inverse of acStateToSetAllParam (mode 0 is also auto). Returns null for malformed input. */
export function parseSetAllParam(param: string): AcState | null {
  const parts = param.split(',').map((s) => s.trim());
  if (parts.length !== 4) return null;
  const [t, m, f, p] = parts as [string, string, string, string];
  const temp = Number(t);
  const modeNum = Number(m) === 0 ? 1 : Number(m);
  const mode = (Object.keys(SETALL_MODE) as AcMode[]).find((k) => SETALL_MODE[k] === modeNum);
  const fan = (Object.keys(SETALL_FAN) as FanSpeed[]).find((k) => SETALL_FAN[k] === Number(f));
  if (!Number.isFinite(temp) || !mode || !fan || (p !== 'on' && p !== 'off')) return null;
  return { setpointC: temp, mode, fan, power: p === 'on' };
}

/**
 * 'setAll' → command setAll; 'customize' → the learned button (parameter 'default').
 * A customize command without a button falls back to turnOff when powering off, otherwise it's an error.
 */
export function toSwitchBotCommand(cmd: AcCommand): SwitchBotCommandBody {
  if (cmd.via === 'customize') {
    if (cmd.button) return { commandType: 'customize', command: cmd.button, parameter: 'default' };
    if (!cmd.state.power) return { commandType: 'command', command: 'turnOff', parameter: 'default' };
    throw new Error('customize command needs a learned button name');
  }
  return { commandType: 'command', command: 'setAll', parameter: acStateToSetAllParam(cmd.state) };
}
