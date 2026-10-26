import type { ConfiguredAgenticApp, AgenticAppAgentStream } from "@/types/agentic-app";

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

