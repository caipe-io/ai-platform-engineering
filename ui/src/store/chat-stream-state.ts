import type { StreamAdapter } from "@/lib/streaming";

/** A conversation remains one sidebar item while each agent owns its subscription. */
export interface StreamingState {
  agentId?: string;
  conversationId: string;
  messageId: string;
  client: { abort: () => void };
  streamAdapter?: StreamAdapter;
  readOnly?: boolean;
  stopping?: boolean;
  stopError?: string;
  participantStreams?: Record<string, StreamingState>;
}

export function chatStreams(state?: StreamingState): StreamingState[] {
  return state ? Object.values(state.participantStreams ?? { single: state }) : [];
}

export function agentStream(state: StreamingState | undefined, agentId?: string): StreamingState | undefined {
  return agentId ? chatStreams(state).find(stream => stream.agentId === agentId) : state;
}

export function combineChatStreams(streams: StreamingState[]): StreamingState | undefined {
  if (streams.length < 2) return streams[0];
  const controllable = streams.filter(stream => !stream.readOnly);
  return { ...streams[0],
    participantStreams: Object.fromEntries(streams.map(stream => [stream.agentId ?? stream.messageId, stream])),
    readOnly: !controllable.length,
    stopping: controllable.length > 0 && controllable.every(stream => stream.stopping),
    stopError: streams.find(stream => stream.stopError)?.stopError,
  };
}

export function updateChatStream(previous: StreamingState | undefined, next: StreamingState | null, agentId?: string): StreamingState | undefined {
  if (!next && !agentId) return undefined;
  const target = next?.agentId ?? agentId;
  if (!target) return next ?? undefined;
  const others = chatStreams(previous).filter(stream => stream.agentId !== target && stream.messageId !== next?.messageId);
  return combineChatStreams(next ? [...others, next] : others);
}
