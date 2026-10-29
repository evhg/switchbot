/** Room tab charts. Implementations live in ./room/* (air, comfort, aircon, events); styles in ./room/room.module.css. */
export { AchTracker, Co2ForecastChart, VentGauge } from './room/air.tsx';
export { CalendarHeatmap, ComfortChart, RadialClock } from './room/comfort.tsx';
export { OutdoorIndoor, ResponseScatter, SetpointChart } from './room/aircon.tsx';
export { EventLanes, ShowerMini } from './room/events.tsx';
