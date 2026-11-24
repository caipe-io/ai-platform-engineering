import type { NotificationEventType } from "./taxonomy";

export const NOTIFICATION_EVENT_COPY: Record<
  NotificationEventType,
  { label: string; description: string }
> = {
  "ingestion.completed": {
    label: "Ingestion finished",
    description: "A source finished indexing.",
  },
  "ingestion.failed": {
    label: "Ingestion failed",
    description: "A source could not be indexed.",
  },
  "ingestion.started": {
    label: "Ingestion started",
    description: "A source began indexing.",
  },
  "workflow.completed": {
    label: "Workflow completed",
    description: "A workflow run finished successfully.",
  },
  "workflow.failed": {
    label: "Workflow failed",
    description: "A workflow run stopped with an error.",
  },
  "workflow.requires_input": {
    label: "Workflow needs input",
    description: "A workflow is waiting for your answer.",
  },
  "workflow.started": {
    label: "Workflow started",
    description: "A workflow run began.",
  },
  "agent.completed": {
    label: "Agent task completed",
    description: "A background agent task finished.",
  },
  "agent.failed": {
    label: "Agent task failed",
    description: "A background agent task failed.",
  },
  "agent.started": {
    label: "Agent task started",
    description: "A background agent task began.",
  },
  "agent.requires_input": {
    label: "Agent needs input",
    description: "An agent is waiting for your answer in a conversation.",
  },
  "service.degraded": {
    label: "Service degraded",
    description: "A service is no longer healthy.",
  },
  "service.recovered": {
    label: "Service recovered",
    description: "A degraded service is healthy again.",
  },
};
