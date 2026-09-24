import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { UserIdentityDetails } from "../UserIdentityDetails";
import type { UserIdentityInfo } from "@/types/admin-user-identity";

const identity: UserIdentityInfo = {
  realm: "example", fetchedAt: "2026-09-24T12:00:00Z", sessions: [], lastAccess: null,
  federatedIdentities: [{ identityProvider: "primary", userId: "upstream-id", userName: "test-user" }],
  realmRoles: ["example-reader"], unavailable: [],
};

it("separates canonical identity, linked upstream identity and direct roles", () => {
  render(<UserIdentityDetails userId="canonical-id" identity={identity} loading={false} error={null} onRetry={jest.fn()} sourcesAvailable sources={[]} />);
  expect(screen.getByText("user:canonical-id")).toBeInTheDocument();
  expect(screen.getByText("upstream-id")).toBeInTheDocument();
  expect(screen.getByText("example-reader")).toBeInTheDocument();
  expect(screen.getByText(/No active membership sources recorded/)).toBeInTheDocument();
  expect(screen.queryByText("Local")).not.toBeInTheDocument();
});

it("shows unavailable and a refresh action rather than a local identity", () => {
  const retry = jest.fn();
  render(<UserIdentityDetails userId="canonical-id" identity={null} loading={false} error="Identity information unavailable." onRetry={retry} />);
  expect(screen.getByRole("alert")).toHaveTextContent("unavailable");
  expect(screen.getByText("Membership source information unavailable.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh identity" }));
  expect(retry).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Local")).not.toBeInTheDocument();
});

it("does not label a Keycloak service account as a human OpenFGA principal", () => {
  render(<UserIdentityDetails userId="service-id" principalType="service_account" identity={identity} loading={false} error={null} onRetry={jest.fn()} />);
  expect(screen.getByText("service_account:service-id")).toBeInTheDocument();
  expect(screen.queryByText("user:service-id")).not.toBeInTheDocument();
});

it("distinguishes a failed broker lookup from a successful empty result", () => {
  render(<UserIdentityDetails userId="canonical-id" identity={{ ...identity, unavailable: ["federatedIdentities"], federatedIdentities: [] }} loading={false} error={null} onRetry={jest.fn()} />);
  expect(screen.getByText(/Linked accounts unavailable/)).toBeInTheDocument();
  expect(screen.queryByText(/No broker-linked accounts reported/)).not.toBeInTheDocument();
});

it("flags mismatched and unresolved membership identities without claiming graph drift", () => {
  render(<UserIdentityDetails userId="canonical-id" identity={identity} loading={false} error={null} onRetry={jest.fn()} sourcesAvailable sources={[
    { team: "example-team", relationship: "member", source: "oidc_claim", provider: "primary", externalGroup: "example-group", subject: "old-id" },
    { team: "another-team", relationship: "member", source: "manual" },
  ]} />);
  expect(screen.getByText(/Recorded subject differs/)).toBeInTheDocument();
  expect(screen.getByText("Identity link is unresolved.")).toBeInTheDocument();
  expect(screen.getByText(/not a live upstream directory query or proof/)).toBeInTheDocument();
});
