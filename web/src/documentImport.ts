import { api } from './api';

export type ExternalDocument = { kind: 'file'; file: File } | { kind: 'folder'; name: string; children: ExternalDocument[] };

export function documentsFromPicker(files: FileList): ExternalDocument[] {
  const roots: ExternalDocument[] = [];
  for (const file of Array.from(files)) {
    const segments = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(0, -1) : [];
    let siblings = roots;
    for (const name of segments) {
      let folder = siblings.find((entry) => entry.kind === 'folder' && entry.name === name);
      if (!folder || folder.kind !== 'folder') {
        folder = { kind: 'folder', name, children: [] };
        siblings.push(folder);
      }
      siblings = folder.children;
    }
    siblings.push({ kind: 'file', file });
  }
  return roots;
}

export async function documentsFromDrop(data: DataTransfer): Promise<ExternalDocument[]> {
  const roots: ExternalDocument[] = [];
  const entries = Array.from(data.items).filter((item) => item.kind === 'file').map((item) => {
    const entryItem = item as DataTransferItem & { getAsEntry?: () => FileSystemEntry | null };
    return entryItem.getAsEntry?.() ?? item.webkitGetAsEntry?.() ?? item.getAsFile();
  }).filter((entry): entry is File | FileSystemEntry => entry !== null);
  if (!entries.length) return documentsFromPicker(data.files);

  const pending = entries.reverse().map((entry) => ({ entry, siblings: roots }));
  while (pending.length) {
    const { entry, siblings } = pending.pop()!;
    if (entry instanceof File) {
      siblings.push({ kind: 'file', file: entry });
    } else if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      siblings.push({ kind: 'file', file });
    } else if (entry.isDirectory) {
      const children: ExternalDocument[] = [];
      siblings.push({ kind: 'folder', name: entry.name, children });
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const all: FileSystemEntry[] = [];
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) all.push(child);
      }
      for (let index = all.length - 1; index >= 0; index--) pending.push({ entry: all[index], siblings: children });
    }
  }
  return roots;
}

export async function importDocuments(documents: ExternalDocument[], destination: number | null): Promise<string> {
  const pending = documents.slice().reverse().map((document) => ({ document, parentId: destination }));
  let files = 0;
  let folders = 0;
  const summary = () => `${files} fichier${files > 1 ? 's' : ''} et ${folders} dossier${folders > 1 ? 's' : ''} importés`;
  while (pending.length) {
    const { document, parentId } = pending.pop()!;
    try {
      if (document.kind === 'file') {
        await api.uploadFile(document.file, '', false, parentId);
        files++;
      } else {
        const { folder } = await api.createFolder(document.name, parentId);
        folders++;
        for (let index = document.children.length - 1; index >= 0; index--) {
          pending.push({ document: document.children[index], parentId: folder.id });
        }
      }
    } catch (error) {
      const name = document.kind === 'folder' ? document.name : document.file.name;
      const reason = error instanceof Error ? error.message : 'Import impossible';
      throw new Error(`${summary()} avant l’arrêt. « ${name} » · ${reason}`);
    }
  }
  if (folders === 0 && files === 1) return 'Fichier importé.';
  return summary() + '.';
}
