import type { Session } from "next-auth";

import {
  enabledMessageActions, readAssistantPresentation, rememberAssistantPresentation,
} from "../assistant-presentation";

const options = {
  version: "1.0" as const,
  messageActions: [
    { id: "flag-answer", label: "Flag answer", icon: "flag" as const, path: "/api/example/actions/flag" },
    { id: "mark", label: "Mark", icon: "check" as const, path: "/api/example/actions/mark" },
  ],
};
const session = { sub: "primary-subject", user: { email: "primary@example.test" } } as Session;
const configuration = {
  version: "1.0" as const, visible: true, messageActions: { mark: { visible: true } },
};

beforeEach(() => window.localStorage.clear());

describe("enabledMessageActions", () => {
  it("returns only declared actions the app marked visible", () => {
    expect(enabledMessageActions(options, configuration).map(a => a.id)).toEqual(["mark"]);
  });

  it.each([
    ["no configuration", undefined],
    ["no visibility map", { version: "1.0" as const, visible: true }],
    ["an explicit false", { version: "1.0" as const, visible: true, messageActions: { mark: { visible: false } } }],
    ["an id that was never declared", { version: "1.0" as const, visible: true, messageActions: { other: { visible: true } } }],
  ])("hides everything for %s", (_name, config) => {
    expect(enabledMessageActions(options, config)).toEqual([]);
  });

  it("returns nothing when the app declared no actions or options are missing", () => {
    expect(enabledMessageActions({ version: "1.0" }, configuration)).toEqual([]);
    expect(enabledMessageActions(undefined, configuration)).toEqual([]);
  });
});

describe("remembered presentation", () => {
  it("never stores per-user action visibility", () => {
    rememberAssistantPresentation("example-app", "example-agent", session, configuration, options);
    const stored = window.localStorage.getItem(window.localStorage.key(0)!)!;
    expect(stored).toContain('"visible":true');
    expect(stored).not.toContain("messageActions");
    expect(stored).not.toContain("mark");
  });

  it("does not restore visibility another tab remembered", () => {
    rememberAssistantPresentation("example-app", "example-agent", session, configuration, options);
    const restored = readAssistantPresentation("example-app", "example-agent", session, options);
    expect(restored).toEqual({ version: "1.0", visible: true });
    expect(enabledMessageActions(options, restored)).toEqual([]);
  });

  it("strips visibility even from an entry written by an older build", () => {
    rememberAssistantPresentation("example-app", "example-agent", session, { version: "1.0", visible: true }, options);
    const key = window.localStorage.key(0)!;
    window.localStorage.setItem(key, JSON.stringify({ at: Date.now(), configuration }));
    const restored = readAssistantPresentation("example-app", "example-agent", session, options);
    expect(restored).not.toHaveProperty("messageActions");
  });
});
