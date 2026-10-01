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
  ompBin: string;
  ompWorkspaceRoot: string;
  maxConcurrentSessions: number;
  idleReapMs: number;
  replyMaxLen: number;
}
