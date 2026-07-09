import { strFromU8, unzipSync } from "fflate";

const DWD_DAILY_BASE = "https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/daily/kl";
const OPENWEATHER_FORECAST_URL = "https://api.openweathermap.org/data/2.5/forecast";
const OPENWEATHER_CURRENT_URL = "https://api.openweathermap.org/data/2.5/weather";
const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const LOCAL_TIMEZONE = "Europe/Berlin";
const DEFAULT_BLEND_WEIGHTS = {
  temp_model: 0.76,
  rain_probability_model: 0.70,
  rain_amount_model: 0.72,
};
const DEFAULT_CITIES = ["Berlin", "Muenchen", "Nuernberg", "Hamburg", "Coburg"];
const MIN_TRAINING_CASES = 18;

const GERMAN_CITIES = {
  berlin: [52.52, 13.405, "Berlin"],
  hamburg: [53.5511, 9.9937, "Hamburg"],
  muenchen: [48.1372, 11.5755, "Muenchen"],
  munich: [48.1372, 11.5755, "Muenchen"],
  "münchen": [48.1372, 11.5755, "Muenchen"],
  nuernberg: [49.4521, 11.0767, "Nuernberg"],
  "nürnberg": [49.4521, 11.0767, "Nuernberg"],
  coburg: [50.2593, 10.9638, "Coburg"],
  koeln: [50.9375, 6.9603, "Koeln"],
  "köln": [50.9375, 6.9603, "Koeln"],
  frankfurt: [50.1109, 8.6821, "Frankfurt am Main"],
  stuttgart: [48.7758, 9.1829, "Stuttgart"],
  duesseldorf: [51.2277, 6.7735, "Duesseldorf"],
  "düsseldorf": [51.2277, 6.7735, "Duesseldorf"],
  dortmund: [51.5136, 7.4653, "Dortmund"],
  essen: [51.4556, 7.0116, "Essen"],
  leipzig: [51.3397, 12.3731, "Leipzig"],
  bremen: [53.0793, 8.8017, "Bremen"],
  dresden: [51.0504, 13.7373, "Dresden"],
  hannover: [52.3759, 9.732, "Hannover"],
  bonn: [50.7374, 7.0982, "Bonn"],
  karlsruhe: [49.0069, 8.4037, "Karlsruhe"],
  freiburg: [47.999, 7.8421, "Freiburg im Breisgau"],
  kiel: [54.3233, 10.1228, "Kiel"],
  rostock: [54.0924, 12.0991, "Rostock"],
};

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return jsonResponse({ ok: true, service: "a better weather", runtime: "cloudflare-worker" });
      }
      if (url.pathname === "/") {
        return fetchAsset(request, env, "/index.html");
      }
      if (url.pathname === "/api/forecast") {
        return handleForecast(url, env, false);
      }
      if (url.pathname === "/api/forecast/compact") {
        return handleForecast(url, env, true);
      }
      if (url.pathname === "/api/stations") {
        return handleStation(url, env);
      }
      if (url.pathname === "/api/learning") {
        return jsonResponse({ cities: await loadLearningCities(env) });
      }
      if (url.pathname === "/api/learning/cards") {
        return handleLearningCards(env);
      }
      if (url.pathname === "/api/learning/dashboard") {
        return handleLearningDashboard(env, ctx);
      }
      if (url.pathname === "/api/learning/add") {
        return handleLearningAdd(url, env);
      }
      if (url.pathname === "/api/learning/remove") {
        return handleLearningRemove(url, env);
      }
      if (url.pathname === "/api/train/daily") {
        return handleTrainDaily(url, env, ctx);
      }
      if (url.pathname === "/feed.xml") {
        return handleFeed(url, env);
      }
      if (url.pathname.startsWith("/static/")) {
        return fetchAsset(request, env, url.pathname.replace(/^\/static\//, "/"));
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      return jsonResponse({ error: publicError(error) }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runTrainingCycle(env));
  },
};

async function handleForecast(url, env, compact) {
  const params = forecastParams(url);
  if (invalidLocation(params)) {
    return jsonResponse({ error: "Bitte Ort oder Koordinaten angeben." }, 400);
  }
  const payload = await buildForecast(env, params);
  return jsonResponse(compact ? compactForecastPayload(payload) : payload);
}

async function handleStation(url, env) {
  const params = forecastParams(url);
  if (invalidLocation(params)) {
    return jsonResponse({ error: "Bitte Ort oder Koordinaten angeben." }, 400);
  }
  const [lat, lon, label] = await resolveLocation(env, params);
  const station = await nearestStation(env, lat, lon);
  return jsonResponse({
    location: { label, lat, lon },
    station,
  });
}

async function handleLearningDashboard(env, ctx) {
  return handleLearningCards(env);
}

async function handleLearningCards(env) {
  const cities = await loadLearningCities(env);
  const cards = [];
  const errors = [];
  for (const city of cities) {
    try {
      const normalized = normalizeCity(city);
      const row = env.DB
        ? await env.DB.prepare(
            "SELECT * FROM forecast_snapshots WHERE normalized_city = ? AND target_date = ? ORDER BY generated_at DESC LIMIT 1"
          ).bind(normalized, localDate(new Date())).first()
        : null;
      if (!row) {
        errors.push({ city, error: "Noch kein aktueller Lernwert vorhanden. Bitte einmal öffnen oder den nächsten automatischen Lauf abwarten." });
        continue;
      }
      cards.push(await dashboardCardFromSnapshot(env, city, row));
    } catch (error) {
      errors.push({ city, error: publicError(error) });
    }
  }
  return jsonResponse({
    cities,
    cards,
    errors,
    generated_at: new Date().toUTCString(),
  });
}

async function dashboardCardFromSnapshot(env, city, row) {
  const today = JSON.parse(row.payload_json || "{}");
  const current = await currentForCity(env, city);
  return {
    city,
    location: { label: row.city },
    station: {
      id: row.station_id,
      name: row.station_name,
      distance_km: null,
    },
    generated_at: row.generated_at,
    current,
    today,
    summary: {
      headline: `${row.city}: aktuelle Lage und Resttagesforecast`,
      detail: "Startkachel zeigt den Jetztwert und den zuletzt berechneten Resttagesforecast.",
      station_note: `DWD-Referenz: ${row.station_name}.`,
      actions: [],
      watch: [],
    },
    learning: {
      status: row.verified_at ? "bewertet" : "aktiv",
      cases: row.verified_at ? 1 : 0,
      summary: row.verified_at
        ? "Dieser Tag wurde bereits gegen den DWD-Istwert bewertet."
        : "Automatische Bewertung aktiv, sobald der offizielle Tageswert verfügbar ist.",
    },
  };
}

async function currentForCity(env, city) {
  try {
    const [lat, lon] = await resolveLocation(env, { city });
    const [openweatherCurrent, openMeteo] = await Promise.all([
      fetchOpenWeatherCurrent(env, lat, lon),
      fetchOpenMeteoForecast(env, lat, lon),
    ]);
    return buildCurrentConditions(openweatherCurrent, openMeteo);
  } catch (_error) {
    return null;
  }
}

async function handleLearningAdd(url, env) {
  const city = (url.searchParams.get("city") || "").trim();
  if (!city) return jsonResponse({ error: "Bitte Stadt angeben." }, 400);
  if (env.DB) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO learning_cities(city, normalized_city) VALUES (?, ?)"
    ).bind(city, normalizeCity(city)).run();
  }
  return jsonResponse({ cities: await loadLearningCities(env) });
}

