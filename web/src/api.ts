import type { AdminStats, CallInfo, FileEvent, FileFilters, FileItem, FileSort, Folder, Message, MessageFile, Room, RoomInvitation, RoomMember, RoomSession, User } from './types';

interface FileListRequest {
  query: string;
  folderId?: number | null;
  limit: number;
  before?: number;
  recentSince?: number;
  sort: FileSort;
  filters: FileFilters;
}

const TOKEN_KEY = 'chat.token';
let sessionToken = localStorage.getItem(TOKEN_KEY);
export const selectedRoom = new URLSearchParams(location.search).get('room');

export function openRoom(roomId: number): void {
  const url = new URL(location.href);
  url.searchParams.set('room', String(roomId));
  url.hash = '';
  location.assign(url);
}

function sessionHeaders(): Record<string, string> {
  const token = getToken();
  return {
    ...(token ? { Authorization: 'Bearer ' + token } : {}),
    ...(selectedRoom !== null ? { 'X-Chat-Room': selectedRoom } : {}),
  };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function getToken(): string | null {
  return sessionToken;
}

export function setToken(token: string | null): void {
  sessionToken = token;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...sessionHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // garder statusText
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  register: (name: string, email: string, password: string, roomName: string) =>
    req<RoomSession & { token: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password, roomName }),
    }),
  login: (name: string, password: string) =>
    req<RoomSession & { token: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ name, password }),
    }),
  previewInvitation: (token: string, signal: AbortSignal) =>
    req<{ room: Room; email: string; expiresAt: number }>('/api/auth/invitations/preview', {
      method: 'POST',
      body: JSON.stringify({ token }),
      signal,
    }),
  acceptInvitation: (token: string, alias: string, password: string) =>
    req<RoomSession & { token: string }>('/api/auth/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token, alias, password }),
    }),
  me: (signal?: AbortSignal) => req<RoomSession>('/api/me', { signal }),
  rooms: {
    list: (signal: AbortSignal) => req<{ rooms: Room[] }>('/api/rooms', { signal }),
    create: (name: string) => req<{ room: Room }>('/api/rooms', { method: 'POST', body: JSON.stringify({ name }) }),
    rename: (id: number, name: string) => req<{ room: Room }>('/api/rooms/' + id, { method: 'PATCH', body: JSON.stringify({ name }) }),
    archive: (id: number, archived: boolean) =>
      req<{ room: Room }>('/api/rooms/' + id + '/archive', { method: 'PUT', body: JSON.stringify({ archived }) }),
    members: (id: number, signal: AbortSignal) => req<{ members: RoomMember[] }>('/api/rooms/' + id + '/members', { signal }),
    updateMember: (id: number, memberId: number, changes: { alias?: string; email?: string; avatar?: string | null }) =>
      req<{ member: RoomMember }>('/api/rooms/' + id + '/members/' + memberId, { method: 'PATCH', body: JSON.stringify(changes) }),
    removeMember: (id: number, memberId: number) =>
      req<void>('/api/rooms/' + id + '/members/' + memberId, { method: 'DELETE' }),
    invitations: (id: number, signal: AbortSignal) =>
      req<{ invitations: RoomInvitation[] }>('/api/rooms/' + id + '/invitations', { signal }),
    invite: (id: number, email: string, role: RoomInvitation['role']) =>
      req<{ invitation: RoomInvitation; token: string }>('/api/rooms/' + id + '/invitations', {
        method: 'POST',
        body: JSON.stringify({ email, role }),
      }),
    revoke: (id: number, invitationId: number) =>
      req<void>('/api/rooms/' + id + '/invitations/' + invitationId, { method: 'DELETE' }),
  },
  users: () => req<{ users: User[] }>('/api/users'),
  messages: (before?: number, limit = 50, signal?: AbortSignal) =>
    req<{ messages: Message[] }>(`/api/messages?limit=${limit}${before !== undefined ? `&before=${before}` : ''}`, { signal }),
  send: (content: string) =>
    req<{ message: Message }>('/api/messages', { method: 'POST', body: JSON.stringify({ content }) }),
  files: async ({ query, folderId, limit, before, recentSince, sort, filters }: FileListRequest, signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: String(limit), sort: sort.column, direction: sort.direction });
    if (before !== undefined) params.set('before', String(before));
    if (query) params.set('query', query);
    if (folderId !== undefined) params.set('folder', folderId === null ? 'root' : String(folderId));
    if (filters.name) params.set('name', filters.name);
    const dateFrom = filters.dateFrom ? new Date(filters.dateFrom + 'T00:00:00').getTime() : undefined;
    const activityFrom = recentSince === undefined ? dateFrom : Math.max(recentSince, dateFrom ?? recentSince);
    if (activityFrom !== undefined) params.set('activityFrom', String(activityFrom));
    if (filters.dateTo) {
      const nextDay = new Date(filters.dateTo + 'T00:00:00');
      nextDay.setDate(nextDay.getDate() + 1);
      if (activityFrom !== undefined && activityFrom >= nextDay.getTime()) return { files: [], nextBefore: null };
      params.set('activityBefore', String(nextDay.getTime()));
    }
    if (filters.minSizeKiB !== undefined) params.set('minBytes', String(filters.minSizeKiB * 1024));
    if (filters.maxSizeKiB !== undefined) params.set('maxBytes', String(filters.maxSizeKiB * 1024));
    return req<{ files: FileItem[]; nextBefore: number | null }>('/api/files?' + params, { signal });
  },
  uploadFile: async (file: File, message: string, post: boolean, folderId?: number | null) => {
    const fd = new FormData();
    fd.append('file', file);
    if (message) fd.append('message', message);
    fd.append('post', String(post));
    if (folderId !== undefined && folderId !== null) fd.append('folderId', String(folderId));
    const res = await fetch('/api/files', {
      method: 'POST',
      headers: sessionHeaders(),
      body: fd,
    });
    if (!res.ok) {
      let messageText = res.statusText;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) messageText = body.error;
      } catch {
        // garder statusText
      }
      throw new Error(messageText);
    }
    return (await res.json()) as { file: FileItem; message: Message | null };
  },
  downloadFile: async (id: number): Promise<Blob> => {
    const res = await fetch(`/api/files/${id}/download`, {
      headers: sessionHeaders(),
    });
    if (!res.ok) throw new Error('Téléchargement impossible');
    return res.blob();
  },
  adminStats: () => req<AdminStats>('/api/admin/stats'),
  calls: {
    active: () => req<{ call: CallInfo | null }>('/api/calls/active'),
    start: (title: string) =>
      req<{ call: CallInfo }>('/api/calls/start', { method: 'POST', body: JSON.stringify({ title }) }),
    join: () => req<{ call: CallInfo }>('/api/calls/join', { method: 'POST' }),
    leave: () => req<{ call: CallInfo | null }>('/api/calls/leave', { method: 'POST' }),
    end: () => req<{ ok: boolean }>('/api/calls/end', { method: 'POST' }),
    recordingStart: (callId: number) =>
      req<{ call: CallInfo; recordingId: string }>(`/api/calls/${callId}/recording/start`, { method: 'POST' }),
    recordingStop: (callId: number, recordingId?: string) =>
      req<{ call: CallInfo | null }>(`/api/calls/${callId}/recording/stop`, {
        method: 'POST',
        body: JSON.stringify(recordingId ? { recordingId } : {}),
      }),
  },
  uploadRecording: async (callId: number, blob: Blob, filename: string, recordingId?: string) => {
    const fd = new FormData();
    fd.append('file', blob, filename);
    if (recordingId) fd.append('recordingId', recordingId);
    const res = await fetch(`/api/calls/${callId}/recording`, {
      method: 'POST',
      headers: sessionHeaders(),
      body: fd,
    });
    if (!res.ok) {
      let messageText = res.statusText;
      try {
        const body = (await res.json()) as { error?: string };
        if (body.error) messageText = body.error;
      } catch {
        // garder statusText
      }
      throw new Error(messageText);
    }
    return (await res.json()) as { file: FileItem; transcriptPending: boolean; duplicate?: boolean; recordingId?: string };
  },
  derive: (fileId: number, kind: 'resume' | 'cr') =>
    req<{ file: FileItem }>(`/api/files/${fileId}/derive`, { method: 'POST', body: JSON.stringify({ kind }) }),
  transcribe: (fileId: number) =>
    req<{ file: FileItem }>(`/api/files/${fileId}/transcribe`, { method: 'POST' }),
  // explorateur de documents
  folders: (signal?: AbortSignal) => req<{ folders: Folder[] }>('/api/folders', { signal }),
  createFolder: (name: string, parentId: number | null) =>
    req<{ folder: Folder }>('/api/folders', { method: 'POST', body: JSON.stringify({ name, parentId }) }),
  patchFolder: (id: number, patch: { name?: string; parentId?: number | null }) =>
    req<{ folder: Folder }>(`/api/folders/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteFolder: (id: number, recursive: boolean) =>
    req<{ ok: boolean; deletedFolders?: number; deletedFiles?: number }>(
      `/api/folders/${id}?recursive=${recursive ? '1' : '0'}`,
      { method: 'DELETE' },
    ),
  patchFile: (id: number, patch: { name?: string; folderId?: number | null }) =>
    req<{ file: FileItem }>(`/api/files/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteFile: (id: number) => req<{ ok: boolean }>(`/api/files/${id}`, { method: 'DELETE' }),
  fileDetail: (id: number) => req<{ file: FileItem; folderPath: Folder[]; history: FileEvent[] }>(`/api/files/${id}`),
  events: (limit = 100) => req<{ events: FileEvent[] }>(`/api/events?limit=${limit}`),
  rtcConfig: () => req<{ iceServers: RTCIceServer[] }>('/api/rtc-config'),
};


export async function saveFile(file: Pick<MessageFile, 'id' | 'name'>): Promise<void> {
  const url = URL.createObjectURL(await api.downloadFile(file.id));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
