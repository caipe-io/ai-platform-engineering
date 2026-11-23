// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { createActionsDemoServer } from "../server.mjs";
import { bearer, mintTestToken, TEST_SECRET } from "./helpers.mjs";

const call = {
  conversation_id: "example-conversation", message_id: "example-message",
  turn_id: "example-turn", action_id: "flag-answer",
};

async function withServer(run, options = {}) {
  const server = createActionsDemoServer({ secret: TEST_SECRET, issuer: "caipe-agentic-apps", ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(origin, { headers: { ...bearer(mintTestToken()), "content-type": "application/json" } });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const post = (origin, path, headers, body) =>
  fetch(`${origin}${path}`, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual" });

test("leaves health open and authenticates every other route", async () => {
  await withServer(async (origin) => {
    assert.equal((await fetch(`${origin}/healthz`)).status, 200);
    for (const path of ["/", "/assets/app.js", "/api/assistant/actions/received"]) {
      const response = await fetch(`${origin}${path}`);
      assert.equal(response.status, 401, path);
      assert.match(response.headers.get("www-authenticate") ?? "", /agentic-app:actions-demo/);
    }
    assert.equal((await post(origin, "/api/assistant/stream", {}, {})).status, 401);
  });
});

test("requires the write scope for posts and the read scope for reads", async () => {
  await withServer(async (origin) => {
    const readOnly = { ...bearer(mintTestToken({ scopes: ["actions-demo:read"] })), "content-type": "application/json" };
    assert.equal((await post(origin, "/api/assistant/actions/flag", readOnly, call)).status, 403);
    const writeOnly = bearer(mintTestToken({ scopes: ["actions-demo:write"] }));
    assert.equal((await fetch(`${origin}/`, { headers: writeOnly })).status, 403);
  });
});

test("serves the page under the host base path with the SDK bridge files", async () => {
  await withServer(async (origin, { headers }) => {
    const page = await fetch(`${origin}/`, { headers });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /data-base-path="\/apps\/actions-demo"/);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    const bridge = await fetch(`${origin}/apps/actions-demo/assets/sdk/iframe-bridge.mjs`, { headers });
    assert.match(await bridge.text(), /createAgenticAppBridge/);
    const options = await fetch(`${origin}/assets/sdk/assistant-options.mjs`, { headers });
    assert.match(await options.text(), /messageActions\.v1/);
  });
});

test("streams one finished answer in the frames the host chat parses", async () => {
  await withServer(async (origin, { headers }) => {
    const response = await post(origin, "/api/assistant/stream", headers, {
      message: "Hello", conversation_id: "example-conversation", agent_id: "actions-demo-assistant",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const frames = (await response.text()).split("\n\n").filter(Boolean).map((frame) => {
      const [event, data] = frame.split("\n");
      return { event: event.replace("event: ", ""), data: JSON.parse(data.replace("data: ", "")) };
    });
    assert.deepEqual(frames.map((frame) => frame.event), [
      "RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED",
    ]);
    assert.equal(frames[2].data.delta, "Demo answer to: Hello");
    assert.equal(frames.at(-1).data.threadId, "example-conversation");
  });
});

test("rejects a stream request without a message", async () => {
  await withServer(async (origin, { headers }) => {
    assert.equal((await post(origin, "/api/assistant/stream", headers, { conversation_id: "x" })).status, 400);
    const bad = await fetch(`${origin}/api/assistant/stream`, { method: "POST", headers, body: "{" });
    assert.equal(bad.status, 400);
  });
});

test("records an action call with the caller and the stored turn", async () => {
  await withServer(async (origin, { headers }) => {
    const response = await post(origin, "/api/assistant/actions/flag", headers, { ...call, text: "Edited answer" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: "Recorded" });
    const { calls } = await (await fetch(`${origin}/api/assistant/actions/received`, { headers })).json();
    assert.equal(calls.length, 1);
    assert.deepEqual(
      { ...calls[0], receivedAt: undefined },
      {
        receivedAt: undefined, subject: "example-subject", actionId: "flag-answer",
        conversationId: "example-conversation", messageId: "example-message", turnId: "example-turn", text: "Edited answer",
      },
    );
  });
});

test("answers an action without text and checks the action id matches the route", async () => {
  await withServer(async (origin, { headers }) => {
    const ok = await post(origin, "/api/assistant/actions/mark", headers, { ...call, action_id: "mark" });
    assert.equal(ok.status, 200);
    const mismatch = await post(origin, "/api/assistant/actions/mark", headers, call);
    assert.equal(mismatch.status, 400);
    for (const body of [{ ...call, turn_id: undefined }, { ...call, text: 5 }]) {
      assert.equal((await post(origin, "/api/assistant/actions/flag", headers, body)).status, 400);
    }
  });
});

test("answers by the submitted text so each host error path can be tried", async () => {
  await withServer(async (origin, { headers }) => {
    const send = (text) => post(origin, "/api/assistant/actions/flag", headers, { ...call, text });

    const failed = await send("please fail");
    assert.equal(failed.status, 422);
    assert.deepEqual(await failed.json(), { error: "Demo failure", code: "DEMO_FAILURE" });

    assert.equal((await send("expired")).status, 401);

    const html = await send("html");
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") ?? "", /text\/html/);

    const redirect = await send("redirect");
    assert.equal(redirect.status, 302);
    assert.match(redirect.headers.get("location") ?? "", /example\.test/);
  });
});

test("answers a slow call only after the delay", async () => {
  await withServer(async (origin, { headers }) => {
    const started = Date.now();
    const response = await post(origin, "/api/assistant/actions/flag", headers, { ...call, text: "slow" });
    assert.equal(response.status, 200);
    assert.ok(Date.now() - started >= 100);
  }, { slowMs: 120 });
});

test("keeps only the 20 newest calls and bounds the body size", async () => {
  await withServer(async (origin, { headers }) => {
    for (let index = 0; index < 22; index += 1) {
      await post(origin, "/api/assistant/actions/flag", headers, { ...call, message_id: `message-${index}` });
    }
    const { calls } = await (await fetch(`${origin}/api/assistant/actions/received`, { headers })).json();
    assert.equal(calls.length, 20);
    assert.equal(calls[0].messageId, "message-21");

    const tooLarge = await post(origin, "/api/assistant/actions/flag", headers, { ...call, text: "x".repeat(300_000) });
    assert.equal(tooLarge.status, 413);
  });
});

test("returns 404 for unknown routes and 405 for other methods", async () => {
  await withServer(async (origin, { headers }) => {
    assert.equal((await fetch(`${origin}/nope`, { headers })).status, 404);
    assert.equal((await post(origin, "/api/assistant/nope", headers, {})).status, 404);
    assert.equal((await fetch(`${origin}/`, { method: "DELETE", headers })).status, 405);
  });
});
