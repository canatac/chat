import type { AdminStats, CallInfo, FileEvent, FileItem, Folder, Message, MessageFile, User } from './types';

const TOKEN_KEY = 'chat.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  register: (name: string, password: string) =>
    req<{ token: string; user: User }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, password }),
    }),
  login: (name: string, password: string) =>
    req<{ token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ name, password }),
    }),
  me: () => req<{ user: User }>('/api/me'),
  users: () => req<{ users: User[] }>('/api/users'),
  messages: (before?: number, limit = 50, signal?: AbortSignal) =>
    req<{ messages: Message[] }>(`/api/messages?limit=${limit}${before !== undefined ? `&before=${before}` : ''}`, { signal }),
  send: (content: string) =>
    req<{ message: Message }>('/api/messages', { method: 'POST', body: JSON.stringify({ content }) }),
  files: (query = '', before?: number, limit = 100, folder?: number | null, signal?: AbortSignal) =>
    req<{ files: FileItem[] }>(
      `/api/files?limit=${limit}${before !== undefined ? `&before=${before}` : ''}${query ? `&query=${encodeURIComponent(query)}` : ''}${folder !== undefined ? `&folder=${folder === null ? 'root' : folder}` : ''}`,
      { signal },
    ),
  uploadFile: async (file: File, message: string, post: boolean, folderId?: number | null) => {
    const token = getToken();
    const fd = new FormData();
    fd.append('file', file);
    if (message) fd.append('message', message);
    fd.append('post', String(post));
    if (folderId !== undefined && folderId !== null) fd.append('folderId', String(folderId));
    const res = await fetch('/api/files', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
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
    const token = getToken();
    const res = await fetch(`/api/files/${id}/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
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
    const token = getToken();
    const fd = new FormData();
    fd.append('file', blob, filename);
    if (recordingId) fd.append('recordingId', recordingId);
    const res = await fetch(`/api/calls/${callId}/recording`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
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
