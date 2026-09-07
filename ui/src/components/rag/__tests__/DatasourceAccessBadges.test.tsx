/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { DatasourceAccessBadges } from "../DatasourceAccessBadges";

describe("DatasourceAccessBadges", () => {
  it("shows the Owner separately from Search teams", () => {
    render(
      <DatasourceAccessBadges
        ownerTeamSlug="management-team"
        searchTeamSlugs={["reader-team", "secondary-team"]}
        detailsKnown
      />,
    );

    expect(screen.getByText("Owner: management-team")).toBeInTheDocument();
    expect(screen.getByText("Search: reader-team +1")).toBeInTheDocument();
    expect(screen.getByTitle("Search: reader-team, secondary-team")).toBeInTheDocument();
  });

  it("shows effective team access without presenting collections as audiences", () => {
    render(
      <DatasourceAccessBadges
        ownerTeamSlug="management-team"
        searchTeamSlugs={[]}
        ragCollections={[
          {
            id: "platform-rag",
            name: "Platform RAG",
            is_platform: true,
            reader_team_slugs: ["everyone"],
          },
        ]}
        detailsKnown
      />,
    );

    expect(screen.getByText("Search: Everyone")).toBeInTheDocument();
    expect(screen.queryByText(/Platform RAG/)).not.toBeInTheDocument();
  });

  it("labels a personal source as personally owned and searchable", () => {
    render(
      <DatasourceAccessBadges
        ownerSubject="test-user"
        ownerDisplayName="test-user@example.com"
        searchTeamSlugs={[]}
        detailsKnown
      />,
    );

    expect(screen.getByText("Owner: test-user@example.com")).toBeInTheDocument();
    expect(screen.getByText("Search: test-user@example.com")).toBeInTheDocument();
  });

  it("includes both the personal owner and shared search teams", () => {
    render(
      <DatasourceAccessBadges
        ownerSubject="test-user"
        ownerDisplayName="test-user@example.com"
        searchTeamSlugs={["reader-team"]}
        detailsKnown
      />,
    );

    expect(screen.getByText("Search: test-user@example.com +1")).toBeInTheDocument();
    expect(screen.getByTitle("Search: test-user@example.com, reader-team")).toBeInTheDocument();
  });

  it("does not expose policy details to a Search-only user", () => {
    render(
      <DatasourceAccessBadges
        detailsKnown={false}
        canReadContent
      />,
    );

    expect(screen.getByText("Owner: Restricted")).toBeInTheDocument();
    expect(screen.getByText("Search: Shared with you")).toBeInTheDocument();
  });

  it("shows the audience waiting for approval", () => {
    render(
      <DatasourceAccessBadges
        ownerSubject="test-user"
        ownerDisplayName="test-user@example.com"
        searchTeamSlugs={[]}
        pendingPublicationRequest={{
          id: "request-primary",
          status: "pending",
          requested_state: { search_team_slugs: ["everyone"] },
          effective_state: { search_team_slugs: [] },
          risk_facts: {
            organization_wide: true,
            target_team_slugs: ["everyone"],
            added_team_slugs: ["everyone"],
            reasons: ["new organization-wide audience"],
          },
          requester: { subject: "test-user" },
          created_at: "2026-01-01T00:00:00.000Z",
        }}
        detailsKnown
      />,
    );

    expect(screen.getByText("Pending: Everyone")).toBeInTheDocument();
    expect(screen.getByTitle("Pending Search: Everyone")).toBeInTheDocument();
  });

  it("shows a company-wide Search removal waiting for approval", () => {
    render(
      <DatasourceAccessBadges
        ownerSubject="test-user"
        ownerDisplayName="test-user@example.com"
        searchTeamSlugs={["everyone"]}
        pendingPublicationRequest={{
          id: "request-removal",
          status: "pending",
          requested_state: { search_team_slugs: [] },
          effective_state: { search_team_slugs: ["everyone"] },
          risk_facts: {
            organization_wide: true,
            target_team_slugs: ["everyone"],
            removed_team_slugs: ["everyone"],
            reasons: ["organization-wide audience removal"],
          },
          requester: { subject: "test-user" },
          created_at: "2026-01-01T00:00:00.000Z",
        }}
        detailsKnown
      />,
    );

    expect(screen.getByText("Pending: remove Everyone")).toBeInTheDocument();
    expect(screen.getByTitle("Pending Search: remove Everyone")).toBeInTheDocument();
  });
});
