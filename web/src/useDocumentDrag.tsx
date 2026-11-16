import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { DocumentItem } from './components/DocumentExplorerList';

export type DropTarget = { kind: 'folder'; id: number | null } | { kind: 'file'; id: number } | { kind: 'destination' };

export function documentDropAttributes(target: DropTarget) {
  return {
    'data-document-drop': target.kind,
    'data-document-drop-id': target.kind === 'destination' ? undefined : String(target.id ?? 'root'),
  };
}

export function documentDropAt(element: Element | null): { element: HTMLElement; target: DropTarget } | null {
  const row = element?.closest<HTMLElement>('[data-document-drop]');
  if (!row) return null;
  const kind = row.dataset.documentDrop;
  if (kind === 'destination') return { element: row, target: { kind } };
  if (kind !== 'folder' && kind !== 'file') return null;
  if (kind === 'folder' && row.dataset.documentDropId === 'root') return { element: row, target: { kind, id: null } };
  const id = Number(row.dataset.documentDropId);
  return Number.isSafeInteger(id) && id > 0 ? { element: row, target: { kind, id } } : null;
}

export const documentDropStyle = {
  '&[data-document-drop-active]': { outline: '2px solid #167b6f', outlineOffset: -2, bgcolor: '#dff3eb' },
  '&[data-document-drop-active="group"]': { outlineColor: '#7856a5', bgcolor: '#f0eafa' },
};

interface Drag {
  pointerId: number;
  source: DocumentItem;
  handle: HTMLButtonElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  started: boolean;
  marked: HTMLElement | null;
  frame: number;
}

interface Options {
  enabled: boolean;
  label: (source: DocumentItem) => string;
  canDrop: (source: DocumentItem, target: DropTarget) => boolean;
  onDrop: (source: DocumentItem, target: DropTarget) => void;
  onChoose: (source: DocumentItem) => void;
}

export default function useDocumentDrag(options: Options) {
  const current = useRef<Drag | null>(null);
  const suppressClick = useRef<HTMLButtonElement | null>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [label, setLabel] = useState<string | null>(null);

  const cancel = useCallback(() => {
    const drag = current.current;
    if (!drag) return;
    if (drag.started) suppressClick.current = drag.handle;
    current.current = null;
    cancelAnimationFrame(drag.frame);
    drag.marked?.removeAttribute('data-document-drop-active');
    if (drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
    setLabel(null);
  }, []);

  useEffect(() => {
    if (!options.enabled) cancel();
  }, [options.enabled, cancel]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !current.current?.started) return;
      event.stopPropagation();
      cancel();
    };
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('keydown', escape, true);
      cancel();
    };
  }, [cancel]);

  function hit(drag: Drag) {
    const found = documentDropAt(document.elementFromPoint(drag.x, drag.y));
    return found && optionsRef.current.canDrop(drag.source, found.target) ? found : null;
  }

  function update(drag: Drag) {
    const found = hit(drag);
    const element = found?.element ?? null;
    if (element !== drag.marked) {
      drag.marked?.removeAttribute('data-document-drop-active');
      drag.marked = element;
      element?.setAttribute('data-document-drop-active', found?.target.kind === 'file' ? 'group' : 'move');
    }
    if (labelRef.current) {
      const left = Math.min(drag.x + 12, window.innerWidth - labelRef.current.offsetWidth - 6);
      const top = drag.y < 65 ? drag.y + 16 : drag.y - 44;
      labelRef.current.style.transform = `translate(${Math.max(6, left)}px, ${top}px)`;
    }
  }

  function scrollNearEdge(drag: Drag) {
    if (current.current !== drag) return;
    const pane = document.elementFromPoint(drag.x, drag.y)?.closest<HTMLElement>('[data-document-scroll]');
    if (pane) {
      const bounds = pane.getBoundingClientRect();
      const previous = pane.scrollTop;
      if (drag.y < bounds.top + 40) pane.scrollTop -= 14;
      if (drag.y > bounds.bottom - 40) pane.scrollTop += 14;
      if (previous !== pane.scrollTop) update(drag);
    }
    drag.frame = requestAnimationFrame(() => scrollNearEdge(drag));
  }

  function bind(source: DocumentItem, activate: () => void, touch: boolean) {
    return {
      onPointerDown(event: PointerEvent<HTMLButtonElement>) {
        if (!optionsRef.current.enabled || current.current || event.button !== 0 || !event.isPrimary || (!touch && event.pointerType !== 'mouse')) return;
        const { currentTarget: element, pointerId, clientX: x, clientY: y } = event;
        suppressClick.current = null;
        if (event.pointerType === 'mouse') element.setPointerCapture(pointerId);
        current.current = { pointerId, handle: element, source, startX: x, startY: y, x, y, started: false, marked: null, frame: 0 };
      },
      onPointerMove(event: PointerEvent<HTMLButtonElement>) {
        const drag = current.current;
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.x = event.clientX;
        drag.y = event.clientY;
        if (!drag.started) {
          if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
          if (!drag.handle.hasPointerCapture(drag.pointerId)) drag.handle.setPointerCapture(drag.pointerId);
          drag.started = true;
          setLabel(optionsRef.current.label(drag.source));
          drag.frame = requestAnimationFrame(() => {
            if (current.current === drag) update(drag);
            scrollNearEdge(drag);
          });
        }
        event.preventDefault();
        update(drag);
      },
      onPointerUp(event: PointerEvent<HTMLButtonElement>) {
        const drag = current.current;
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.x = event.clientX;
        drag.y = event.clientY;
        const found = drag.started ? hit(drag) : null;
        // Après un glissement, le navigateur peut livrer l’appui sans émettre de clic.
        const tappedHandle = touch && event.pointerType !== 'mouse' && !drag.started &&
          drag.handle.contains(document.elementFromPoint(drag.x, drag.y));
        cancel();
        if (found) optionsRef.current.onDrop(drag.source, found.target);
        else if (tappedHandle) {
          suppressClick.current = drag.handle;
          activate();
        }
      },
      onPointerCancel: cancel,
      onLostPointerCapture(event: PointerEvent<HTMLButtonElement>) {
        const drag = current.current;
        if (drag && event.target === drag.handle && event.pointerId === drag.pointerId) cancel();
      },
      onClick(event: MouseEvent<HTMLButtonElement>) {
        if (event.detail !== 0 && suppressClick.current === event.currentTarget) {
          suppressClick.current = null;
          return;
        }
        activate();
      },
    };
  }

  const preview = label && createPortal(
    <div ref={labelRef} aria-hidden="true" style={{ position: 'fixed', zIndex: 1600, top: 0, left: 0, pointerEvents: 'none', maxWidth: 'min(260px, calc(100vw - 16px))', background: '#1d413e', color: 'white', padding: '8px 12px', borderRadius: 9, fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {label}
    </div>, document.body,
  );

  return {
    handle: (source: DocumentItem) => bind(source, () => {
      if (optionsRef.current.enabled) optionsRef.current.onChoose(source);
    }, true),
    surface: (source: DocumentItem, activate: () => void) => bind(source, activate, false),
    preview,
  };
}
