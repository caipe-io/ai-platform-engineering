/** @jest-environment node */
import { translateCanonicalStream } from "../harness-gateway";
import type { HarnessRun } from "@/types/harness-engine";

jest.mock("@/lib/mongodb", () => ({ getCollection: jest.fn() }));

it("replays only undelivered subframes after disconnecting between message start and content", async () => {
  const canonical = 'id: 1\nevent: run.started\ndata: {}\n\nid: 2\nevent: content.delta\ndata: {"text":"example"}\n\nid: 3\nevent: run.completed\ndata: {}\n\n';
  const run = { run_id: "example", conversation_id: "example" } as HarnessRun;
  const initial = await new Response(translateCanonicalStream(new Response(canonical).body!, run, "agui")).text();
  expect(initial).toContain("id: 2.0\nevent: TEXT_MESSAGE_START");
  expect(initial).toContain("id: 2.1\nevent: TEXT_MESSAGE_CONTENT");
  const recovered = await new Response(translateCanonicalStream(new Response(canonical).body!, run, "agui", "2.0")).text();
  expect(recovered).not.toContain("TEXT_MESSAGE_START");
  expect(recovered).toContain("TEXT_MESSAGE_CONTENT");
  const afterContent = await new Response(translateCanonicalStream(new Response(canonical).body!, run, "agui", "2.1")).text();
  expect(afterContent).not.toContain("TEXT_MESSAGE_CONTENT");
  expect(afterContent).toContain("TEXT_MESSAGE_END");
  expect(afterContent).toContain("RUN_FINISHED");
});
