export { switchBotSignHeaders, type SignOptions, type FetchLike } from './sign.ts';
export {
  acStateToSetAllParam,
  parseSetAllParam,
  toSwitchBotCommand,
  SETALL_MODE,
  SETALL_FAN,
  SETALL_MIN_C,
  SETALL_MAX_C,
  type SwitchBotCommandBody,
} from './ac.ts';
export {
  SwitchBotClient,
  SwitchBotError,
  SWITCHBOT_BASE_URL,
  SWITCHBOT_DEFAULT_DAILY_BUDGET,
  parseRetryAfter,
  type SwitchBotClientOptions,
  type SwitchBotErrorKind,
  type SwitchBotDevice,
  type SwitchBotIrRemote,
  type SwitchBotScene,
  type QuotaState,
  type QuotaInfo,
} from './client.ts';
export {
  parseMeterStatus,
  parseWebhookEvent,
  normalizeMac,
  METER_PRO_CO2_TYPE,
  CO2_MIN,
  CO2_MAX,
  CO2_PLAUSIBLE_MIN,
  plausibleCo2,
  type ParseOptions,
  type SwitchBotWebhookEvent,
} from './parse.ts';
