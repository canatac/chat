import type { AdminStats, CallInfo, FileItem, Message, User } from './types';

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
  messages: (before?: number, limit = 50) =>
    req<{ messages: Message[] }>(`/api/messages?limit=${limit}${before !== undefined ? `&before=${before}` : ''}`),
  send: (content: string) =>
    req<{ message: Message }>('/api/messages', { method: 'POST', body: JSON.stringify({ content }) }),
  files: (query = '', before?: number, limit = 100) =>
    req<{ files: FileItem[] }>(
      `/api/files?limit=${limit}${before !== undefined ? `&before=${before}` : ''}${query ? `&query=${encodeURIComponent(query)}` : ''}`,
    ),
  uploadFile: async (file: File, message: string, post: boolean) => {
    const token = getToken();
    const fd = new FormData();
    fd.append('file', file);
    if (message) fd.append('message', message);
    fd.append('post', String(post));
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
  },
  uploadRecording: async (callId: number, blob: Blob, filename: string) => {
    const token = getToken();
    const fd = new FormData();
    fd.append('file', blob, filename);
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
    return (await res.json()) as { file: FileItem; transcriptPending: boolean };
  },
  derive: (fileId: number, kind: 'resume' | 'cr') =>
    req<{ file: FileItem }>(`/api/files/${fileId}/derive`, { method: 'POST', body: JSON.stringify({ kind }) }),
  transcribe: (fileId: number) =>
    req<{ file: FileItem }>(`/api/files/${fileId}/transcribe`, { method: 'POST' }),
  rtcConfig: () => req<{ iceServers: RTCIceServer[] }>('/api/rtc-config'),
};