async function handleLearningRemove(url, env) {
  const city = (url.searchParams.get("city") || "").trim();
  if (!city) return jsonResponse({ error: "Bitte Stadt angeben." }, 400);
  if (env.DB) {
    await env.DB.prepare("DELETE FROM learning_cities WHERE normalized_city = ?")
      .bind(normalizeCity(city))
      .run();
  }
  return jsonResponse({ cities: await loadLearningCities(env) });
}

async function handleTrainDaily(url, env, ctx) {
  if (env.TRAINING_SECRET && url.searchParams.get("secret") !== env.TRAINING_SECRET) {
    return jsonResponse({ error: "Training secret fehlt oder ist falsch." }, 403);
  }
  const promise = runTrainingCycle(env);
  ctx?.waitUntil?.(promise);
  const result = ctx ? { queued: true } : await promise;
  return jsonResponse({ ok: true, ...result });
}

async function handleFeed(url, env) {
  const params = forecastParams(url);
  if (invalidLocation(params)) {
    return new Response("Bitte Ort oder Koordinaten angeben.", { status: 400 });
  }
  const payload = await buildForecast(env, params);
  return new Response(rssFeed(payload, url.origin), {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "no-store, max-age=0",
    },
  });
}

async function runTrainingCycle(env) {
  const cities = await loadLearningCities(env);
  const archived = [];
  const errors = [];
  for (const city of cities) {
    try {
      const payload = await buildForecast(env, { city });
      await archiveForecast(env, payload);
      await verifySnapshots(env, payload.station.id);
      archived.push(city);
    } catch (error) {
      errors.push({ city, error: publicError(error) });
    }
  }
  return { archived: archived.length, errors };
}

async function buildForecast(env, params) {
  const [lat, lon, label] = await resolveLocation(env, params);
  const station = await nearestStation(env, lat, lon);
  const observations = await loadStationObservations(env, station.id);
  const learning = await learnedBlendWeights(env, station.id);
  const [openweather, openweatherCurrent, openMeteo] = await Promise.all([
    fetchOpenWeatherForecast(env, lat, lon),
    fetchOpenWeatherCurrent(env, lat, lon),
    fetchOpenMeteoForecast(env, lat, lon),
  ]);
  const owDaily = aggregateOpenWeatherDaily(openweather);
  const omDaily = aggregateOpenMeteoDaily(openMeteo);
  const owHourly = aggregateOpenWeatherHourly(openweather);
  const omHourly = aggregateOpenMeteoHourly(openMeteo);
  const current = buildCurrentConditions(openweatherCurrent, openMeteo);
  const recentAnomaly = computeRecentAnomaly(observations);
  const days = owDaily.map((day, index) => {
    const openMeteoDay = omDaily.get(day.date);
    return challengeDay(day, openMeteoDay, observations, station, learning.weights, recentAnomaly, index);
  });
  const hourly = buildHourlyForecast(owHourly, omHourly, days);
  enrichRainTiming(days, hourly);
  const payload = {
    location: { label, lat, lon },
    station,
    source: {
      openweather: "openweather",
      open_meteo: "open-meteo",
      dwd: DWD_DAILY_BASE,
      generated_at: new Date().toISOString(),
      observations: observations.length,
      method: "OpenWeather und Open-Meteo Konsens, lokal mit DWD-Klimatologie, aktueller Stationsanomalie und gelernten D1-Backtests kalibriert.",
      weighting_status: "learning_enabled",
      weighting_note: "Die App speichert Vorhersagen dauerhaft, vergleicht sie später mit offiziellen Tageswerten und lernt daraus lokale Gewichte je DWD-Station.",
      learning,
    },
    current,
    overview: buildOverview(label, station, days, current),
    calibration: await calibrationStatus(env, station.id),
    hourly,
    days,
  };
  return payload;
}

