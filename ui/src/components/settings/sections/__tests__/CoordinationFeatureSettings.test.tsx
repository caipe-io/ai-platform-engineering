import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CoordinationFeatureSettings } from "../CoordinationFeatureSettings";

function installFetch({ deployment = true, fail = false } = {}) {
  const settings = { enabled: true, team: true, activity: true };
  const fetchMock = jest.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      if (fail) return { ok: false, json: async () => ({ error: "Save failed" }) };
      Object.assign(settings, JSON.parse(String(init.body)).agent_coordination);
    }
    return { ok: true, json: async () => ({ success: true, data: {
      agent_coordination: { enabled: deployment && settings.enabled, team: deployment && settings.enabled && settings.team, activity: deployment && settings.enabled && settings.activity },
      agent_coordination_deployment: { enabled: deployment, team: deployment, activity: deployment },
    } }) };
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

it("saves independent runtime switches and shows the effective server state", async () => {
  const fetchMock = installFetch();
  render(<CoordinationFeatureSettings />);
  const team = await screen.findByRole("switch", { name: "Team handoffs" });
  fireEvent.click(team);
  await waitFor(() => expect(team).toHaveAttribute("aria-checked", "false"));
  expect(screen.getByRole("switch", { name: "Agent Coordination" })).toHaveAttribute("aria-checked", "true");
  expect(fetchMock).toHaveBeenCalledWith("/api/admin/platform-config", expect.objectContaining({ method: "PATCH", body: '{"agent_coordination":{"team":false}}' }));
  fireEvent.click(screen.getByRole("switch", { name: "Agent Coordination" }));
  await waitFor(() => expect(team).toBeDisabled());
  expect(screen.getByText("Experimental")).toBeInTheDocument();
});
it("keeps deployment-disabled controls read-only", async () => {
  installFetch({ deployment: false });
  render(<CoordinationFeatureSettings />);
  expect(await screen.findByRole("switch", { name: "Agent Coordination" })).toBeDisabled();
  expect(screen.getByRole("switch", { name: "Team handoffs" })).toBeDisabled();
  expect(screen.getAllByText("Disabled by deployment configuration")).toHaveLength(3);
});
it("shows a failed save without pretending that the feature was disabled", async () => {
  installFetch({ fail: true });
  render(<CoordinationFeatureSettings />);
  const team = await screen.findByRole("switch", { name: "Team handoffs" });
  fireEvent.click(team);
  await screen.findByRole("alert");
  expect(team).toHaveAttribute("aria-checked", "true");
  expect(screen.queryByText("Saved")).not.toBeInTheDocument();
});
