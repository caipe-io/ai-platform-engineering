/**
 * Unit tests for the Schedules page.
 *
 * The Status table column is intentionally role-independent. AuthGuard decides
 * whether a user can view the app at all; once the page renders, table columns
 * do not branch on admin/non-admin state.
 */

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockCreateConversation = jest.fn();
const mockSetPendingMessage = jest.fn();
const mockRouterPush = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

jest.mock("@/components/auth-guard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="auth-guard">{children}</div>
  ),
}));

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}));

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
    <span {...props}>{children}</span>
  ),
}));

jest.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock("@/components/ui/card", () => ({
  Card: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  CardContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
}));

jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

jest.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

jest.mock("@/components/ui/label", () => ({
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <label {...props}>{children}</label>
  ),
}));

jest.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
}));

jest.mock("lucide-react", () => ({
  AlertTriangle: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  Bot: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  CalendarClock: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  ChevronDown: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  ChevronRight: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  CheckCircle2: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  Clock3: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  History: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  Pause: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  Pencil: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  Play: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  RefreshCw: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  RotateCcw: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  Save: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
  Trash2: (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />,
}));

jest.mock("@/lib/config", () => ({
  getConfig: jest.fn(() => undefined),
}));

jest.mock("@/lib/utils", () => ({
  formatRelativeTime: () => "just now",
}));

jest.mock("@/store/chat-store", () => ({
  useChatStore: (selector: (state: {
    createConversation: typeof mockCreateConversation;
    setPendingMessage: typeof mockSetPendingMessage;
  }) => unknown) =>
    selector({
      createConversation: mockCreateConversation,
      setPendingMessage: mockSetPendingMessage,
    }),
}));

import SchedulesPage from "../page";

describe("SchedulesPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateConversation.mockResolvedValue("conversation-1");
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          total: 1,
          items: [
            {
              schedule_id: "schedule-1",
              agent_id: "agent-1",
              edit_agent_id: "agent-schedule-editor",
              agent_name: "Agent One",
              title: "Daily Platform Report",
              message_template: "Run the job",
              attributes: {
                project: "platform",
                workflow: "report",
              },
              cron: "*/30 * * * *",
              tz: "UTC",
              enabled: true,
              cronjob_name: "caipe-sched-schedule-1",
              version: 1,
              versions: [],
              created_at: "2026-05-25T00:00:00Z",
              updated_at: null,
              last_run: null,
            },
          ],
        },
      }),
    });
  });

  it("renders the Status column whenever the page renders", async () => {
    render(<SchedulesPage />);

    await waitFor(() =>
      expect(screen.getByText("Daily Platform Report")).toBeInTheDocument()
    );

    expect(screen.getByRole("columnheader", { name: "Status" })).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(
      screen.getByText(/Minimum recurring interval: 30 minutes\./)
    ).toBeInTheDocument();
  });

  it("renders the job title, agent, schedule id, and display attributes", async () => {
    render(<SchedulesPage />);

    await waitFor(() =>
      expect(screen.getByText("Daily Platform Report")).toBeInTheDocument()
    );

    expect(screen.getByText("agent: Agent One")).toBeInTheDocument();
    expect(screen.getByText("schedule_id: schedule-1")).toBeInTheDocument();
    expect(screen.getByText("project:")).toBeInTheDocument();
    expect(screen.getByText("platform")).toBeInTheDocument();
    expect(screen.getByText("workflow:")).toBeInTheDocument();
    expect(screen.getByText("report")).toBeInTheDocument();
    expect(screen.getByText("Every 30 minutes")).toBeInTheDocument();
    expect(screen.getByText("Timezone: UTC")).toBeInTheDocument();
    expect(screen.queryByText("caipe-sched-schedule-1")).not.toBeInTheDocument();
  });

  it("shows automatic runner updates in schedule change history", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          total: 1,
          items: [
            {
              schedule_id: "schedule-1",
              agent_id: "agent-1",
              edit_agent_id: null,
              agent_name: "Agent One",
              title: "Daily Platform Report",
              message_template: "Run the job",
              attributes: {},
              cron: "*/30 * * * *",
              tz: "UTC",
              enabled: true,
              cronjob_name: "caipe-sched-schedule-1",
              version: 1,
              versions: [],
              events: [
                {
                  event_id: "evt_runner_update",
                  event_type: "runner_image_reconciled",
                  occurred_at: "2026-07-02T15:45:00Z",
                  actor_type: "system",
                  actor_id: "caipe-scheduler",
                  source: "deployment_reconcile",
                  changed_fields: ["runner_image"],
                  changes: {
                    runner_image: {
                      before: "caipe-cron-runner:old",
                      after: "caipe-cron-runner:new",
                    },
                  },
                },
              ],
              created_at: "2026-05-25T00:00:00Z",
              updated_at: null,
              last_run: null,
              one_off_runs: [],
            },
          ],
        },
      }),
    });

    render(<SchedulesPage />);

    await waitFor(() =>
      expect(screen.getByText("Daily Platform Report")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /modify schedule-1/i }));

    expect(screen.getByText("Change History")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(
      screen.getByText("Runner configuration automatically updated")
    ).toBeInTheDocument();
    expect(screen.getByText("New deployment")).toBeInTheDocument();
    expect(screen.getByText("caipe-cron-runner:old")).toBeInTheDocument();
    expect(screen.getByText("caipe-cron-runner:new")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rollback" })).not.toBeInTheDocument();
  });

  it("collapses one-off runs under their recurring schedule", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          total: 1,
          items: [
            {
              schedule_id: "schedule-1",
              agent_id: "agent-1",
              edit_agent_id: "agent-schedule-editor",
              agent_name: "Agent One",
              title: "Weekly Platform Summary",
              message_template: "Run the writeup",
              attributes: {
                project: "platform",
                workflow: "summary",
              },
              cron: "0 18 * * TUE",
              tz: "UTC",
              enabled: true,
              cronjob_name: "caipe-sched-schedule-1",
              version: 1,
              versions: [],
              created_at: "2026-05-25T00:00:00Z",
              updated_at: null,
              last_run: null,
              one_off_runs: [
                {
                  one_off_run_id: "oneoff-1",
                  schedule_id: "schedule-1",
                  run_at: "2026-06-12T18:10:00Z",
                  status: "pending",
                  message_template: null,
                  reason: "upstream_not_ready",
                  retry_num: 1,
                  retry_limit: 3,
                  job_name: null,
                  error: null,
                  http_status: null,
                  created_at: "2026-06-12T18:00:00Z",
                  updated_at: "2026-06-12T18:00:00Z",
                  claimed_at: null,
                  fired_at: null,
                  completed_at: null,
                },
              ],
            },
          ],
        },
      }),
    });

    render(<SchedulesPage />);

    await waitFor(() =>
      expect(screen.getByText("Weekly Platform Summary")).toBeInTheDocument()
    );

    expect(screen.getByText("1 active one-off")).toBeInTheDocument();
    expect(screen.queryByText("One-off fires")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Show 1 active one-off for schedule-1",
      })
    );

    expect(screen.getByText("One-off fires")).toBeInTheDocument();
    expect(screen.getByText("These do not pause or skip the recurring job.")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("Retry 1 / 3")).toBeInTheDocument();
    expect(screen.getByText("oneoff-1")).toBeInTheDocument();
    expect(screen.getByText("upstream_not_ready")).toBeInTheDocument();
  });

  it("lets users edit the schedule title", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          total: 1,
          items: [
            {
              schedule_id: "schedule-1",
              agent_id: "agent-1",
              edit_agent_id: null,
              agent_name: "Agent One",
              title: "Daily Platform Report",
              message_template: "Run the job",
              attributes: {},
              cron: "*/30 * * * *",
              tz: "UTC",
              enabled: true,
              cronjob_name: null,
              version: 1,
              versions: [],
              created_at: "2026-05-25T00:00:00Z",
              updated_at: null,
              last_run: null,
            },
          ],
        },
      }),
    });
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          schedule_id: "schedule-1",
          agent_id: "agent-1",
          edit_agent_id: null,
          agent_name: "Agent One",
          title: "Renamed Platform Report",
          message_template: "Run the job",
          attributes: {},
          cron: "*/30 * * * *",
          tz: "UTC",
          enabled: true,
          cronjob_name: null,
          version: 2,
          versions: [],
          created_at: "2026-05-25T00:00:00Z",
          updated_at: "2026-05-28T00:00:00Z",
          last_run: null,
        },
      }),
    });

    render(<SchedulesPage />);

    await waitFor(() =>
      expect(screen.getByText("Daily Platform Report")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /modify schedule-1/i }));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Renamed Platform Report" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith(
        "/api/schedules/schedule-1",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"title":"Renamed Platform Report"'),
        })
      )
    );
  });

  it("shows the deployment-configured minimum schedule interval", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          total: 1,
          minimum_schedule_interval_seconds: 600,
          items: [
            {
              schedule_id: "schedule-1",
              agent_id: "agent-1",
              edit_agent_id: null,
              agent_name: "Agent One",
              title: "Daily Platform Report",
              message_template: "Run the job",
              attributes: {},
              cron: "0 9 * * *",
              tz: "UTC",
              enabled: true,
              cronjob_name: null,
              version: 1,
              versions: [],
              events: [],
              created_at: "2026-05-25T00:00:00Z",
              updated_at: null,
              last_run: null,
            },
          ],
        },
      }),
    });

    render(<SchedulesPage />);

    await waitFor(() =>
      expect(screen.getByText("Daily Platform Report")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /modify schedule-1/i }));

    expect(
      screen.getByText(/Minimum recurring interval: 10 minutes\./)
    ).toBeInTheDocument();
    expect(screen.getByText("Runs must be at least 10 minutes apart.")).toBeInTheDocument();
  });

  it("starts schedule edit chat with the schedule-specific edit agent", async () => {
    render(<SchedulesPage />);

    await waitFor(() =>
      expect(screen.getByText("Daily Platform Report")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /modify schedule-1/i }));
    fireEvent.click(screen.getByRole("button", { name: "Chat with agent" }));

    await waitFor(() =>
      expect(mockCreateConversation).toHaveBeenCalledWith(
        "agent-schedule-editor"
      )
    );
    expect(mockSetPendingMessage).toHaveBeenCalledWith(
      expect.stringContaining("edit_agent_id: agent-schedule-editor")
    );
    expect(mockRouterPush).toHaveBeenCalledWith("/chat/conversation-1");
  });

  it("uses the MongoDB scheduler editor agent when no schedule-specific agent is set", async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            total: 1,
            items: [
              {
                schedule_id: "schedule-1",
                agent_id: "agent-1",
                edit_agent_id: null,
                agent_name: "Agent One",
                title: "Daily Platform Report",
                message_template: "Run the job",
                attributes: {},
                cron: "*/30 * * * *",
                tz: "UTC",
                enabled: true,
                cronjob_name: null,
                version: 1,
                versions: [],
                created_at: "2026-05-25T00:00:00Z",
                updated_at: null,
                last_run: null,
                one_off_runs: [],
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          data: {
            schedule_editor_agent_id: "agent-mongodb-scheduler-editor",
            schedule_editor_agent_source: "db",
          },
        }),
      });

    render(<SchedulesPage />);

    await waitFor(() =>
      expect(screen.getByText("Daily Platform Report")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: /modify schedule-1/i }));
    fireEvent.click(screen.getByRole("button", { name: "Chat with agent" }));

    await waitFor(() =>
      expect(mockCreateConversation).toHaveBeenCalledWith(
        "agent-mongodb-scheduler-editor"
      )
    );
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/admin/platform-config",
      { cache: "no-store" },
    );
    expect(mockRouterPush).toHaveBeenCalledWith("/chat/conversation-1");
  });

  it("asks for confirmation before deleting a schedule", async () => {
    render(<SchedulesPage />);

    await waitFor(() =>
      expect(screen.getByText("Daily Platform Report")).toBeInTheDocument()
    );

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: { deleted: "schedule-1" },
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: /delete schedule-1/i }));

    expect(screen.getByText("Delete Scheduled Job?")).toBeInTheDocument();
    expect(screen.getByText(/Are you sure/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete scheduled job" }));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenLastCalledWith("/api/schedules/schedule-1", {
        method: "DELETE",
      })
    );
    await waitFor(() =>
      expect(screen.getByText("No scheduled jobs yet.")).toBeInTheDocument()
    );
  });
});
