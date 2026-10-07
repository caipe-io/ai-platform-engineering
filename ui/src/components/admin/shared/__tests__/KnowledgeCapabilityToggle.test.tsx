import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { IngestCapabilityToggle } from "../IngestCapabilityToggle";
import { SearchCapabilityToggle } from "../SearchCapabilityToggle";

const fetchMock = jest.fn();

function response(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
  } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

it("shows an enabled Search grant without allowing a read-only viewer to change it", async () => {
  fetchMock.mockResolvedValue(response({ can_search: true }));

  render(
    <SearchCapabilityToggle
      teamId="team-1"
      teamName="Primary"
      readOnly
    />,
  );

  const toggle = screen.getByRole("switch", {
    name: "Allow this team to search knowledge bases",
  });
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  expect(toggle).toBeDisabled();

  fireEvent.click(toggle);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/admin/teams/team-1/search-capability");
});

it("shows an enabled create grant without allowing a read-only viewer to change it", async () => {
  fetchMock.mockResolvedValue(response({ can_author_data_sources: true }));

  render(
    <IngestCapabilityToggle
      teamId="team-1"
      teamName="Primary"
      readOnly
    />,
  );

  const toggle = screen.getByRole("switch", {
    name: "Allow this team to create data sources",
  });
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  expect(toggle).toBeDisabled();

  fireEvent.click(toggle);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/admin/teams/team-1/ingest-capability");
});
