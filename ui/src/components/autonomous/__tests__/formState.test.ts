// Copyright CAIPE Contributors (https://caipe.io)
// SPDX-License-Identifier: Apache-2.0

import type { AutonomousTask } from "../types";
import { EMPTY_FORM, fromFormState, summarizeTrigger, toFormState } from "../formState";

describe("formState.toFormState", () => {
  it("returns a blank form when task is null", () => {
    expect(toFormState(null)).toEqual(EMPTY_FORM);
  });

  it("maps a cron task to form fields", () => {
    const task: AutonomousTask = {
      id: "nightly",
      name: "Nightly",
      description: "desc",
      agent: "github",
      prompt: "summarise",
      llm_provider: "anthropic",
      trigger: { type: "cron", schedule: "0 0 * * *" },
      enabled: false,
    };
    expect(toFormState(task)).toEqual(
      expect.objectContaining({
        id: "nightly",
        triggerType: "cron",
        cronSchedule: "0 0 * * *",
        enabled: false,
      }),
    );
  });

  it("maps an interval task to form fields", () => {
    const task: AutonomousTask = {
      id: "every_15",
      name: "N",
      agent: null,
      prompt: "p",
      trigger: { type: "interval", seconds: null, minutes: 15, hours: null },
      enabled: true,
    };
    expect(toFormState(task)).toEqual(
      expect.objectContaining({
        triggerType: "interval",
        intervalSeconds: "",
        intervalMinutes: "15",
        intervalHours: "",
      }),
    );
  });

  it("maps webhook provider and leaves secret blank even when has_secret=true on the server", () => {
    const task: AutonomousTask = {
      id: "hook",
      name: "N",
      agent: null,
      prompt: "p",
      trigger: { type: "webhook", provider: "jira", has_secret: true },
      enabled: true,
    };
    expect(toFormState(task)).toEqual(
      expect.objectContaining({
        webhookProvider: "jira",
        webhookSecret: "",
      }),
    );
  });
});

describe("formState.fromFormState", () => {
  const base = {
    ...EMPTY_FORM,
    id: "my_task",
    name: "My task",
    prompt: "do thing",
  };

  it("requires name and prompt", () => {
    expect(fromFormState({ ...base, name: "" })).toEqual({ error: expect.stringMatching(/Name/) });
    expect(fromFormState({ ...base, prompt: "" })).toEqual({ error: expect.stringMatching(/Prompt/) });
  });

  it("passes an empty id straight through on create", () => {
    // The server generates the id and ignores whatever we send; an empty
    // string keeps the wire shape stable without loosening the TS type.
    const result = fromFormState({ ...base, id: "" });
    expect("error" in result).toBe(false);
    expect((result as { task: { id: string } }).task.id).toBe("");
  });

  it("preserves an existing id on edit", () => {
    const result = fromFormState({ ...base, id: "daily-report-a3f9" });
    expect((result as { task: { id: string } }).task.id).toBe("daily-report-a3f9");
  });

  it("parses a valid cron task", () => {
    const result = fromFormState({ ...base, triggerType: "cron", cronSchedule: "0 9 * * *" });
    expect(result).toEqual({
      task: expect.objectContaining({
        id: "my_task",
        trigger: { type: "cron", schedule: "0 9 * * *" },
      }),
    });
  });

  it("rejects empty cron schedule", () => {
    expect(
      fromFormState({ ...base, triggerType: "cron", cronSchedule: "   " }),
    ).toEqual({ error: expect.stringMatching(/Cron schedule/) });
  });

  it("requires at least one interval field", () => {
    expect(fromFormState({ ...base, triggerType: "interval" })).toEqual({
      error: expect.stringMatching(/at least one/),
    });
  });

  it("rejects non-positive / non-integer interval values", () => {
    expect(
      fromFormState({ ...base, triggerType: "interval", intervalMinutes: "-5" }),
    ).toEqual({ error: expect.stringMatching(/positive whole numbers/) });
    expect(
      fromFormState({ ...base, triggerType: "interval", intervalMinutes: "1.5" }),
    ).toEqual({ error: expect.stringMatching(/positive whole numbers/) });
  });

  it("rejects intervals below the default 30-minute minimum", () => {
    expect(
      fromFormState({ ...base, triggerType: "interval", intervalMinutes: "29" }),
    ).toEqual({ error: "Interval must be at least 30 minutes." });
  });

  it("accepts the configured interval minimum", () => {
    const result = fromFormState(
      { ...base, triggerType: "interval", intervalMinutes: "10" },
      600,
    );
    expect(result).toEqual({
      task: expect.objectContaining({
        trigger: { type: "interval", seconds: null, minutes: 10, hours: null },
      }),
    });
  });

  it("maps webhook with blank secret to null for server generation/preservation", () => {
    const result = fromFormState({ ...base, triggerType: "webhook", webhookSecret: "   " });
    expect(result).toEqual({
      task: expect.objectContaining({
        trigger: { type: "webhook", provider: "github", secret: null },
      }),
    });
  });

  it("maps webhook provider and secret verbatim", () => {
    const result = fromFormState({
      ...base,
      triggerType: "webhook",
      webhookProvider: "jira",
      webhookSecret: "s3cret",
    });
    expect(result).toEqual({
      task: expect.objectContaining({
        trigger: { type: "webhook", provider: "jira", secret: "s3cret" },
      }),
    });
  });

  it("converts empty agent to null", () => {
    const result = fromFormState({ ...base, triggerType: "cron", cronSchedule: "0 9 * * *", agent: "" });
    expect(result).toEqual({ task: expect.objectContaining({ agent: null }) });
  });
});

