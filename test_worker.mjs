import assert from "node:assert/strict";
import test from "node:test";

import worker from "./src/worker.mjs";


test("learning cards stay snapshot-only when today's snapshot is missing", async (t) => {
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
  assert.equal(payload.errors.length, 1);
  assert.equal(payload.errors[0].city, "Berlin");
  assert.match(payload.errors[0].error, /kein Trainings-Snapshot/);
  assert.equal(outboundRequests, 0);
});
