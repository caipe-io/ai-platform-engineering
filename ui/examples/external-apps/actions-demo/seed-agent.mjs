#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Creates the placeholder agent the host needs in order to list the demo app's assistant.
// The demo app owns the stream, so the agent has no model, tools or runtime behind it.

import { MongoClient } from "mongodb";

const AGENT_ID = "actions-demo-assistant";
const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";
const database = process.env.MONGODB_DATABASE ?? "caipe";

const client = new MongoClient(uri);
try {
  await client.connect();
  const now = new Date();
  const result = await client.db(database).collection("dynamic_agents").updateOne(
    { _id: AGENT_ID },
    {
      $set: {
        name: "Actions Demo Assistant",
        description: "Placeholder agent for the message actions demo app.",
        system_prompt: "Placeholder. The demo app answers.",
        allowed_tools: {},
        subagents: [],
        skills: [],
        visibility: "global",
        enabled: true,
        is_system: false,
        owner_id: "anonymous-local-dev",
        updated_at: now,
      },
      $setOnInsert: { created_at: now },
    },
    { upsert: true },
  );
  console.log(`${result.upsertedCount ? "Created" : "Updated"} agent ${AGENT_ID} in ${database}.dynamic_agents`);
} finally {
  await client.close();
}