async function resolveLocation(env, params) {
  if (Number.isFinite(params.lat) && Number.isFinite(params.lon)) {
    return [params.lat, params.lon, params.label || `${params.lat.toFixed(3)}, ${params.lon.toFixed(3)}`];
  }
  const key = normalizeCity(params.city || "");
  if (GERMAN_CITIES[key]) return GERMAN_CITIES[key];
  const apiKey = requireOpenWeatherKey(env);
  const geocodeUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(`${params.city},DE`)}&limit=1&appid=${apiKey}`;
  const data = await fetchJsonCached(env, `geo:${key}`, geocodeUrl, 86400);
  if (!Array.isArray(data) || !data.length) throw new Error(`Ort nicht gefunden: ${params.city}`);
  const first = data[0];
  return [
    Number(first.lat),
    Number(first.lon),
    first.local_names?.de || first.name || params.city,
  ];
}

function forecastParams(url) {
  return {
    city: url.searchParams.get("city"),
    label: url.searchParams.get("label"),
    lat: optionalFloat(url.searchParams.get("lat")),
    lon: optionalFloat(url.searchParams.get("lon")),
  };
}

function invalidLocation(params) {
  return !params.city && (!Number.isFinite(params.lat) || !Number.isFinite(params.lon));
}

async function loadLearningCities(env) {
  if (!env.DB) return defaultLearningCities(env);
  const result = await env.DB.prepare("SELECT city FROM learning_cities ORDER BY id").all();
  const cities = (result.results || []).map((row) => row.city).filter(Boolean);
  if (cities.length) return cities;
  for (const city of defaultLearningCities(env)) {
    await env.DB.prepare("INSERT OR IGNORE INTO learning_cities(city, normalized_city) VALUES (?, ?)")
      .bind(city, normalizeCity(city))
      .run();
  }
  return defaultLearningCities(env);
}

function defaultLearningCities(env) {
  return (env.DEFAULT_LEARNING_CITIES || DEFAULT_CITIES.join(","))
    .split(",")
    .map((city) => city.trim())
    .filter(Boolean);
}

async function nearestStation(env, lat, lon) {
  const stations = await loadStations(env);
  const now = new Date();
  const activeThreshold = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 120));
  const active = stations.filter((station) => new Date(`${station.to_date}T00:00:00Z`) >= activeThreshold);
  const pool = active.length ? active : stations;
  const nearest = pool.reduce((best, station) => {
    const distance = haversineKm(lat, lon, station.lat, station.lon);
    return !best || distance < best.distance_km ? { ...station, distance_km: distance } : best;
  }, null);
  return {
    id: nearest.id,
    name: nearest.name,
    state: nearest.state,
    lat: nearest.lat,
    lon: nearest.lon,
    height_m: nearest.height_m,
    distance_km: round(nearest.distance_km, 1),
    data_until: nearest.to_date,
  };
}

async function loadStations(env) {
  const text = await fetchLatin1BytesTextCached(
    env,
    "dwd:stations:latin1:v3",
    `${DWD_DAILY_BASE}/recent/KL_Tageswerte_Beschreibung_Stationen.txt`,
    86400
  );
  const stations = [];
  for (const line of text.split(/\r?\n/).slice(2)) {
    if (!line.trim() || !line.slice(0, 5).trim().match(/^\d+$/)) continue;
    const id = line.slice(0, 5).trim().padStart(5, "0");
    const fromDate = parseDwdDate(line.slice(6, 14).trim());
    const toDate = parseDwdDate(line.slice(15, 23).trim());
    const height = Number.parseInt(line.slice(24, 38).trim(), 10);
    const lat = Number.parseFloat(line.slice(39, 49).trim());
    const lon = Number.parseFloat(line.slice(50, 60).trim());
    const name = line.slice(61, 102).trim();
    const state = line.slice(102, 142).trim();
    if (id && Number.isFinite(lat) && Number.isFinite(lon)) {
      stations.push({ id, from_date: fromDate, to_date: toDate, height_m: height, lat, lon, name, state });
    }
  }
  if (!stations.length) throw new Error("Keine DWD-Stationen geladen.");
  return stations;
}

async function loadStationObservations(env, stationId) {
  const cacheKey = `dwd:observations:${stationId}`;
  const cached = await readCache(env, cacheKey);
  if (cached) return JSON.parse(cached);
  const [historicalUrl, recentUrl] = await Promise.all([
    findDwdStationZip(env, "historical", stationId),
    findDwdStationZip(env, "recent", stationId),
  ]);
  const rows = new Map();
  if (historicalUrl) {
    for (const row of await fetchDwdZipRows(historicalUrl)) rows.set(row.date, row);
  }
  if (recentUrl) {
    for (const row of await fetchDwdZipRows(recentUrl)) rows.set(row.date, row);
  }
  const cutoffYear = new Date().getUTCFullYear() - 50;
  const cutoffDate = `${cutoffYear}-01-01`;
  const observations = [...rows.values()]
    .filter((row) => row.date >= cutoffDate)
    .filter((row) => Number.isFinite(row.t_mean))
    .sort((a, b) => a.date.localeCompare(b.date));
  await writeCache(env, cacheKey, JSON.stringify(observations), 86400);
  return observations;
}

async function findDwdStationZip(env, folder, stationId) {
  const index = await fetchTextCached(env, `dwd:index:${folder}`, `${DWD_DAILY_BASE}/${folder}/`, 86400);
  const re = new RegExp(`href="([^"]*${stationId}[^"]*\\.zip)"`, "g");
  const matches = [...index.matchAll(re)].map((match) => match[1]);
  if (!matches.length) return null;
  matches.sort();
  return `${DWD_DAILY_BASE}/${folder}/${matches[matches.length - 1]}`;
}

async function fetchDwdZipRows(url) {
  const response = await fetch(url, { headers: { "user-agent": "a-better-weather/1.0" } });
  if (!response.ok) throw new Error(`DWD-Datei konnte nicht geladen werden: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const files = unzipSync(bytes);
  const filename = Object.keys(files).find((name) => name.startsWith("produkt_") && name.endsWith(".txt"));
  if (!filename) return [];
  const text = strFromU8(files[filename]);
  return parseDwdProduct(text);
}

function parseDwdProduct(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(";").map((item) => item.trim());
  const index = Object.fromEntries(headers.map((name, idx) => [name, idx]));
  return lines.slice(1).map((line) => {
    const cols = line.split(";").map((item) => item.trim());
    const date = parseDwdDate(cols[index.MESS_DATUM]);
    const rain = numeric(cols[index.RSK]);
    return {
      date,
      month_day: date.slice(5),
      t_mean: numeric(cols[index.TMK]),
      t_min: numeric(cols[index.TNK]),
      t_max: numeric(cols[index.TXK]),
      rain_mm: Number.isFinite(rain) ? Math.max(0, rain) : null,
    };
  }).filter((row) => row.date && Number.isFinite(row.t_mean));
}

async function fetchOpenWeatherForecast(env, lat, lon) {
  const apiKey = requireOpenWeatherKey(env);
  const query = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    units: "metric",
    lang: "de",
    appid: apiKey,
  });
  return fetchJsonCached(env, `owm:forecast:${round(lat, 3)}:${round(lon, 3)}`, `${OPENWEATHER_FORECAST_URL}?${query}`, 900);
}

async function fetchOpenWeatherCurrent(env, lat, lon) {
  const apiKey = requireOpenWeatherKey(env);
  const query = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    units: "metric",
    lang: "de",
    appid: apiKey,
  });
  return fetchJsonCached(env, `owm:current:${round(lat, 3)}:${round(lon, 3)}`, `${OPENWEATHER_CURRENT_URL}?${query}`, 300);
}

async function fetchOpenMeteoForecast(env, lat, lon) {
  const query = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone: LOCAL_TIMEZONE,
    forecast_days: "5",
    current: "temperature_2m,weather_code,wind_speed_10m,precipitation",
    hourly: "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m",
  });
  return fetchJsonCached(env, `om:forecast:${round(lat, 3)}:${round(lon, 3)}`, `${OPEN_METEO_FORECAST_URL}?${query}`, 900);
}

function aggregateOpenWeatherDaily(data) {
  const groups = new Map();
  for (const item of data.list || []) {
    const date = localDate(new Date(item.dt * 1000));
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(item);
  }
  return [...groups.entries()].slice(0, 5).map(([date, items]) => {
    const temps = items.map((item) => item.main?.temp).filter(Number.isFinite);
    const mins = items.map((item) => item.main?.temp_min).filter(Number.isFinite);
    const maxs = items.map((item) => item.main?.temp_max).filter(Number.isFinite);
    const rainProb = Math.max(...items.map((item) => item.pop || 0));
    const rainMm = sum(items.map((item) => item.rain?.["3h"] || 0));
    const wind = mean(items.map((item) => item.wind?.speed).filter(Number.isFinite));
    const description = mode(items.map((item) => item.weather?.[0]?.description).filter(Boolean)) || "-";
    return {
      date,
      t_mean: round(mean(temps), 1),
      t_min: round(min(mins.length ? mins : temps), 1),
      t_max: round(max(maxs.length ? maxs : temps), 1),
      rain_probability: clamp(rainProb, 0, 1),
      rain_mm: round(rainMm, 1),
      wind_mean: round(wind, 1),
      description,
    };
  });
}

function aggregateOpenWeatherHourly(data) {
  return (data.list || []).slice(0, 40).map((item) => ({
    time: new Date(item.dt * 1000).toISOString(),
    t: item.main?.temp,
    rain_probability: clamp(item.pop || 0, 0, 1),
    rain_mm: item.rain?.["3h"] || 0,
    wind: item.wind?.speed,
    description: item.weather?.[0]?.description || "-",
  }));
}

