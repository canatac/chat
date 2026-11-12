import type { Message, User } from './types';

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
  messages: (before?: number, limit = 50) =>
    req<{ messages: Message[] }>(`/api/messages?limit=${limit}${before !== undefined ? `&before=${before}` : ''}`),
  send: (content: string) =>
    req<{ message: Message }>('/api/messages', { method: 'POST', body: JSON.stringify({ content }) }),
};
