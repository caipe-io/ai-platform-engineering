export interface ConversationViewer {
  id: string;
  name: string;
  sessions: number;
}

export interface ConversationPresence {
  viewers: ConversationViewer[];
  sessionCount: number;
}