function aggregateOpenMeteoDaily(data) {
  const hourly = data.hourly || {};
  const groups = new Map();
  for (let i = 0; i < (hourly.time || []).length; i += 1) {
    const date = String(hourly.time[i]).slice(0, 10);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push({
      t: hourly.temperature_2m?.[i],
      pop: hourly.precipitation_probability?.[i],
      rain: hourly.precipitation?.[i],
      wind: hourly.wind_speed_10m?.[i],
      code: hourly.weather_code?.[i],
    });
  }
  const result = new Map();
  for (const [date, items] of groups.entries()) {
    const temps = items.map((item) => item.t).filter(Number.isFinite);
    result.set(date, {
      date,
      t_mean: round(mean(temps), 1),
      t_min: round(min(temps), 1),
      t_max: round(max(temps), 1),
      rain_probability: clamp(max(items.map((item) => (item.pop || 0) / 100)), 0, 1),
      rain_mm: round(sum(items.map((item) => item.rain || 0)), 1),
      wind_mean: round(mean(items.map((item) => item.wind).filter(Number.isFinite)) / 3.6, 1),
      description: weatherCodeText(mode(items.map((item) => item.code).filter(Number.isFinite))),
    });
  }
  return result;
}

function aggregateOpenMeteoHourly(data) {
  const hourly = data.hourly || {};
  return (hourly.time || []).slice(0, 72).map((time, i) => ({
    time: new Date(time).toISOString(),
    t: hourly.temperature_2m?.[i],
    rain_probability: clamp((hourly.precipitation_probability?.[i] || 0) / 100, 0, 1),
    rain_mm: hourly.precipitation?.[i] || 0,
    wind: Number.isFinite(hourly.wind_speed_10m?.[i]) ? hourly.wind_speed_10m[i] / 3.6 : null,
    description: weatherCodeText(hourly.weather_code?.[i]),
  }));
}

function buildCurrentConditions(openweatherCurrent, openMeteo) {
  const ow = {
    temperature_c: optionalNumber(openweatherCurrent.main?.temp),
    feels_like_c: optionalNumber(openweatherCurrent.main?.feels_like),
    description: openweatherCurrent.weather?.[0]?.description || "-",
    wind_mps: optionalNumber(openweatherCurrent.wind?.speed),
    observed_at: openweatherCurrent.dt ? new Date(openweatherCurrent.dt * 1000).toISOString() : new Date().toISOString(),
  };
  const omCurrent = openMeteo.current || {};
  const om = {
    temperature_c: optionalNumber(omCurrent.temperature_2m),
    description: weatherCodeText(omCurrent.weather_code),
    wind_mps: Number.isFinite(omCurrent.wind_speed_10m) ? omCurrent.wind_speed_10m / 3.6 : null,
    observed_at: omCurrent.time ? new Date(omCurrent.time).toISOString() : null,
  };
  const best = Number.isFinite(ow.temperature_c)
    ? { temperature_c: ow.temperature_c, description: ow.description, source: "OpenWeather Current", confidence: "hoch" }
    : { temperature_c: om.temperature_c, description: om.description, source: "Open-Meteo Current", confidence: "mittel" };
  const gap = Number.isFinite(ow.temperature_c) && Number.isFinite(om.temperature_c)
    ? round(ow.temperature_c - om.temperature_c, 1)
    : null;
  return {
    best,
    openweather: ow,
    open_meteo: om,
    temperature_gap_c: gap,
    explanation: "Aktuelle Temperatur ist der Jetzt-Wert. Der Tages-Forecast darunter beschreibt den Rest des Tages und ist kein Ersatz fuer den Realwert jetzt.",
  };
}

function challengeDay(openweather, openMeteo, observations, station, weights, recentAnomaly, horizon) {
  const pattern = climatePattern(observations, openweather.date);
  const om = openMeteo || null;
  const modelTemp = Number.isFinite(om?.t_mean) ? mean([openweather.t_mean, om.t_mean]) : openweather.t_mean;
  const modelMin = Number.isFinite(om?.t_min) ? mean([openweather.t_min, om.t_min]) : openweather.t_min;
  const modelMax = Number.isFinite(om?.t_max) ? mean([openweather.t_max, om.t_max]) : openweather.t_max;
  const modelRainProbability = Number.isFinite(om?.rain_probability)
    ? mean([openweather.rain_probability, om.rain_probability])
    : openweather.rain_probability;
  const modelRainMm = Number.isFinite(om?.rain_mm) ? mean([openweather.rain_mm, om.rain_mm]) : openweather.rain_mm;
  const recentWeight = horizon === 0 ? 0.55 : Math.max(0.15, 0.45 - horizon * 0.08);
  const dwdAdjusted = pattern.t_mean + recentAnomaly * recentWeight;
  const tempWeight = weights.temp_model;
  const likelyTemp = tempWeight * modelTemp + (1 - tempWeight) * dwdAdjusted;
  const shift = likelyTemp - modelTemp;
  const rainWeight = weights.rain_probability_model;
  const likelyRainProbability = clamp(rainWeight * modelRainProbability + (1 - rainWeight) * pattern.rain_probability, 0, 1);
  const amountWeight = weights.rain_amount_model;
  const likelyRainMm = Math.max(0, amountWeight * modelRainMm + (1 - amountWeight) * pattern.rain_mm);
  const confidence = confidenceScore({
    modelTemp,
    openweather,
    openMeteo: om,
    pattern,
    likelyRainProbability,
    modelRainProbability,
    horizon,
  });
  const rainSignal = rainSignalFor(likelyRainProbability, likelyRainMm, openweather, om);
  const condition = conditionText(likelyRainProbability, likelyRainMm, likelyTemp, openweather.description, om?.description);
  const likely = {
    t_mean: round(likelyTemp, 1),
    t_min: round(modelMin + shift, 1),
    t_max: round(modelMax + shift, 1),
    rain_probability: round(likelyRainProbability, 2),
    rain_mm: round(likelyRainMm, 1),
    wind_mean: round(mean([openweather.wind_mean, om?.wind_mean].filter(Number.isFinite)), 1),
    condition,
    confidence: confidence.overall,
    label: confidence.overall >= 78 ? "hoch" : confidence.overall >= 58 ? "mittel" : "niedrig",
    verdict: `${condition}: ${round(likelyTemp, 1)}° im Mittel, ${Math.round(likelyRainProbability * 100)}% Regenrisiko.`,
    risk: riskChips(likelyRainProbability, likelyRainMm, confidence.overall),
    advice: adviceChips(likelyRainProbability, likelyRainMm),
    temperature_adjustment_c: round(shift, 1),
    rain_adjustment_points: round(likelyRainProbability - modelRainProbability, 2),
  };
  return {
    date: openweather.date,
    openweather,
    open_meteo: om,
    model_consensus: {
      t_mean: round(modelTemp, 1),
      t_min: round(modelMin, 1),
      t_max: round(modelMax, 1),
      rain_probability: round(modelRainProbability, 2),
      rain_mm: round(modelRainMm, 1),
      wind_mean: likely.wind_mean,
    },
    pattern,
    likely,
    challenged: likely,
    rain_signal: rainSignal,
    confidence,
    explanation: {
      summary: explanationSummary(openweather, om, pattern, likely, shift),
      confidence: confidence.explanation,
    },
    math: mathBlock({
      openweather,
      openMeteo: om,
      modelTemp,
      modelRainProbability,
      modelRainMm,
      pattern,
      recentAnomaly,
      recentWeight,
      dwdAdjusted,
      weights,
      likely,
      confidence,
      rainSignal,
    }),
  };
}

