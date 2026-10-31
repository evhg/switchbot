import { describe, expect, it } from 'vitest';
import { googleWeatherUrl, openMeteoUrl, parseGoogleCurrentConditions, parseOpenMeteoCurrent } from '../src/index.ts';

// Shapes as returned by the two APIs for Phuket (trimmed: the parsers ignore the other fields).
const GOOGLE = {
  currentTime: '2026-10-31T07:12:45.418237622Z',
  timeZone: { id: 'Asia/Bangkok' },
  isDaytime: true,
  weatherCondition: {
    iconBaseUri: 'https://maps.gstatic.com/weather/v1/scattered_showers',
    description: { text: 'Scattered showers', languageCode: 'en' },
    type: 'SCATTERED_SHOWERS',
  },
  temperature: { degrees: 30.4, unit: 'CELSIUS' },
  feelsLikeTemperature: { degrees: 36.1, unit: 'CELSIUS' },
  dewPoint: { degrees: 25.2, unit: 'CELSIUS' },
  heatIndex: { degrees: 36.1, unit: 'CELSIUS' },
  windChill: { degrees: 30.4, unit: 'CELSIUS' },
  relativeHumidity: 74,
  uvIndex: 6,
  precipitation: { probability: { percent: 40, type: 'RAIN' }, qpf: { quantity: 0.3, unit: 'MILLIMETERS' } },
  thunderstormProbability: 20,
  airPressure: { meanSeaLevelMillibars: 1009.4 },
  wind: { direction: { degrees: 250, cardinal: 'WEST_SOUTHWEST' }, speed: { value: 13, unit: 'KILOMETERS_PER_HOUR' }, gust: { value: 27, unit: 'KILOMETERS_PER_HOUR' } },
  visibility: { distance: 16, unit: 'KILOMETERS' },
  cloudCover: 62,
};

const OPEN_METEO = {
  latitude: 7.875,
  longitude: 98.375,
  generationtime_ms: 0.0438690185546875,
  utc_offset_seconds: 25200,
  timezone: 'Asia/Bangkok',
  timezone_abbreviation: 'GMT+7',
  elevation: 12,
  current_units: { time: 'iso8601', interval: 'seconds', temperature_2m: '°C', relative_humidity_2m: '%' },
  current: { time: '2026-10-31T14:15', interval: 900, temperature_2m: 30.2, relative_humidity_2m: 71 },
};

describe('weather parsers', () => {
  it('Google currentConditions → reading (floored to the minute)', () => {
    expect(parseGoogleCurrentConditions(GOOGLE)).toEqual({ ts: Date.parse('2026-10-31T07:12:00Z'), tempC: 30.4, rh: 74 });
    const f = parseGoogleCurrentConditions({ ...GOOGLE, temperature: { degrees: 86.7, unit: 'FAHRENHEIT' } });
    expect(f?.tempC).toBe(30.4);
  });

  it('Open-Meteo current → reading (local time with utc_offset_seconds)', () => {
    expect(parseOpenMeteoCurrent(OPEN_METEO)).toEqual({ ts: Date.parse('2026-10-31T14:15:00+07:00'), tempC: 30.2, rh: 71 });
  });

  it('rejects missing or implausible values', () => {
    expect(parseGoogleCurrentConditions({ error: { code: 403, status: 'PERMISSION_DENIED' } })).toBeNull();
    expect(parseGoogleCurrentConditions({ ...GOOGLE, relativeHumidity: undefined })).toBeNull();
    expect(parseOpenMeteoCurrent({ ...OPEN_METEO, current: { ...OPEN_METEO.current, temperature_2m: null } })).toBeNull();
    expect(parseOpenMeteoCurrent({ ...OPEN_METEO, current: { ...OPEN_METEO.current, relative_humidity_2m: 140 } })).toBeNull();
    expect(parseOpenMeteoCurrent({ reason: 'Latitude must be in range of -90 to 90°.', error: true })).toBeNull();
  });

  it('builds the request URLs', () => {
    expect(openMeteoUrl()).toBe('https://api.open-meteo.com/v1/forecast?latitude=7.88&longitude=98.39&current=temperature_2m%2Crelative_humidity_2m&timezone=Asia%2FBangkok');
    expect(googleWeatherUrl('k')).toBe('https://weather.googleapis.com/v1/currentConditions:lookup?key=k&location.latitude=7.88&location.longitude=98.39');
  });
});
