export interface OmpReady {
  type: "ready";
  protocolVersion: number;
  supportedProtocolVersions: number[];
}

export interface OmpResponse {
  type: "response";
  id?: number;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface OmpMessageUpdate {
  type: "message_update";
  assistantMessageEvent: { type: string; delta?: string };
}

export interface OmpAgentEnd {
  type: "agent_end";
  isTerminal?: boolean;
}

export type OmpFrame =
  | OmpReady
  | OmpResponse
  | OmpMessageUpdate
  | OmpAgentEnd
  | { type: string; [k: string]: unknown };
