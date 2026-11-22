/** core.weather: the weather tile, behind the plugin API. Trusted, runs in the agent; the deck keeps its own weather tile (custom:weather). */
import type { PluginModule, Settings } from "../../../src/plugins/api";
import type { WeatherOptions } from "../../../src/automation";
import type { WeatherData } from "../../../src/weather";
import type { TempUnit } from "../../../src/temperature";

export interface WeatherDeps {
  get(o: WeatherOptions, force?: boolean, themeUnit?: TempUnit): Promise<WeatherData>;
  /** The layout's temperature unit preference. */
  tempUnit?: () => TempUnit | undefined;
}

/** Flat tile settings (D7) back to the nested options the weather service takes. */
export function weatherOptionsOf(s: Settings): WeatherOptions {
  const o: WeatherOptions = {};
  if (s.source === "auto" || s.source === "hass" || s.source === "open-meteo") o.source = s.source;
  if (typeof s.entity === "string" && s.entity) o.entity = s.entity;
  if (typeof s.lat === "number" && typeof s.lon === "number") o.location = { name: typeof s.locationName === "string" ? s.locationName : "", lat: s.lat, lon: s.lon };
  if (s.show === "now" || s.show === "hourly" || s.show === "daily" || s.show === "auto") o.show = s.show;
  if (s.units === "metric" || s.units === "imperial") o.units = s.units;
  return o;
}

export function makeWeatherPlugin(deps: WeatherDeps): PluginModule {
  return {
    activate(ctx) {
      // the manifest's renderer (custom:weather) is applied by the host; the value here is nominal
      ctx.widgets.provide("weather", async (s) => ({ render: "text", data: await deps.get(weatherOptionsOf(s), false, deps.tempUnit?.()) }), { every: 15 * 60 });
    },
  };
}
