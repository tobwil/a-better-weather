import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import worker from "./src/worker.mjs";


test("learning cards defer missing snapshots without starting outbound requests", async (t) => {
  const originalFetch = globalThis.fetch;
  let outboundRequests = 0;
  globalThis.fetch = async () => {
    outboundRequests += 1;
    throw new Error("Unexpected outbound request");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const database = {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async all() {
          if (sql.includes("SELECT city FROM learning_cities")) {
            return { results: [{ city: "Berlin" }] };
          }
          return { results: [] };
        },
        async first() {
          return null;
        },
      };
    },
  };

  const response = await worker.fetch(
    new Request("https://weather.example/api/learning/cards"),
    { DB: database, DEFAULT_LEARNING_CITIES: "Berlin" },
    {},
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.deepEqual(payload.cards, []);
  assert.deepEqual(payload.errors, []);
  assert.deepEqual(payload.missing_cities, ["Berlin"]);
  assert.equal(outboundRequests, 0);
});

test("default dashboard and training set excludes Nuernberg and Eichstaett", async () => {
  const response = await worker.fetch(
    new Request("https://weather.example/api/learning/cards"),
    {},
    {},
  );
  const payload = await response.json();

  assert.deepEqual(payload.cities, ["Berlin", "Muenchen", "Hamburg", "Coburg"]);
  assert.deepEqual(payload.missing_cities, payload.cities);
});

test("interactive forecast uses model fallback instead of downloading a cold DWD archive", async (t) => {
  const originalFetch = globalThis.fetch;
  const outboundUrls = [];
  const forecastTime = Math.floor(new Date("2026-07-18T12:00:00Z").getTime() / 1000);
  globalThis.fetch = async (input) => {
    const url = String(input);
    outboundUrls.push(url);
    if (url.includes("/data/2.5/forecast")) {
      return Response.json({
        list: [{
          dt: forecastTime,
          main: { temp: 22, temp_min: 18, temp_max: 24 },
          pop: 0.2,
          rain: {},
          wind: { speed: 3 },
          weather: [{ description: "klar" }],
        }],
      });
    }
    if (url.includes("/data/2.5/weather")) {
      return Response.json({
        dt: forecastTime,
        main: { temp: 21, feels_like: 21 },
        wind: { speed: 2 },
        weather: [{ description: "klar" }],
      });
    }
    if (url.includes("api.open-meteo.com")) {
      return Response.json({
        current: { temperature_2m: 21, weather_code: 0, wind_speed_10m: 7.2, time: "2026-07-18T14:00" },
        hourly: {
          time: ["2026-07-18T12:00", "2026-07-18T13:00", "2026-07-18T14:00"],
          temperature_2m: [21, 22, 23],
          precipitation_probability: [10, 20, 10],
          precipitation: [0, 0, 0],
          weather_code: [0, 0, 0],
          wind_speed_10m: [7.2, 7.2, 7.2],
        },
      });
    }
    throw new Error(`Unexpected outbound request: ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const stationLine = [
    "00433",
    " ",
    "19480101",
    " ",
    "20991231",
    " ",
    String(48).padStart(14),
    " ",
    "52.4670".padStart(10),
    " ",
    "13.4020".padStart(10),
    " ",
    "Berlin-Tempelhof".padEnd(41),
    "Berlin",
  ].join("");
  const stationData = `header\nheader\n${stationLine}\n`;
  let observationCacheReads = 0;
  const database = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) {
          values = args;
          return this;
        },
        async first() {
          if (sql.includes("FROM api_cache") && values[0] === "dwd:stations:latin1:v3") {
            return { data: stationData, expires_at: 4_102_444_800 };
          }
          if (sql.includes("FROM api_cache") && values[0] === "dwd:observations:00433") {
            observationCacheReads += 1;
            return { data: "this large cache must never be parsed interactively", expires_at: 4_102_444_800 };
          }
          if (sql.includes("COUNT(*) AS rows")) {
            return { rows: 0, run_days: 0, cities: 0, pending_rows: 0 };
          }
          return null;
        },
        async run() {
          return { success: true };
        },
      };
    },
  };

  const response = await worker.fetch(
    new Request("https://weather.example/api/forecast?city=Berlin"),
    { DB: database, OPENWEATHER_API_KEY: "test" },
    {},
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.source.observations, 0);
  assert.equal(payload.source.weighting_status, "start_model");
  assert.equal(payload.days[0].pattern.source, "model_fallback");
  assert.equal(observationCacheReads, 0);
  assert.equal(outboundUrls.some((url) => url.includes("opendata.dwd.de")), false);
});

test("learning card renderer reads model state from the card", async () => {
  const appSource = await readFile(new URL("./static/app.js", import.meta.url), "utf8");
  const rendererStart = appSource.indexOf("function renderLearningCard(card)");
  const insightStart = appSource.indexOf("function learningCardInsight(card)");
  const insightEnd = appSource.indexOf("\nfunction ", insightStart + 1);
  assert.notEqual(rendererStart, -1);
  assert.notEqual(insightStart, -1);
  assert.notEqual(insightEnd, -1);

  const rendererSource = appSource.slice(rendererStart, insightStart);
  const insightSource = appSource.slice(insightStart, insightEnd);
  const renderLearningCard = new Function(
    "escapeHtml",
    "formatTemp",
    "formatTime",
    `${rendererSource}\n${insightSource}\nreturn renderLearningCard;`,
  )(
    (value) => String(value ?? ""),
    (value) => `${value}°`,
    () => "20:00",
  );

  const html = renderLearningCard({
    city: "Berlin",
    location: { label: "Berlin" },
    current: { best: { temperature_c: 22, description: "klar", source: "Test" } },
    today: { temperature_c: 21, rain_probability: 0.1, confidence: 80 },
    learning: { status: "warming_up", cases: 10 },
  });

  assert.match(html, /Startgewichte/);
  assert.match(html, />10</);
});
