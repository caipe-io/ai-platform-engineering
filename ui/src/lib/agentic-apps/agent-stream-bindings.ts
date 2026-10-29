import type { ConfiguredAgenticApp, AgenticAppAgentStream } from "@/types/agentic-app";

/** Shared browser/server client admission; independent of transport credentials. */
export function supportsAssistantClient(
  assistant: Pick<AgenticAppAgentStream, "supportedClients" | "webexGroupChat">,
  client: "webui" | "webex",
  kind?: "direct" | "group",
): boolean {
  return (assistant.supportedClients ?? ["webui"]).includes(client)
    && (client !== "webex" || kind !== "group" || assistant.webexGroupChat === true);
}

/** Browser-safe normalization of publisher and operator stream declarations. */
export function getAgenticAppAgentStreams(app: ConfiguredAgenticApp): AgenticAppAgentStream[] {
  const primary = app.manifest.ui.assistant;
  return [
    ...(primary?.streamPath ? [{ id: "assistant", agentId: primary.agentId, streamPath: primary.streamPath,
      ...(primary.resumePath ? { resumePath: primary.resumePath } : {}),
      ...(primary.cancelPath ? { cancelPath: primary.cancelPath } : {}),
      ...(primary.statusPath ? { statusPath: primary.statusPath } : {}),
      ...(primary.supportedClients ? { supportedClients: primary.supportedClients } : {}),
      ...(primary.webexGroupChat !== undefined ? { webexGroupChat: primary.webexGroupChat } : {}),
    }] : []),
    ...(app.installation.bindings?.agentStreams ?? []),
  ];
}

