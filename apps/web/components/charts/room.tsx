/** Room tab charts (docs/DESIGN.md §7). Implementations live in ./room/*; styles in ./room/room.module.css. */
export { AchTracker, Co2ForecastChart, Meter, NightBars, NowTrace } from './room/air.tsx';
export { CalendarHeatmap, ComfortChart, RadialClock } from './room/comfort.tsx';
export { OutdoorIndoor, ResponseScatter, SETPOINT_DOMAIN, SetpointChart } from './room/aircon.tsx';
export { EventLanes, ShowerMini } from './room/events.tsx';
