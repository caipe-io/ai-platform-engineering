// SPDX-License-Identifier: Apache-2.0

const DEFAULT_ORIGINS = Object.freeze({
  geocoding: "https://geocoding-api.open-meteo.com",
  forecast: "https://api.open-meteo.com",
  airQuality: "https://air-quality-api.open-meteo.com",
});

/** Fetch and normalize current, daily, and air-quality data from Open-Meteo. */
export async function fetchWeatherDashboard(
  city,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = 8_000,
    apiKey = process.env.OPEN_METEO_API_KEY,
    origins = providerOrigins(process.env),
  } = {},
) {
  const normalizedCity = String(city ?? "").trim();
  if (!normalizedCity || normalizedCity.length > 120) {
    throw new Error("city must contain between 1 and 120 characters");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");

  const options = {
    fetchImpl,
    timeoutMs,
    apiKey: String(apiKey ?? "").trim(),
  };
  if (options.apiKey) requireSecureProviderOrigins(origins);
  const locationUrl = new URL("/v1/search", origins.geocoding);
  locationUrl.searchParams.set("name", normalizedCity);
  locationUrl.searchParams.set("count", "1");
  locationUrl.searchParams.set("language", "en");
  locationUrl.searchParams.set("format", "json");
  addApiKey(locationUrl, options.apiKey);

  const locationPayload = await fetchJson(locationUrl, options);
  const match = Array.isArray(locationPayload.results) ? locationPayload.results[0] : null;
  if (!match || !Number.isFinite(Number(match.latitude)) || !Number.isFinite(Number(match.longitude))) {
    throw new Error(`no location matched "${normalizedCity}"`);
  }
  const location = {
    name: String(match.name || normalizedCity),
    region: String(match.admin1 || ""),
    country: String(match.country || ""),
    latitude: Number(match.latitude),
    longitude: Number(match.longitude),
  };

  const forecastUrl = new URL("/v1/forecast", origins.forecast);
  setLocation(forecastUrl, location);
  forecastUrl.searchParams.set(
    "current",
    "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m",
  );
  forecastUrl.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
  );
  forecastUrl.searchParams.set("temperature_unit", "celsius");
  forecastUrl.searchParams.set("wind_speed_unit", "kmh");
  forecastUrl.searchParams.set("forecast_days", "7");
  forecastUrl.searchParams.set("timezone", "auto");
  addApiKey(forecastUrl, options.apiKey);

  const airQualityUrl = new URL("/v1/air-quality", origins.airQuality);
  setLocation(airQualityUrl, location);
  airQualityUrl.searchParams.set("current", "us_aqi,pm2_5,ozone");
  airQualityUrl.searchParams.set("timezone", "auto");
  addApiKey(airQualityUrl, options.apiKey);

  const [forecast, airQuality] = await Promise.all([
    fetchJson(forecastUrl, options),
    fetchAirQuality(airQualityUrl, options),
  ]);

  const current = forecast.current || {};
  return {
    attribution: {
      name: "Open-Meteo",
      url: "https://open-meteo.com/",
      license: "CC BY 4.0",
      transformed: true,
    },
    location: {
      name: location.name,
      region: location.region,
      country: location.country,
    },
    observedAt: String(current.time || new Date().toISOString()),
    current: {
      temperatureC: numberOrNull(current.temperature_2m),
      apparentC: numberOrNull(current.apparent_temperature),
      humidityPercent: numberOrNull(current.relative_humidity_2m),
      windKmh: numberOrNull(current.wind_speed_10m),
      weatherCode: numberOrNull(current.weather_code),
      condition: weatherCodeDescription(current.weather_code),
    },
    daily: zipDaily(forecast.daily || {}),
    airQuality,
  };
}

export function providerOrigins(env = process.env) {
  return {
    geocoding: validOrigin(env.OPEN_METEO_GEOCODING_ORIGIN, DEFAULT_ORIGINS.geocoding),
    forecast: validOrigin(env.OPEN_METEO_FORECAST_ORIGIN, DEFAULT_ORIGINS.forecast),
    airQuality: validOrigin(env.OPEN_METEO_AIR_QUALITY_ORIGIN, DEFAULT_ORIGINS.airQuality),
  };
}

async function fetchAirQuality(url, options) {
  try {
    const payload = await fetchJson(url, options);
    const current = payload.current || {};
    const usAqi = numberOrNull(current.us_aqi);
    return {
      available: usAqi !== null,
      usAqi,
      category: aqiCategory(usAqi),
      pm25: numberOrNull(current.pm2_5),
      ozone: numberOrNull(current.ozone),
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : "air-quality provider unavailable",
    };
  }
}

async function fetchJson(url, { fetchImpl, timeoutMs }) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url.hostname} returned HTTP ${response.status}`);
  return response.json();
}

function zipDaily(daily) {
  const dates = array(daily.time);
  return dates.map((date, index) => {
    const code = numberAt(daily.weather_code, index);
    return {
      date: String(date),
      highC: numberAt(daily.temperature_2m_max, index),
      lowC: numberAt(daily.temperature_2m_min, index),
      rainChancePercent: numberAt(daily.precipitation_probability_max, index),
      windKmh: numberAt(daily.wind_speed_10m_max, index),
      condition: weatherCodeDescription(code),
    };
  });
}

function setLocation(url, location) {
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
}

function addApiKey(url, apiKey) {
  if (apiKey) url.searchParams.set("apikey", apiKey);
}

function validOrigin(value, fallback) {
  const url = new URL(String(value ?? fallback).trim());
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
    throw new Error(`invalid Open-Meteo origin: ${url.origin}`);
  }
  return url.origin;
}

function requireSecureProviderOrigins(origins) {
  const insecure = Object.entries(origins).find(
    ([, origin]) => new URL(origin).protocol !== "https:",
  );
  if (insecure) {
    throw new Error(`Open-Meteo API keys require HTTPS for the ${insecure[0]} origin`);
  }
}

function weatherCodeDescription(value) {
  const code = numberOrNull(value);
  if (code === 0) return "Clear sky";
  if ([1, 2].includes(code)) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if ([45, 48].includes(code)) return "Fog";
  if ([51, 53, 55, 56, 57].includes(code)) return "Drizzle";
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "Rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "Snow";
  if ([95, 96, 99].includes(code)) return "Thunderstorm";
  return "Mixed conditions";
}

function aqiCategory(value) {
  if (value === null) return "Unavailable";
  if (value <= 50) return "Good";
  if (value <= 100) return "Moderate";
  if (value <= 150) return "Unhealthy for sensitive groups";
  if (value <= 200) return "Unhealthy";
  if (value <= 300) return "Very unhealthy";
  return "Hazardous";
}

function numberAt(values, index) {
  return numberOrNull(array(values)[index]);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
