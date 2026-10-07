/**
 * @jest-environment jsdom
 */

import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ServiceAccountSelect } from "../ServiceAccountSelect";

function mockResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

function serviceAccountPayload() {
  return {
    success: true,
    data: {
      items: [
        { id: "sub-primary", name: "example-bot", status: "active" },
        { id: "sub-secondary", name: "secondary-bot", status: "active" },
        { id: "sub-revoked", name: "revoked-bot", status: "revoked" },
      ],
    },
  };
}

beforeEach(() => {
  jest.resetAllMocks();
});

it("requires a team before loading service accounts", () => {
  global.fetch = jest.fn();

  render(
    <ServiceAccountSelect value="" onChange={jest.fn()} teamSlug={undefined} />,
  );

  expect(screen.getByText(/no team assigned/i)).toBeInTheDocument();
  expect(fetch).not.toHaveBeenCalled();
});

it("shows non-interactive guidance when the team has no active accounts", async () => {
  global.fetch = jest.fn().mockResolvedValue(
    mockResponse({
      success: true,
      data: {
        items: [
          { id: "sub-revoked", name: "revoked-bot", status: "revoked" },
        ],
      },
    }),
  );

  render(
    <ServiceAccountSelect value="" onChange={jest.fn()} teamSlug="primary" />,
  );

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/service-accounts?team=primary",
    ),
  );
  expect(
    await screen.findByText(/no active service accounts found for team:primary/i),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Service account" }),
  ).not.toBeInTheDocument();
});

it("loads active accounts for the team and maps the selected identity", async () => {
  global.fetch = jest.fn().mockResolvedValue(mockResponse(serviceAccountPayload()));
  const onChange = jest.fn();

  render(
    <ServiceAccountSelect
      value=""
      onChange={onChange}
      teamSlug="primary"
    />,
  );

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/api/admin/service-accounts?team=primary",
    ),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Service account" }));

  const listbox = await screen.findByRole("listbox");
  expect(
    within(listbox).getByRole("option", { name: "example-bot" }),
  ).toBeInTheDocument();
  expect(within(listbox).queryByText("revoked-bot")).not.toBeInTheDocument();

  fireEvent.click(within(listbox).getByRole("option", { name: "example-bot" }));
  expect(onChange).toHaveBeenCalledWith("sub-primary", "example-bot");
});

it("keeps a saved selection available when it is outside the fetched team list", async () => {
  global.fetch = jest.fn().mockResolvedValue(
    mockResponse({ success: true, data: { items: [] } }),
  );

  render(
    <ServiceAccountSelect
      value="sub-saved"
      onChange={jest.fn()}
      teamSlug="primary"
      displayName="saved-bot"
    />,
  );

  const picker = screen.getByRole("combobox", { name: "Service account" });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(picker).toHaveTextContent("saved-bot");
});

it("keeps a saved display name when the legacy route has no subject", async () => {
  global.fetch = jest.fn().mockResolvedValue(
    mockResponse({ success: true, data: { items: [] } }),
  );

  render(
    <ServiceAccountSelect
      value=""
      onChange={jest.fn()}
      teamSlug="primary"
      displayName="saved-bot"
    />,
  );

  const picker = screen.getByRole("combobox", { name: "Service account" });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(picker).toHaveTextContent("saved-bot");
  expect(screen.queryByText(/no active service accounts/i)).not.toBeInTheDocument();
});

it("does not expose options loaded for a previous team while the next team loads", async () => {
  let resolveSecondary: ((value: Response) => void) | undefined;
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(mockResponse(serviceAccountPayload()))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveSecondary = resolve;
        }),
    );

  const { rerender } = render(
    <ServiceAccountSelect value="" onChange={jest.fn()} teamSlug="primary" />,
  );
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

  rerender(
    <ServiceAccountSelect value="" onChange={jest.fn()} teamSlug="secondary" />,
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Service account" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading service accounts",
  );
  expect(screen.queryByRole("option", { name: "example-bot" })).not.toBeInTheDocument();

  resolveSecondary?.(
    mockResponse({
      success: true,
      data: {
        items: [
          { id: "sub-tertiary", name: "tertiary-bot", status: "active" },
        ],
      },
    }),
  );
  expect(
    await screen.findByRole("option", { name: "tertiary-bot" }),
  ).toBeInTheDocument();
});

it("retries the team-scoped request after a load failure", async () => {
  global.fetch = jest
    .fn()
    .mockRejectedValueOnce(new Error("timeout"))
    .mockResolvedValueOnce(mockResponse(serviceAccountPayload()));

  render(
    <ServiceAccountSelect value="" onChange={jest.fn()} teamSlug="primary" />,
  );

  const picker = screen.getByRole("combobox", { name: "Service account" });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  fireEvent.click(picker);
  fireEvent.click(await screen.findByRole("button", { name: /retry/i }));

  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(
    await screen.findByRole("option", { name: "example-bot" }),
  ).toBeInTheDocument();
});
