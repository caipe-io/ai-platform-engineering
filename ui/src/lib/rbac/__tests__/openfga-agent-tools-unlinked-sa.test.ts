// Unit tests for `buildAgentRelationshipTupleDiff` focused on the
// `unlinkedServiceAccountSub` plumbing (D4S-5378): when an agent is shared
// with Everyone, the unlinked service account (used for Slack/Webex
// callers with no linked user identity) should also gain `can_use`, since
// the `user:*` wildcard only matches `user:`-typed subjects, never
// `service_account:` ones.

import { buildAgentRelationshipTupleDiff } from "../openfga-agent-tools";

describe("buildAgentRelationshipTupleDiff: unlinkedServiceAccountSub", () => {
  const baseInput = {
    agentId: "agent-test",
    previousAllowedTools: {},
    nextAllowedTools: {},
    ownerSubject: "alice-sub",
    organizationId: "caipe",
    ownerTeamSlug: "platform",
  } as const;

  it("writes the unlinked SA grant alongside user:* when sharing with Everyone", () => {
    const diff = buildAgentRelationshipTupleDiff({
      ...baseInput,
      globalUserAccess: true,
      unlinkedServiceAccountSub: "sa-unlinked-123",
    });

    expect(diff.writes).toEqual(
      expect.arrayContaining([
        { user: "user:*", relation: "user", object: "agent:agent-test" },
        { user: "service_account:sa-unlinked-123", relation: "user", object: "agent:agent-test" },
      ]),
    );
  });

  it("deletes the unlinked SA grant alongside user:* when demoted from Everyone", () => {
    const diff = buildAgentRelationshipTupleDiff({
      ...baseInput,
      globalUserAccess: false,
      previousGlobalUserAccess: true,
      unlinkedServiceAccountSub: "sa-unlinked-123",
    });

    expect(diff.deletes).toEqual(
      expect.arrayContaining([
        { user: "user:*", relation: "user", object: "agent:agent-test" },
        { user: "service_account:sa-unlinked-123", relation: "user", object: "agent:agent-test" },
      ]),
    );
  });

  it("only writes user:* when the unlinked SA sub is null (not bootstrapped)", () => {
    const diff = buildAgentRelationshipTupleDiff({
      ...baseInput,
      globalUserAccess: true,
      unlinkedServiceAccountSub: null,
    });

    expect(diff.writes).toEqual(
      expect.arrayContaining([{ user: "user:*", relation: "user", object: "agent:agent-test" }]),
    );
    expect(diff.writes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ user: expect.stringMatching(/^service_account:/) })]),
    );
  });

  it("only writes user:* when unlinkedServiceAccountSub is omitted entirely", () => {
    const diff = buildAgentRelationshipTupleDiff({
      ...baseInput,
      globalUserAccess: true,
    });

    expect(diff.writes).toEqual(
      expect.arrayContaining([{ user: "user:*", relation: "user", object: "agent:agent-test" }]),
    );
    expect(diff.writes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ user: expect.stringMatching(/^service_account:/) })]),
    );
  });

  it("emits neither user:* nor the unlinked SA grant when never global", () => {
    const diff = buildAgentRelationshipTupleDiff({
      ...baseInput,
      globalUserAccess: false,
      previousGlobalUserAccess: false,
      unlinkedServiceAccountSub: "sa-unlinked-123",
    });

    expect(diff.writes).not.toEqual(expect.arrayContaining([expect.objectContaining({ user: "user:*" })]));
    expect(diff.deletes).not.toEqual(expect.arrayContaining([expect.objectContaining({ user: "user:*" })]));
    expect(diff.writes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ user: expect.stringMatching(/^service_account:/) })]),
    );
    expect(diff.deletes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ user: expect.stringMatching(/^service_account:/) })]),
    );
  });

  it("skips a malformed unlinked SA sub without corrupting the rest of the diff", () => {
    const diff = buildAgentRelationshipTupleDiff({
      ...baseInput,
      globalUserAccess: true,
      unlinkedServiceAccountSub: "bad sub with spaces!",
    });

    expect(diff.writes).toEqual(
      expect.arrayContaining([{ user: "user:*", relation: "user", object: "agent:agent-test" }]),
    );
    expect(diff.writes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ user: expect.stringMatching(/^service_account:/) })]),
    );
  });

  it("never grants the unlinked SA anything beyond the use-only `user` relation", () => {
    const diff = buildAgentRelationshipTupleDiff({
      ...baseInput,
      globalUserAccess: true,
      unlinkedServiceAccountSub: "sa-unlinked-123",
    });

    const unlinkedTuples = diff.writes.filter((t) => t.user === "service_account:sa-unlinked-123");
    expect(unlinkedTuples).toEqual([
      { user: "service_account:sa-unlinked-123", relation: "user", object: "agent:agent-test" },
    ]);
  });

  describe("explicit admin grants are durable across visibility demotion", () => {
    it("preserves the unlinked SA grant on demotion when the grant is explicit", () => {
      const diff = buildAgentRelationshipTupleDiff({
        ...baseInput,
        globalUserAccess: false,
        previousGlobalUserAccess: true,
        unlinkedServiceAccountSub: "sa-unlinked-123",
        unlinkedGrantIsExplicit: true,
      });

      // user:* still revoked (no explicit equivalent), unlinked SA preserved.
      expect(diff.deletes).toEqual(
        expect.arrayContaining([{ user: "user:*", relation: "user", object: "agent:agent-test" }]),
      );
      expect(diff.deletes).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ user: "service_account:sa-unlinked-123" }),
        ]),
      );
    });

    it("re-asserts (self-heals) an explicit grant for a non-global agent", () => {
      const diff = buildAgentRelationshipTupleDiff({
        ...baseInput,
        globalUserAccess: false,
        previousGlobalUserAccess: false,
        unlinkedServiceAccountSub: "sa-unlinked-123",
        unlinkedGrantIsExplicit: true,
      });

      expect(diff.writes).toEqual(
        expect.arrayContaining([
          { user: "service_account:sa-unlinked-123", relation: "user", object: "agent:agent-test" },
        ]),
      );
      // A non-global agent never writes user:*.
      expect(diff.writes).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ user: "user:*" })]),
      );
    });

    it("still deletes the unlinked SA grant on demotion when NOT explicit (demotion wins)", () => {
      const diff = buildAgentRelationshipTupleDiff({
        ...baseInput,
        globalUserAccess: false,
        previousGlobalUserAccess: true,
        unlinkedServiceAccountSub: "sa-unlinked-123",
        unlinkedGrantIsExplicit: false,
      });

      expect(diff.deletes).toEqual(
        expect.arrayContaining([
          { user: "user:*", relation: "user", object: "agent:agent-test" },
          { user: "service_account:sa-unlinked-123", relation: "user", object: "agent:agent-test" },
        ]),
      );
    });

    it("does not self-heal an explicit grant when the sub is null", () => {
      const diff = buildAgentRelationshipTupleDiff({
        ...baseInput,
        globalUserAccess: false,
        previousGlobalUserAccess: false,
        unlinkedServiceAccountSub: null,
        unlinkedGrantIsExplicit: true,
      });

      expect(diff.writes).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ user: expect.stringMatching(/^service_account:/) }),
        ]),
      );
    });
  });
});
