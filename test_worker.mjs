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
