export type Role = 'superadmin' | 'admin' | 'member';

export interface User {
  id: number;
  name: string;
  isBot: boolean;
  role?: Role;
  avatar?: string | null;
  online?: boolean;
  mentionable?: boolean;
}

export interface Room {
  id: number;
  name: string;
  archivedAt: number | null;
}

export interface RoomSession {
  user: User & { role: Role };
  roomId: number | null;
  rooms: Room[];
}

export interface RoomMember extends User {
  email: string | null;
  role: Role;
}

export interface RoomInvitation {
  id: number;
  email: string;
  role: 'member' | 'admin';
  expiresAt: number;
}

export interface MessageFile {
  id: number;
  name: string;
  size: number;
  mime: string;
  createdAt: string;
  analysis?: FileItem['analysis'];
}

export interface Message {
  id: number;
  content: string;
  createdAt: string;
  user: User;
  files: MessageFile[];
  mentions?: Mention[];
}

export interface MessageReceipt {
  messageId: number;
  received: number;
  read: number;
}

export interface UnreadMessages {
  count: number;
  firstId: number | null;
}

export interface SecurityPolicy {
  detection: 'block' | 'anonymize' | 'ask';
  modelErrors: 'fail-closed' | 'fail-open';
  version: number;
}

export interface SecurityReview {
  id: string;
  expiresAt: number;
  policyVersion: number;
  types: string[];
  count: number;
  maxScore: number | null;
  sources: { kind: 'question' | 'history' | 'documents' | 'agenda' | 'instructions' | 'context'; count: number }[];
  rememberedCount: number;
}

export interface SecurityState {
  policy: SecurityPolicy;
  health: { available: boolean; error: string | null };
  reviews: SecurityReview[];
  remembered: number;
}

export interface ConversationActivity {
  typing: Pick<User, 'id' | 'name'>[];
  assistantResponding: boolean;
}

export interface Mention {
  start: number;
  end: number;
  userId: number | null;
}

export interface MentionNotification {
  id: number;
  messageId: number;
  kind: 'member' | 'room';
  senderName: string;
  preview: string;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPage {
  notifications: MentionNotification[];
  unread: number;
  nextBefore: number | null;
}

export interface FileItem {
  id: number;
  name: string;
  size: number;
  mime: string;
  createdAt: string;
  updatedAt: string | null;
  messageId: number | null;
  folderId: number | null;
  user: { id: number; name: string };
  analysis?: { status: 'pending' | 'processing' | 'ready' | 'blocked'; error: string | null };
}

export type FileColumn = 'name' | 'date' | 'size';

export interface FileSort {
  column: FileColumn;
  direction: 'asc' | 'desc';
}

export interface FileFilters {
  name?: string;
  dateFrom?: string;
  dateTo?: string;
  minSizeKiB?: number;
  maxSizeKiB?: number;
}

export interface DocumentIds {
  fileIds: number[];
  folderIds: number[];
}

type MoveItem = { kind: 'file' | 'folder'; id: number };

export type MoveDecision = MoveItem & (
  { action: 'skip' } | { action: 'rename'; name: string } | { action: 'replace'; token: string; name?: string }
);

export type MoveConflict = MoveItem & {
  sourceName: string;
  name: string;
  existing: number;
  reason: 'destination' | 'planned' | 'selection';
  replaceToken: string | null;
  changed: boolean;
};

export interface Folder {
  id: number;
  name: string;
  parentId: number | null;
  createdAt: string;
  updatedAt: string | null;
  createdBy: User;
}

export interface FileEvent {
  id: number;
  fileId: number | null;
  folderId: number | null;
  action: string;
  detail: string;
  createdAt: string;
  user: User;
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
  meetingId: number | null;
  startedBy: CallParticipant;
  participants: CallParticipant[];
  active: boolean;
  recording: CallRecording | null;
}

export type MeetingResponse = 'pending' | 'accepted' | 'tentative' | 'declined';

export interface MeetingArtifact {
  id: number;
  name: string;
  mime: string;
  size: number;
  kind: 'recording' | 'transcript' | 'report' | 'summary';
}

export interface MeetingInput {
  title: string;
  agenda: string;
  startsAt: number;
  durationMinutes: number;
  timeZone: string;
  participantIds: number[];
}

export interface MeetingContactInvitation {
  id: number;
  email?: string;
  expiresAt: number;
}

export interface Meeting extends Omit<MeetingInput, 'participantIds'> {
  id: number;
  organizerId: number;
  participants: { id: number; name: string; response: MeetingResponse }[];
  pendingContacts: MeetingContactInvitation[];
  present: { id: number; name: string }[];
  artifacts: MeetingArtifact[];
  status: 'scheduled' | 'live' | 'held' | 'past' | 'cancelled';
  canEdit: boolean;
  canManageParticipants: boolean;
  canEnter: boolean;
}

export interface MeetingDraft extends Pick<MeetingInput, 'title' | 'agenda' | 'durationMinutes' | 'participantIds'> {
  localStart: string | null;
}

export type AgendaAssistantResponse =
  | { kind: 'draft'; draft: MeetingDraft; unresolved: string[] }
  | { kind: 'results'; meetings: Meeting[]; total: number; answer: string }
  | { kind: 'clarify'; answer: string };

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
