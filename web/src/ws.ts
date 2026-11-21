import type { CallInfo, ConversationActivity, Meeting, MentionNotification, Message, MessageReceipt, User } from './types';
import type { SecurityReview } from './types';

export interface WsEvent {
  review?: SecurityReview;
  reviewId?: string;
  type: string;
  message?: Message;
  messages?: Message[];
  notification?: MentionNotification;
  user?: User;
  online?: number[];
  call?: CallInfo | null;
  meeting?: Pick<Meeting, 'id' | 'title'>;
  from?: number;
  data?: unknown;
  callId?: number | null;
  error?: string;
  typing?: ConversationActivity['typing'];
  assistantResponding?: boolean;
  receipts?: MessageReceipt[];
}

type MessageHandler = (event: WsEvent) => void;
type StatusHandler = (open: boolean) => void;

export class ChatSocket {
  private ws: WebSocket | null = null;
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private retry = 0;
  private closed = false;

  constructor(private readonly token: string, private readonly room: string | null) {}

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onStatus(handler: StatusHandler): void {
    this.statusHandlers.add(handler);
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams({ token: this.token });
    if (this.room !== null) params.set('room', this.room);
    const ws = new WebSocket(`${proto}://${location.host}/ws?${params}`);
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
    ws.onclose = (event) => {
      this.statusHandlers.forEach((h) => h(false));
      if (this.closed) return;
      if (event.code === 4001 || event.code === 4003) {
        this.messageHandlers.forEach((h) => h({ type: 'roomUnavailable', error: event.reason }));
        return;
      }
      this.retry += 1;
      setTimeout(() => {
        if (!this.closed) this.connect();
      }, Math.min(1000 * 2 ** this.retry, 15000));
    };
  }

  sendMessage(content: string): void {
    this.sendRaw({ type: 'message', content });
  }

  sendRaw(obj: unknown): void {
    if (this.isOpen() && this.ws) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
