import { useCallback, useEffect, useRef, useState } from 'react';
import type { DocumentItem } from './components/DocumentExplorerList';
import type { DocumentIds } from './types';

export type SelectedDocuments = Record<DocumentItem['kind'], ReadonlySet<number>>;

const empty: SelectedDocuments = { file: new Set(), folder: new Set() };

export function documentIds(documents: SelectedDocuments): DocumentIds {
  return { fileIds: [...documents.file], folderIds: [...documents.folder] };
}

export default function useDocumentSelection(scope: string) {
  const [state, setState] = useState<{ scope: string; documents: SelectedDocuments } | null>(null);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const documents = state?.scope === scope ? state.documents : null;

  const clear = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setLoading(false);
    setState(null);
  }, []);

  useEffect(() => {
    clear();
    return () => request.current?.abort();
  }, [clear, scope]);

  function start() {
    setState((previous) => previous?.scope === scope ? previous : { scope, documents: empty });
  }

  function toggle({ kind, item }: DocumentItem) {
    if (request.current) return;
    setState((previous) => {
      if (previous?.scope !== scope) return previous;
      const keys = new Set(previous.documents[kind]);
      if (keys.has(item.id)) keys.delete(item.id);
      else keys.add(item.id);
      return { scope, documents: { ...previous.documents, [kind]: keys } };
    });
  }

  async function selectAll(load: (signal: AbortSignal) => Promise<DocumentIds>) {
    if (request.current) return;
    start();
    const pending = new AbortController();
    request.current = pending;
    setLoading(true);
    try {
      const { fileIds, folderIds } = await load(pending.signal);
      if (!pending.signal.aborted) setState({ scope, documents: { file: new Set(fileIds), folder: new Set(folderIds) } });
    } catch (error) {
      if (!pending.signal.aborted) throw error;
    } finally {
      if (request.current === pending) {
        request.current = null;
        setLoading(false);
      }
    }
  }

  return { documents, loading, start, clear, toggle, selectAll };
}
