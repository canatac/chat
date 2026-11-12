import type { Message, User } from './types';

export interface WsEvent {
  type: string;
  message?: Message;
  messages?: Message[];
  user?: User;
  online?: number[];
  error?: string;
}

type MessageHandler = (event: WsEvent) => void;
type StatusHandler = (open: boolean) => void;

export class ChatSocket {
  private ws: WebSocket | null = null;
  private readonly token: string;
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private retry = 0;
  private closed = false;

  constructor(token: string) {
    this.token = token;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.add(handler);
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandlers.add(handler);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.statusHandlers.forEach((h) => h(true));
    };
    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(String(ev.data)) as WsEvent;
        this.messageHandlers.forEach((h) => h(event));
      } catch {
        // événement malformé ignoré
      }
    };
    ws.onclose = () => {
      this.statusHandlers.forEach((h) => h(false));
      if (this.closed) return;
      this.retry += 1;
      setTimeout(() => {
        if (!this.closed) this.connect();
      }, Math.min(1000 * 2 ** this.retry, 15000));
    };
  }

  sendMessage(content: string): void {
    if (this.isOpen() && this.ws) {
      this.ws.send(JSON.stringify({ type: 'message', content }));
    }
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