function climatePattern(observations, targetDate) {
  const monthDay = targetDate.slice(5);
  const candidates = observations.filter((row) => monthDayDistance(row.month_day, monthDay) <= 7);
  const temps = candidates.map((row) => row.t_mean).filter(Number.isFinite);
  const rain = candidates.map((row) => row.rain_mm).filter(Number.isFinite);
  const wet = rain.filter((value) => value >= 0.1);
  return {
    t_mean: round(mean(temps), 1),
    t_low: round(percentile(temps, 0.1), 1),
    t_high: round(percentile(temps, 0.9), 1),
    rain_probability: round(wet.length / Math.max(1, rain.length), 2),
    rain_mm: round(mean(rain), 1),
    rain_if_wet_mm: round(mean(wet), 1),
    sample_size: candidates.length,
    station_id: observations.station_id,
  };
}

function computeRecentAnomaly(observations) {
  const recent = observations.slice(-14);
  if (recent.length < 5) return 0;
  const anomalies = recent.map((row) => {
    const candidates = observations.filter((item) => monthDayDistance(item.month_day, row.month_day) <= 3);
    return row.t_mean - mean(candidates.map((item) => item.t_mean).filter(Number.isFinite));
  }).filter(Number.isFinite);
  return round(mean(anomalies), 1);
}

function confidenceScore({ modelTemp, openweather, openMeteo, pattern, likelyRainProbability, modelRainProbability, horizon }) {
  const modelTempGap = Number.isFinite(openMeteo?.t_mean) ? Math.abs(openweather.t_mean - openMeteo.t_mean) : 2.5;
  const modelRainGap = Number.isFinite(openMeteo?.rain_probability)
    ? Math.abs(openweather.rain_probability - openMeteo.rain_probability)
    : 0.25;
  const tempGap = Math.abs(modelTemp - pattern.t_mean);
  const dwdRainGap = Math.abs(likelyRainProbability - pattern.rain_probability);
  const components = {
    model_agreement: clampInt(100 - modelTempGap * 12 - modelRainGap * 45, 20, 100),
    climate_fit: clampInt(100 - tempGap * 9, 15, 100),
    rain_fit: clampInt(100 - dwdRainGap * 85, 15, 100),
    data_depth: clampInt((pattern.sample_size / 1500) * 100, 25, 100),
    horizon: clampInt(100 - horizon * 9, 45, 100),
  };
  const overall = clampInt(
    components.model_agreement * 0.28 +
      components.climate_fit * 0.24 +
      components.rain_fit * 0.20 +
      components.data_depth * 0.16 +
      components.horizon * 0.12,
    1,
    99
  );
  return {
    overall,
    components,
    temperature_gap_c: round(tempGap, 1),
    precipitation_gap_points: round(dwdRainGap, 2),
    model_temperature_gap_c: round(modelTempGap, 1),
    model_precipitation_gap_points: round(modelRainGap, 2),
    historical_sample_size: pattern.sample_size,
    explanation: `Confidence ${overall} (${overall >= 78 ? "hoch" : overall >= 58 ? "mittel" : "niedrig"}): Modelle ${components.model_agreement}/100, DWD-Fit ${components.climate_fit}/100, Regen ${components.rain_fit}/100, Daten ${components.data_depth}/100, Horizont ${components.horizon}/100.`,
  };
}

function rainSignalFor(probability, amount, openweather, openMeteo) {
  const modelGap = Number.isFinite(openMeteo?.rain_probability)
    ? Math.abs(openweather.rain_probability - openMeteo.rain_probability)
    : 0.15;
  const score = clampInt(probability * 62 + Math.min(1, amount / 8) * 28 + Math.max(0, 0.3 - modelGap) * 34, 0, 100);
  const level = score >= 70 ? "Regen wahrscheinlich" : score >= 45 ? "Schauer moeglich" : score >= 25 ? "leichtes Signal" : "unauffaellig";
  return {
    score,
    level,
    timing: { wet_window: probability >= 0.45 ? "Regenfenster im Tagesverlauf pruefen" : "kein klares Regenfenster" },
    interpretation: `${level}: ${Math.round(probability * 100)}% Wahrscheinlichkeit, ${round(amount, 1)} mm erwartet. ${modelGap > 0.25 ? "Modelle sind uneinig." : "Modelle liegen brauchbar beieinander."}`,
  };
}

function buildHourlyForecast(owHourly, omHourly, days) {
  return owHourly.map((ow) => {
    const nearest = nearestByTime(omHourly, ow.time);
    const day = days.find((item) => item.date === localDate(new Date(ow.time)));
    const t = Number.isFinite(nearest?.t) ? mean([ow.t, nearest.t]) : ow.t;
    const rainProbability = Number.isFinite(nearest?.rain_probability)
      ? mean([ow.rain_probability, nearest.rain_probability])
      : ow.rain_probability;
    return {
      time: ow.time,
      openweather: ow,
      open_meteo: nearest,
      likely: {
        t: round(t + (day?.likely?.temperature_adjustment_c || 0), 1),
        rain_probability: round(clamp(rainProbability + (day?.likely?.rain_adjustment_points || 0), 0, 1), 2),
        wind: round(mean([ow.wind, nearest?.wind].filter(Number.isFinite)), 1),
      },
    };
  });
}

function enrichRainTiming(days, hourly) {
  for (const day of days) {
    const slots = hourly.filter((slot) => localDate(new Date(slot.time)) === day.date);
    const wet = slots.filter((slot) => (slot.likely?.rain_probability || 0) >= 0.45 || (slot.openweather?.rain_mm || 0) > 0);
    const window = wet.length ? `${hourLabel(wet[0].time)}-${hourLabel(wet[wet.length - 1].time)}` : "kein klares Regenfenster";
    day.rain_signal.timing = { wet_window: window };
    day.likely.rain_timing = { wet_window: window };
  }
}

function buildOverview(label, station, days, current) {
  const today = days[0]?.likely || {};
  const wettest = days.reduce((best, day) => !best || day.likely.rain_probability > best.likely.rain_probability ? day : best, null);
  const weakest = days.reduce((best, day) => !best || day.likely.confidence < best.likely.confidence ? day : best, null);
  const currentText = Number.isFinite(current?.best?.temperature_c)
    ? `Jetzt ${round(current.best.temperature_c, 1)}° (${current.best.source}). `
    : "";
  const todayRange = Number.isFinite(today.t_min) && Number.isFinite(today.t_max)
    ? `${round(today.t_min, 1)}° bis ${round(today.t_max, 1)}°`
    : `${round(today.t_mean, 1)}°`;
  const wettestText = wettest && wettest.rain_signal?.score >= 45
    ? `Auffaelligstes Regensignal: ${formatShortDate(wettest.date)} mit ${Math.round((wettest.likely.rain_probability || 0) * 100)}%.`
    : "Kein klares Regensignal im Zeitraum.";
  return {
    headline: `${label}: ${currentText}Heute ${todayRange}, ${today.condition || "Forecast"}, ${Math.round((today.rain_probability || 0) * 100)}% Regenrisiko`,
    detail: `${wettestText} Unsicherster Tag: ${weakest ? formatShortDate(weakest.date) : "-"} (${weakest?.likely?.confidence || "-"}% Confidence).`,
    station_note: `DWD-Referenz: ${station.name}, ${station.distance_km} km entfernt.`,
    actions: today.rain_probability >= 0.45 ? [`${formatShortDate(days[0].date)}: Regenfenster im Blick behalten`] : ["Keine harte Regenwarnung im Kurzfristfenster"],
    watch: days.filter((day) => day.rain_signal.score >= 45).slice(0, 2).map((day) => `${formatShortDate(day.date)}: ${day.rain_signal.level}`),
  };
}

