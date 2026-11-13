export interface User {
  id: number;
  name: string;
  isBot: boolean;
  isAdmin?: boolean;
  online?: boolean;
}

export interface MessageFile {
  id: number;
  name: string;
  size: number;
  mime: string;
  createdAt: string;
}

export interface Message {
  id: number;
  content: string;
  createdAt: string;
  user: User;
  files: MessageFile[];
}

export interface FileItem {
  id: number;
  name: string;
  size: number;
  mime: string;
  createdAt: string;
  messageId: number | null;
  user: { id: number; name: string };
}

export interface CallParticipant {
  id: number;
  name: string;
  isBot: boolean;
}

export interface CallRecording {
  id: string;
  startedBy: CallParticipant;
  startedAt: number;
}

export interface CallInfo {
  id: number;
  title: string;
  startedBy: CallParticipant;
  participants: CallParticipant[];
  active: boolean;
  recording: CallRecording | null;
}

export interface AdminStats {
  calls?: { total: number; active: number };
  users: { total: number; online: number };
  messages: number;
  files: { count: number; bytes: number };
  llm: {
    calls: number;
    errors: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
    priceKnown: boolean;
    byCommand: { command: string; calls: number; tokens: number; costUsd: number }[];
    byModel: { model: string; calls: number; tokens: number; costUsd: number }[];
    byDay: { day: string; calls: number; tokens: number; costUsd: number }[];
  };
}
