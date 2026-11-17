import { useCallback, useEffect, useReducer, useRef, useState, type RefObject } from 'react';
import { api, ApiError } from './api';
import type { Message, MessageReceipt, UnreadMessages } from './types';
import type { ChatSocket } from './ws';

const receiptBatchSize = 100;
const batchDelay = 80;

function useReceiptQueue(onRead: () => void) {
  const enqueue = useRef<(ids: number[], read: boolean) => void>(() => {});

  useEffect(() => {
    const controller = new AbortController();
    const pending = new Map<number, { id: number; read: boolean }>();
    const saved = new Map<number, boolean>();
    let timer: number | undefined;
    let sending = false;
    let delay = batchDelay;

    function schedule() {
      if (timer === undefined && !sending && pending.size && !controller.signal.aborted) {
        timer = window.setTimeout(() => { void flush(); }, delay);
      }
    }

    async function flush() {
      timer = undefined;
      sending = true;
      const receipts = [...pending.values()].slice(0, receiptBatchSize);
      try {
        await api.acknowledgeMessages(receipts, controller.signal);
        if (controller.signal.aborted) return;
        for (const receipt of receipts) {
          saved.set(receipt.id, receipt.read);
          if (pending.get(receipt.id) === receipt) pending.delete(receipt.id);
        }
        if (receipts.some(({ read }) => read)) onRead();
        delay = batchDelay;
      } catch (error) {
        if (error instanceof ApiError && [400, 401, 403, 404].includes(error.status)) pending.clear();
        delay = Math.min(delay * 2, 5000);
      } finally {
        sending = false;
        schedule();
      }
    }

    enqueue.current = (ids, read) => {
      for (const id of ids) {
        if (saved.get(id) === true || pending.get(id)?.read === true) continue;
        if (!read && (saved.has(id) || pending.has(id))) continue;
        pending.set(id, { id, read });
      }
      schedule();
    };

    return () => {
      controller.abort();
      window.clearTimeout(timer);
      enqueue.current = () => {};
    };
  }, [onRead]);

  return useCallback((ids: number[], read: boolean) => enqueue.current(ids, read), []);
}

export default function useMessageActivity(
  socket: ChatSocket | null,
  online: boolean,
  messages: Message[],
  userId: number,
  listRef: RefObject<HTMLDivElement>,
  conversationVisible: boolean,
) {
  const [unread, setUnread] = useState<UnreadMessages>({ count: 0, firstId: null });
  const [receipts, setReceipts] = useState<ReadonlyMap<number, MessageReceipt>>(new Map());
  const [revision, refreshUnread] = useReducer((version: number) => version + 1, 0);
  const queue = useReceiptQueue(refreshUnread);
  const checked = useRef(new Set<number>());

  const updateReceipts = useCallback((updates: MessageReceipt[]) => {
    if (!updates.length) return;
    setReceipts((previous) => {
      const next = new Map(previous);
      for (const update of updates) {
        const current = next.get(update.messageId);
        next.set(update.messageId, {
          messageId: update.messageId,
          received: Math.max(update.received, current?.received ?? 0),
          read: Math.max(update.read, current?.read ?? 0),
        });
      }
      return next;
    });
  }, []);

  useEffect(() => socket?.onMessage((event) => {
    if (event.type === 'message' && event.message && event.message.user.id !== userId) {
      queue([event.message.id], false);
      refreshUnread();
    } else if (event.type === 'unreadMessagesChanged') {
      refreshUnread();
    } else if (event.type === 'messageReceipts' && event.receipts) {
      updateReceipts(event.receipts);
    }
  }), [queue, socket, updateReceipts, userId]);

  useEffect(() => {
    const request = new AbortController();
    const timer = window.setTimeout(() => {
      void api.messageActivity(request.signal).then((status) => {
        if (!request.signal.aborted) setUnread(status.unread);
      }).catch(() => {});
    }, batchDelay);
    return () => { request.abort(); window.clearTimeout(timer); };
  }, [online, revision]);

  useEffect(() => { checked.current.clear(); }, [online]);
  useEffect(() => {
    const ids = messages.filter((message) => message.user.id === userId && !checked.current.has(message.id))
      .map(({ id }) => id);
    if (!ids.length) return;
    const request = new AbortController();
    const loadReceipts = async () => {
      for (let start = 0; start < ids.length && !request.signal.aborted; start += receiptBatchSize) {
        const page = ids.slice(start, start + receiptBatchSize);
        const status = await api.messageActivity(request.signal, page);
        if (request.signal.aborted) return;
        page.forEach((id) => checked.current.add(id));
        updateReceipts(status.receipts);
      }
    };
    void loadReceipts().catch(() => {});
    return () => request.abort();
  }, [messages, online, updateReceipts, userId]);

  useEffect(() => {
    queue(messages.filter((message) => message.user.id !== userId).map(({ id }) => id), false);
  }, [messages, queue, userId]);

  useEffect(() => {
    const list = listRef.current;
    if (!conversationVisible || !list || !messages.length) return;
    const visible = new Set<Element>();
    const report = () => {
      if (document.hidden || !document.hasFocus() || list.closest('[aria-hidden="true"]')) return;
      const bounds = list.getBoundingClientRect();
      const ids: number[] = [];
      for (const row of visible) {
        const rect = row.getBoundingClientRect();
        if (rect.top < bounds.bottom - 12 && rect.bottom > bounds.top + 12) {
          ids.push(Number((row as HTMLElement).dataset.messageId));
        }
      }
      queue(ids, true);
    };
    const observer = new IntersectionObserver((entries) => {
      for (const { target, isIntersecting } of entries) {
        if (isIntersecting) visible.add(target);
        else visible.delete(target);
      }
      report();
    }, { root: list, rootMargin: '-12px 0px' });
    list.querySelectorAll('[data-receivable]').forEach((row) => observer.observe(row));
    window.addEventListener('focus', report);
    document.addEventListener('focusin', report);
    document.addEventListener('visibilitychange', report);
    return () => {
      observer.disconnect();
      window.removeEventListener('focus', report);
      document.removeEventListener('focusin', report);
      document.removeEventListener('visibilitychange', report);
    };
  }, [conversationVisible, listRef, messages, queue]);

  useEffect(() => {
    const title = document.title;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const href = icon?.getAttribute('href');
    if (unread.count) {
      document.title = `(${unread.count}) ${title}`;
      if (icon) icon.href = '/chatroom-unread.svg';
    }
    return () => {
      document.title = title;
      if (icon && href) icon.setAttribute('href', href);
    };
  }, [unread.count]);

  return { receipts, unread, refreshUnread };
}
