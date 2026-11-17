#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Creates the OpenFGA store and loads the CAIPE authorization model. Safe to run again:
// it reuses an existing store and only loads the model when the store has none.
//
// The host asks OpenFGA for a user's teams when it lists agents, and the dev auth bypass does not
// cover that call. An empty, in-memory OpenFGA with the real model is enough for the demo.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = (process.env.OPENFGA_HTTP ?? "http://127.0.0.1:18080").replace(/\/+$/, "");
const storeName = process.env.OPENFGA_STORE_NAME ?? "caipe-openfga";
const modelPath = process.env.OPENFGA_MODEL_PATH ??
  fileURLToPath(new URL("../../../../charts/ai-platform-engineering/charts/openfga/authorization-model.json", import.meta.url));
const WAIT_SECONDS = 60;

async function call(path, init) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json" } });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function waitUntilServing() {
  for (let attempt = 0; attempt < WAIT_SECONDS; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`OpenFGA at ${base} did not become healthy within ${WAIT_SECONDS}s`);
}

await waitUntilServing();
const { stores = [] } = await call("/stores");
const store = stores.find((candidate) => candidate.name === storeName) ??
  await call("/stores", { method: "POST", body: JSON.stringify({ name: storeName }) });
console.log(`store ${storeName}: ${store.id}`);

const { authorization_models: models = [] } = await call(`/stores/${store.id}/authorization-models?page_size=1`);
if (models.length) {
  console.log(`authorization model already loaded: ${models[0].id}`);
} else {
  const loaded = await call(`/stores/${store.id}/authorization-models`, { method: "POST", body: readFileSync(modelPath, "utf8") });
  console.log(`authorization model loaded: ${loaded.authorization_model_id}`);
}
