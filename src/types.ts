export interface ChatTarget {
  spaceId: string;
  chatId: string;
  objectId?: string;
}

export interface NormalizedEvent {
  spaceId: string;
  chatId: string;
  messageId: string;
  senderId: string;
  text: string;
  mentionsBot: boolean;
  isBotSelf: boolean;
  isDirect: boolean;
  objectId?: string;
  /** Extra context prepended to the agent prompt (e.g. "you are in page X's discussion"). */
  contextNote?: string;
}

export interface ChatRow {
  id: string;
  name: string;
}

export interface Member {
  id: string;
  identity: string;
  name?: string;
}

export interface Config {
  apiBaseUrl: string;
  apiKey: string;
  botParticipantId: string;
  botIdentity?: string;
  botDisplayName: string;
  /** Root under which each space gets its own agent workspace directory. */
  agentWorkspaceRoot: string;
  /** Optional global pi config dir (env PI_AGENT_DIR); unset -> pi's ~/.pi/agent. */
  piAgentDir?: string;
  /** Model id to run the agent with (env PI_MODEL). Default: deepseek-flash (V4.1). */
  piModel: string;
  maxConcurrentSessions: number;
  idleReapMs: number;
  replyMaxLen: number;
}