async function learnedBlendWeights(env, stationId) {
  if (!env.DB) {
    return {
      status: "warming_up",
      cases: 0,
      weights: DEFAULT_BLEND_WEIGHTS,
      summary: "D1 ist nicht gebunden; Startgewichte bleiben aktiv.",
    };
  }
  const row = await env.DB.prepare("SELECT * FROM model_metrics WHERE station_id = ?").bind(stationId).first();
  if (!row || row.cases < MIN_TRAINING_CASES) {
    return {
      status: "warming_up",
      cases: row?.cases || 0,
      weights: DEFAULT_BLEND_WEIGHTS,
      summary: `Lernmodus aktiv, aber erst ${row?.cases || 0} verifizierte Faelle. Startgewichte bleiben aktiv.`,
    };
  }
  return {
    status: "trained",
    cases: row.cases,
    weights: {
      temp_model: row.temp_model_weight,
      rain_probability_model: row.rain_probability_model_weight,
      rain_amount_model: row.rain_amount_model_weight,
    },
    summary: `${row.cases} verifizierte Faelle; Gewichte aus D1-Backtests gegen DWD-Istwerte aktiv.`,
  };
}

async function archiveForecast(env, payload) {
  if (!env.DB) return;
  const snapshotDate = localDate(new Date(payload.source.generated_at));
  const city = payload.location.label;
  const normalized = normalizeCity(city);
  for (const [index, day] of payload.days.entries()) {
    await env.DB.prepare(
      `INSERT OR REPLACE INTO forecast_snapshots(
        normalized_city, city, station_id, station_name, snapshot_date, target_date, horizon_days,
        generated_at, openweather_temp, openmeteo_temp, model_temp, dwd_pattern_temp, likely_temp,
        openweather_rain_probability, openmeteo_rain_probability, likely_rain_probability,
        likely_rain_mm, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      normalized,
      city,
      payload.station.id,
      payload.station.name,
      snapshotDate,
      day.date,
      index,
      payload.source.generated_at,
      day.openweather?.t_mean ?? null,
      day.open_meteo?.t_mean ?? null,
      day.model_consensus?.t_mean ?? null,
      day.pattern?.t_mean ?? null,
      day.likely?.t_mean ?? null,
      day.openweather?.rain_probability ?? null,
      day.open_meteo?.rain_probability ?? null,
      day.likely?.rain_probability ?? null,
      day.likely?.rain_mm ?? null,
      JSON.stringify(compactDay(day))
    ).run();
  }
}

async function verifySnapshots(env, stationId) {
  if (!env.DB) return;
  const rows = await env.DB.prepare(
    "SELECT id, target_date, openweather_temp, openmeteo_temp, likely_temp, openweather_rain_probability, openmeteo_rain_probability, likely_rain_probability FROM forecast_snapshots WHERE station_id = ? AND verified_at IS NULL AND target_date < ? LIMIT 80"
  ).bind(stationId, localDate(new Date())).all();
  const candidates = rows.results || [];
  if (!candidates.length) return;
  const observations = await loadStationObservations(env, stationId);
  const byDate = new Map(observations.map((row) => [row.date, row]));
  for (const row of candidates) {
    const observed = byDate.get(row.target_date);
    if (!observed || !Number.isFinite(observed.t_mean)) continue;
    const rainObserved = (observed.rain_mm || 0) >= 0.1 ? 1 : 0;
    await env.DB.prepare(
      "UPDATE forecast_snapshots SET verified_at = ?, observed_temp = ?, observed_rain_mm = ?, temp_error = ?, rain_brier = ? WHERE id = ?"
    ).bind(
      new Date().toISOString(),
      observed.t_mean,
      observed.rain_mm || 0,
      Math.abs((row.likely_temp ?? row.openweather_temp) - observed.t_mean),
      Math.pow((row.likely_rain_probability ?? 0) - rainObserved, 2),
      row.id
    ).run();
  }
  await refreshMetrics(env, stationId);
}

async function refreshMetrics(env, stationId) {
  const result = await env.DB.prepare(
    `SELECT
      COUNT(*) AS cases,
      AVG(ABS(openweather_temp - observed_temp)) AS mae_owm,
      AVG(ABS(openmeteo_temp - observed_temp)) AS mae_om,
      AVG(ABS(likely_temp - observed_temp)) AS mae_likely,
      AVG((openweather_rain_probability - CASE WHEN observed_rain_mm >= 0.1 THEN 1 ELSE 0 END) * (openweather_rain_probability - CASE WHEN observed_rain_mm >= 0.1 THEN 1 ELSE 0 END)) AS brier_owm,
      AVG((openmeteo_rain_probability - CASE WHEN observed_rain_mm >= 0.1 THEN 1 ELSE 0 END) * (openmeteo_rain_probability - CASE WHEN observed_rain_mm >= 0.1 THEN 1 ELSE 0 END)) AS brier_om,
      AVG((likely_rain_probability - CASE WHEN observed_rain_mm >= 0.1 THEN 1 ELSE 0 END) * (likely_rain_probability - CASE WHEN observed_rain_mm >= 0.1 THEN 1 ELSE 0 END)) AS brier_likely
     FROM forecast_snapshots
     WHERE station_id = ? AND verified_at IS NOT NULL`
  ).bind(stationId).first();
  const cases = result?.cases || 0;
  const tempMae = Number(result?.mae_likely) || 3;
  const rainBrier = Number(result?.brier_likely) || 0.3;
  const tempWeight = clamp(0.88 - Math.min(0.3, tempMae / 18), 0.56, 0.88);
  const rainWeight = clamp(0.84 - Math.min(0.28, rainBrier), 0.52, 0.84);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO model_metrics(
      station_id, cases, temp_model_weight, rain_probability_model_weight, rain_amount_model_weight,
      temp_mae_openweather, temp_mae_openmeteo, temp_mae_likely,
      rain_brier_openweather, rain_brier_openmeteo, rain_brier_likely, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    stationId,
    cases,
    round(tempWeight, 2),
    round(rainWeight, 2),
    round(clamp(rainWeight + 0.03, 0.52, 0.86), 2),
    optionalNumber(result?.mae_owm),
    optionalNumber(result?.mae_om),
    optionalNumber(result?.mae_likely),
    optionalNumber(result?.brier_owm),
    optionalNumber(result?.brier_om),
    optionalNumber(result?.brier_likely),
    new Date().toISOString()
  ).run();
}

async function calibrationStatus(env, stationId) {
  if (!env.DB) return { status: "learning", snapshots: 0, summary: "Training ist nicht dauerhaft gespeichert. Gelernte Gewichte sind deshalb noch nicht aktiv." };
  const snapshot = await env.DB.prepare(
    `SELECT
      COUNT(*) AS rows,
      COUNT(DISTINCT snapshot_date) AS run_days,
      COUNT(DISTINCT normalized_city) AS cities,
      SUM(CASE WHEN verified_at IS NULL THEN 1 ELSE 0 END) AS pending_rows
     FROM forecast_snapshots
     WHERE station_id = ?`
  ).bind(stationId).first();
  const metric = await env.DB.prepare("SELECT * FROM model_metrics WHERE station_id = ?").bind(stationId).first();
  if (metric?.cases) {
    return {
      status: metric.cases >= MIN_TRAINING_CASES ? "active" : "learning",
      snapshots: snapshot?.rows || 0,
      run_days: snapshot?.run_days || 0,
      evaluated_days: metric.cases,
      required_cases: MIN_TRAINING_CASES,
      weights_active: metric.cases >= MIN_TRAINING_CASES,
      next_check: metric.cases >= MIN_TRAINING_CASES
        ? "Training läuft weiter automatisch."
        : "Nächster Check nach DWD-Istwert.",
      summary: metric.cases >= MIN_TRAINING_CASES
        ? `${metric.cases} Tage wurden schon mit echten DWD-Werten verglichen. Gelernte lokale Gewichte sind aktiv.`
        : `${metric.cases} von ${MIN_TRAINING_CASES} nötigen Tagen sind bewertet. Bis dahin nutzt die App vorsichtige Startgewichte.`,
    };
  }
  const rows = snapshot?.rows || 0;
  const runDays = snapshot?.run_days || 0;
  const pendingRows = snapshot?.pending_rows || rows;
  const dayLabel = pendingRows === 1 ? "Tag" : "Tage";
  const runLabel = runDays === 1 ? "automatischer Trainingslauf" : "automatische Trainingsläufe";
  return {
    status: "learning",
    snapshots: rows,
    run_days: runDays,
    evaluated_days: 0,
    required_cases: MIN_TRAINING_CASES,
    weights_active: false,
    next_check: "Nächster Check nach DWD-Istwert.",
    summary: rows
      ? `${runDays} ${runLabel} gestartet. ${pendingRows} ${dayLabel} warten noch auf echte DWD-Messwerte; danach kann die App Treffer und Fehler bewerten.`
      : "Für diese DWD-Station gibt es noch keinen automatischen Trainingslauf.",
  };
}

async function fetchJsonCached(env, key, url, ttl) {
  const cached = await readCache(env, key);
  if (cached) return JSON.parse(cached);
  const response = await fetch(url, { headers: { "user-agent": "a-better-weather/1.0" } });
  if (!response.ok) throw new Error(`Quelle nicht erreichbar (${response.status})`);
  const text = await response.text();
  await writeCache(env, key, text, ttl);
  return JSON.parse(text);
}

async function fetchTextCached(env, key, url, ttl) {
  const cached = await readCache(env, key);
  if (cached) return cached;
  const response = await fetch(url, { headers: { "user-agent": "a-better-weather/1.0" } });
  if (!response.ok) throw new Error(`Quelle nicht erreichbar (${response.status})`);
  const text = await response.text();
  await writeCache(env, key, text, ttl);
  return text;
}

async function fetchLatin1BytesTextCached(env, key, url, ttl) {
  const cached = await readCache(env, key);
  if (cached) return cached;
  const response = await fetch(url, { headers: { "user-agent": "a-better-weather/1.0" } });
  if (!response.ok) throw new Error(`Quelle nicht erreichbar (${response.status})`);
  const text = decodeLatin1(new Uint8Array(await response.arrayBuffer()));
  await writeCache(env, key, text, ttl);
  return text;
}

function decodeLatin1(bytes) {
  let text = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    text += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return text;
}

async function readCache(env, key) {
  if (!env.DB) return null;
  const row = await env.DB.prepare("SELECT data, expires_at FROM api_cache WHERE cache_key = ?").bind(key).first();
  if (!row || row.expires_at < Math.floor(Date.now() / 1000)) return null;
  return row.data;
}

async function writeCache(env, key, data, ttlSeconds) {
  if (!env.DB) return;
  await env.DB.prepare(
    "INSERT OR REPLACE INTO api_cache(cache_key, data, expires_at, created_at) VALUES (?, ?, ?, ?)"
  ).bind(key, data, Math.floor(Date.now() / 1000) + ttlSeconds, new Date().toISOString()).run();
}

function compactForecastPayload(payload) {
  return {
    location: payload.location,
    station: payload.station,
    generated_at: payload.source.generated_at,
    current: payload.current,
    summary: payload.overview,
    feed: `/feed.xml?city=${encodeURIComponent(payload.location.label)}`,
    days: payload.days.map(compactDay),
  };
}

function compactDay(day) {
  if (!day) return null;
  return {
    date: day.date,
    condition: day.likely?.condition,
    temperature_c: day.likely?.t_mean,
    temperature_min_c: day.likely?.t_min,
    temperature_max_c: day.likely?.t_max,
    rain_probability: day.likely?.rain_probability,
    rain_index: day.rain_signal?.score,
    rain_level: day.rain_signal?.level,
    rain_window: day.rain_signal?.timing?.wet_window,
    confidence: day.likely?.confidence,
    confidence_label: day.likely?.label,
    verdict: day.likely?.verdict,
  };
}

function rssFeed(payload, origin) {
  const items = payload.days.map((day) => {
    const likely = day.likely;
    const title = `${day.date}: ${likely.condition}, ${likely.t_mean.toFixed(1)} Grad`;
    const description = `${likely.verdict} Regen: ${Math.round(likely.rain_probability * 100)}%, Index ${day.rain_signal.score}/100 (${day.rain_signal.level}). Confidence ${likely.confidence} (${likely.label}).`;
    return `<item><title>${escapeXml(title)}</title><link>${origin}/?city=${encodeURIComponent(payload.location.label)}</link><guid>${escapeXml(`${payload.location.label}-${day.date}`)}</guid><description>${escapeXml(description)}</description><pubDate>${new Date().toUTCString()}</pubDate></item>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXml(`a better weather: ${payload.location.label}`)}</title><link>${origin}/?city=${encodeURIComponent(payload.location.label)}</link><description>${escapeXml(payload.overview.headline)}</description><lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}</channel></rss>`;
}

function fetchAsset(request, env, assetPath) {
  const url = new URL(request.url);
  url.pathname = assetPath;
  return env.ASSETS.fetch(new Request(url, request));
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
    },
  });
}

function requireOpenWeatherKey(env) {
  if (!env.OPENWEATHER_API_KEY) {
    throw new Error("OPENWEATHER_API_KEY fehlt. Produktivpfad nutzt keine Demo-Forecasts.");
  }
  return env.OPENWEATHER_API_KEY;
}

function publicError(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCity(value) {
  return String(value || "").trim().toLowerCase()
    .replaceAll("ü", "ue")
    .replaceAll("ö", "oe")
    .replaceAll("ä", "ae")
    .replaceAll("ß", "ss");
}

function parseDwdDate(value) {
  if (!value || value.length !== 8) return "";
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function localDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: LOCAL_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function monthDayDistance(a, b) {
  const dayA = dayOfYear(`2024-${a}`);
  const dayB = dayOfYear(`2024-${b}`);
  const diff = Math.abs(dayA - dayB);
  return Math.min(diff, 366 - diff);
}

function dayOfYear(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 0));
  return Math.floor((date - start) / 86400000);
}

function numeric(value) {
  if (value === undefined || value === null || value === "" || value === "-999") return null;
  const number = Number.parseFloat(String(value).replace(",", "."));
  return Number.isFinite(number) ? number : null;
}

function optionalFloat(value) {
  if (value === null || value === "") return null;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

function optionalNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function round(value, decimals = 0) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function clampInt(value, low, high) {
  return Math.round(clamp(value, low, high));
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return sum(clean) / clean.length;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function min(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? Math.min(...clean) : null;
}

function max(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? Math.max(...clean) : null;
}

function percentile(values, p) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const idx = (clean.length - 1) * p;
  const low = Math.floor(idx);
  const high = Math.ceil(idx);
  if (low === high) return clean[low];
  return clean[low] * (high - idx) + clean[high] * (idx - low);
}

function mode(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radius = 6371;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function radians(value) {
  return value * Math.PI / 180;
}

function nearestByTime(items, isoTime) {
  const target = new Date(isoTime).getTime();
  return items.reduce((best, item) => {
    const gap = Math.abs(new Date(item.time).getTime() - target);
    return !best || gap < best.gap ? { ...item, gap } : best;
  }, null);
}

function hourLabel(isoTime) {
  return new Intl.DateTimeFormat("de-DE", { timeZone: LOCAL_TIMEZONE, hour: "2-digit" }).format(new Date(isoTime));
}

function formatShortDate(dateString) {
  return new Intl.DateTimeFormat("de-DE", { weekday: "short", day: "2-digit", month: "2-digit" }).format(new Date(`${dateString}T12:00:00Z`));
}

function weatherCodeText(code) {
  if (code === 0) return "Sonne";
  if ([1, 2, 3].includes(code)) return "Sonne/Wolken";
  if ([45, 48].includes(code)) return "Nebel";
  if ([51, 53, 55, 56, 57].includes(code)) return "Nieselregen";
  if ([61, 63, 65, 66, 67].includes(code)) return "Regen";
  if ([71, 73, 75, 77].includes(code)) return "Schnee";
  if ([80, 81, 82].includes(code)) return "Schauer";
  if ([95, 96, 99].includes(code)) return "Gewitter";
  return "Wolkig";
}

function conditionText(probability, amount, temp, owText, omText) {
  if (probability >= 0.7 || amount >= 5) return "Regen wahrscheinlich";
  if (probability >= 0.45 || amount >= 1.5) return "Schauer moeglich";
  if (probability <= 0.18 && temp >= 22) return "eher freundlich";
  return mode([owText, omText].filter(Boolean)) || "wechselhaft";
}

function riskChips(probability, amount, confidence) {
  const chips = [];
  if (probability >= 0.55) chips.push("Regenfenster im Blick behalten");
  if (amount >= 6) chips.push("kraeftiger Regen moeglich");
  if (confidence < 58) chips.push("unsicherer Forecast");
  return chips;
}

function adviceChips(probability, amount) {
  const chips = [];
  if (probability >= 0.45) chips.push("Regenjacke einplanen");
  if (amount < 1 && probability < 0.35) chips.push("unauffaellig");
  return chips;
}

function explanationSummary(openweather, openMeteo, pattern, likely, shift) {
  const direction = shift > 0.4 ? "waermer" : shift < -0.4 ? "kuehler" : "nahe am Modellmittel";
  const omPart = openMeteo ? `Open-Meteo liegt bei ${openMeteo.t_mean}°` : "Open-Meteo ohne Tageswert";
  return `OpenWeather ${openweather.t_mean}°, ${omPart}; DWD-Muster ${pattern.t_low}° bis ${pattern.t_high}°. Der gelernte Blend zieht den Forecast ${direction} auf ${likely.t_mean}°.`;
}

function mathBlock({ openweather, openMeteo, modelTemp, modelRainProbability, modelRainMm, pattern, recentAnomaly, recentWeight, dwdAdjusted, weights, likely, confidence, rainSignal }) {
  return {
    temperature: {
      formula: "likely = w_model * model_mean + (1 - w_model) * (DWD_mean + recent_anomaly * recent_weight)",
      weight_note: "w_model wird aus verifizierten D1-Backtests je DWD-Station gelernt; bis genug Faelle vorliegen gelten Startgewichte.",
      openweather_c: openweather.t_mean,
      open_meteo_c: openMeteo?.t_mean,
      model_mean_c: round(modelTemp, 1),
      dwd_historical_mean_c: pattern.t_mean,
      recent_anomaly_c: recentAnomaly,
      recent_weight: recentWeight,
      dwd_adjusted_pattern_c: round(dwdAdjusted, 1),
      model_weight: weights.temp_model,
      dwd_weight: round(1 - weights.temp_model, 2),
      likely_c: likely.t_mean,
    },
    rain: {
      formula: "likely_rain = w_rain * model_probability + (1 - w_rain) * DWD_wet_day_frequency",
      weight_note: "Regen wird gegen Treffer/Nichttreffer per Brier Score bewertet und danach lokal nachjustiert.",
      openweather_probability: openweather.rain_probability,
      open_meteo_probability: openMeteo?.rain_probability,
      model_probability: round(modelRainProbability, 2),
      dwd_probability: pattern.rain_probability,
      likely_probability: likely.rain_probability,
      openweather_mm: openweather.rain_mm,
      open_meteo_mm: openMeteo?.rain_mm,
      dwd_expected_mm: pattern.rain_mm,
      dwd_if_wet_mm: pattern.rain_if_wet_mm,
      likely_mm: likely.rain_mm,
      score: rainSignal.score,
    },
    confidence: {
      formula: "0.28*Modelle + 0.24*DWD-Fit + 0.20*Regen-Fit + 0.16*Daten + 0.12*Horizont",
      weight_note: "Confidence ist kein Wetterereignis-Prozentwert, sondern ein Kalibrierungs-/Vertrauensscore fuer diesen Forecast.",
      overall: confidence.overall,
      components: confidence.components,
      temperature_gap_c: confidence.temperature_gap_c,
      dwd_rain_gap_points: confidence.precipitation_gap_points,
      model_temperature_gap_c: confidence.model_temperature_gap_c,
      model_rain_gap_points: confidence.model_precipitation_gap_points,
      sample_size: confidence.historical_sample_size,
    },
  };
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
