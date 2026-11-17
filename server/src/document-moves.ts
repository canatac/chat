import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { DB } from './db.js';

type DocumentKind = 'file' | 'folder';
type DestinationRow = ReturnType<DB['listMoveNames']>[number];
type MoveSource = DestinationRow & { kind: DocumentKind };

const sourceFields = { kind: z.enum(['file', 'folder']), id: z.number().int().positive().safe() };
const newName = z.string().trim().min(1).max(255);
export const moveDecision = z.discriminatedUnion('action', [
  z.object({ ...sourceFields, action: z.literal('skip') }),
  z.object({ ...sourceFields, action: z.literal('rename'), name: newName }),
  z.object({ ...sourceFields, action: z.literal('replace'), token: z.string().regex(/^[a-f0-9]{64}$/), name: newName.optional() }),
]).refine((choice) => choice.kind !== 'folder' || choice.action === 'skip' || (choice.name?.length ?? 0) <= 120);
type MoveDecision = z.infer<typeof moveDecision>;

export interface MoveConflict {
  kind: DocumentKind;
  id: number;
  sourceName: string;
  name: string;
  existing: number;
  reason: 'destination' | 'planned' | 'selection';
  replaceToken: string | null;
  changed: boolean;
}

export class MoveConflicts extends Error {
  constructor(readonly conflicts: MoveConflict[]) {
    const first = conflicts[0];
    super(`Le ${first.kind === 'file' ? 'fichier' : 'dossier'} « ${first.name} » est en double à la destination.`);
  }
}

type SelectedIds = Record<DocumentKind, ReadonlySet<number>>;

// Les fichiers et les dossiers ont chacun leur espace de noms.
function nameKey(kind: DocumentKind, name: string): string {
  return kind + ':' + name.normalize('NFC').toLowerCase();
}

function replacement(db: DB, kind: DocumentKind, existing: DestinationRow[], selected: SelectedIds) {
  const ids = existing.map(({ id }) => id);
  if (kind === 'file') return { protected: ids.some((id) => selected.file.has(id)), rows: existing };
  const folders = db.listFolderTree(ids);
  const files = db.listFilesInFolders(folders.map(({ id }) => id));
  return {
    protected: folders.some(({ id }) => selected.folder.has(id)) || files.some(({ id }) => selected.file.has(id)),
    rows: [folders.sort((a, b) => a.id - b.id), files.sort((a, b) => a.id - b.id)],
  };
}

export function planDocumentMove(db: DB, sources: MoveSource[], destination: number | null, selected: SelectedIds, decisions: MoveDecision[]) {
  const atDestination = new Map<string, DestinationRow[]>();
  for (const kind of new Set(sources.map((source) => source.kind))) {
    for (const row of db.listMoveNames(kind, destination)) {
      const key = nameKey(kind, row.name);
      const rows = atDestination.get(key) ?? [];
      rows.push(row);
      atDestination.set(key, rows);
    }
  }

  const choices = new Map(decisions.map((decision) => [`${decision.kind}:${decision.id}`, decision]));
  const reserved = new Set<string>();
  const waiting = new Set<string>();
  const conflicts: MoveConflict[] = [];
  const moves: { kind: DocumentKind; id: number; sourceName: string; name: string }[] = [];
  const replaced: Record<DocumentKind, number[]> = { file: [], folder: [] };
  let skipped = 0;

  for (const source of sources) {
    const { kind, id } = source;
    const choice = choices.get(`${kind}:${id}`);
    if (choice?.action === 'skip') {
      skipped++;
      continue;
    }
    const name = choice?.name ?? source.name;
    const key = nameKey(kind, name);
    if (waiting.has(key)) continue;

    const existing = atDestination.get(key) ?? [];
    const takenByAnotherMove = reserved.has(key);
    if (existing.length || takenByAnotherMove) {
      const preview = takenByAnotherMove ? null : replacement(db, kind, existing, selected);
      const replaceToken = preview && !preview.protected
        ? createHash('sha256').update(JSON.stringify([destination, source, name, preview.rows])).digest('hex')
        : null;
      if (replaceToken && choice?.action === 'replace' && choice.token === replaceToken) {
        for (const row of existing) replaced[kind].push(row.id);
        atDestination.delete(key);
      } else {
        waiting.add(key);
        conflicts.push({
          kind, id, sourceName: source.name, name, existing: existing.length,
          reason: takenByAnotherMove ? 'planned' : preview?.protected ? 'selection' : 'destination',
          replaceToken,
          changed: choice?.action === 'replace',
        });
        continue;
      }
    }

    reserved.add(key);
    moves.push({ kind, id, sourceName: source.name, name });
  }

  if (conflicts.length) throw new MoveConflicts(conflicts);
  return { moves, replaced, skipped };
}