describe("formState.summarizeTrigger", () => {
  it("summarises cron", () => {
    expect(summarizeTrigger({ type: "cron", schedule: "0 9 * * *" })).toBe("Cron: 0 9 * * *");
  });
  it("summarises interval", () => {
    expect(
      summarizeTrigger({ type: "interval", seconds: null, minutes: 15, hours: 2 }),
    ).toBe("Every 2h 15m");
  });
  it("summarises webhook with/without secret", () => {
    expect(summarizeTrigger({ type: "webhook", provider: "jira", has_secret: true })).toBe("Webhook: jira (signed)");
    expect(summarizeTrigger({ type: "webhook", has_secret: false })).toBe("Webhook: github");
  });
});

// Bug fix: dynamic_agent_id was lost on form round-trip, silently
// demoting custom-agent tasks to supervisor tasks on edit. These
// tests pin the round-trip contract so any future regression of
// the converters trips a CI failure rather than a Mongo edit that
// quietly reroutes scheduled work.
describe("formState dynamic_agent_id round-trip", () => {
  it("toFormState surfaces dynamic_agent_id from the wire model", () => {
    const task: AutonomousTask = {
      id: "custom-task",
      name: "Custom Task",
      agent: null,
      dynamic_agent_id: "agent-my-pr-reviewer",
      prompt: "review",
      trigger: { type: "cron", schedule: "0 9 * * *" },
      enabled: true,
    };
    expect(toFormState(task).dynamic_agent_id).toBe("agent-my-pr-reviewer");
  });

  it("toFormState defaults to null when dynamic_agent_id is absent", () => {
    const task: AutonomousTask = {
      id: "supervisor-task",
      name: "Supervisor Task",
      agent: "github",
      prompt: "list prs",
      trigger: { type: "cron", schedule: "0 9 * * *" },
      enabled: true,
    };
    expect(toFormState(task).dynamic_agent_id).toBeNull();
  });

  it("fromFormState preserves dynamic_agent_id on save", () => {
    const form = {
      ...EMPTY_FORM,
      id: "custom-task",
      name: "Custom Task",
      prompt: "review",
      dynamic_agent_id: "agent-my-pr-reviewer",
      triggerType: "cron" as const,
      cronSchedule: "0 9 * * *",
    };
    const result = fromFormState(form);
    expect(result).toEqual({
      task: expect.objectContaining({
        dynamic_agent_id: "agent-my-pr-reviewer",
      }),
    });
  });

  it("full round-trip: load custom-agent task, edit unrelated field, save - dynamic_agent_id survives", () => {
    // Reproduction of the exact bot-flagged regression:
    // user opens an existing custom-agent task in the standalone
    // /autonomous form, changes only the prompt, and saves. The
    // dynamic_agent_id MUST survive untouched so the task continues
    // to route through the dynamic-agents service rather than being
    // silently demoted to the supervisor.
    const original: AutonomousTask = {
      id: "custom-task",
      name: "Custom Task",
      agent: null,
      dynamic_agent_id: "agent-my-pr-reviewer",
      prompt: "old prompt",
      trigger: { type: "cron", schedule: "0 9 * * *" },
      enabled: true,
    };
    const form = toFormState(original);
    form.prompt = "new prompt";
    const result = fromFormState(form);
    expect(result).toEqual({
      task: expect.objectContaining({
        dynamic_agent_id: "agent-my-pr-reviewer",
        prompt: "new prompt",
        agent: null,
      }),
    });
  });
});
