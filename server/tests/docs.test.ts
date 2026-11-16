import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { createServer, type ServerContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let ctx: ServerContext;
let baseUrl: string;
let dir: string;
let token: string;
let uploadsDir: string;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-docs-'));
  const config = loadConfig({ ...process.env, DATA_DIR: dir, JWT_SECRET: 'test-secret-123456', LLM_MODEL: '' });
  ctx = createServer(config, dir);
  await new Promise<void>((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
  const address = ctx.server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const reg = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Alice', email: 'alice@example.test', password: 'motdepasse1' }),
  });
  assert.equal(reg.status, 201);
  const session = (await reg.json()) as { token: string; roomId: number };
  token = session.token;
  uploadsDir = path.join(dir, 'rooms', String(session.roomId), 'uploads');
});

after(async () => {
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

interface FolderBody {
  id: number;
  name: string;
  parentId: number | null;
  createdBy: { name: string };
}
interface FileBody {
  id: number;
  name: string;
  folderId: number | null;
  updatedAt: string | null;
  user: { name: string };
}
interface EventBody {
  action: string;
  detail: string;
  user: { name: string };
  fileId: number | null;
  folderId: number | null;
}

function j(pathname: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });
}

async function upload(name: string, content: string, folderId?: number | null): Promise<FileBody> {
  const fd = new FormData();
  fd.append('file', new Blob([content]), name);
  fd.append('post', 'false');
  if (folderId !== undefined && folderId !== null) fd.append('folderId', String(folderId));
  const res = await fetch(`${baseUrl}/api/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { file: FileBody }).file;
}

async function mkFolder(name: string, parentId: number | null = null): Promise<FolderBody> {
  const res = await j('/api/folders', { method: 'POST', body: JSON.stringify({ name, parentId }) });
  assert.equal(res.status, 201);
  return ((await res.json()) as { folder: FolderBody }).folder;
}

test('dossiers : création, doublon 409, sous-dossier, renommage, déplacement avec anti-cycle', async () => {
  const root = await mkFolder('Projets');
  assert.equal(root.parentId, null);
  assert.equal(root.createdBy.name, 'Alice');

  const dup = await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'projets', parentId: null }) });
  assert.equal(dup.status, 409);

  const sub = await mkFolder('2026', root.id);
  assert.equal(sub.parentId, root.id);

  // renommage
  const ren = await j(`/api/folders/${root.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Projets 2025' }) });
  assert.equal(ren.status, 200);
  assert.equal(((await ren.json()) as { folder: FolderBody }).folder.name, 'Projets 2025');

  // anti-cycle : parent = soi-même, puis parent = son propre sous-dossier
  const selfMove = await j(`/api/folders/${root.id}`, { method: 'PATCH', body: JSON.stringify({ parentId: root.id }) });
  assert.equal(selfMove.status, 409);
  const cycle = await j(`/api/folders/${root.id}`, { method: 'PATCH', body: JSON.stringify({ parentId: sub.id }) });
  assert.equal(cycle.status, 409);

  // déplacement valide vers la racine
  const move = await j(`/api/folders/${sub.id}`, { method: 'PATCH', body: JSON.stringify({ parentId: null }) });
  assert.equal(move.status, 200);
  assert.equal(((await move.json()) as { folder: FolderBody }).folder.parentId, null);

  // parent inconnu
  const badParent = await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'X', parentId: 9999 }) });
  assert.equal(badParent.status, 404);
});

test('fichiers : upload racine, déplacement dans un dossier, filtre folder=, renommage + conflit 409, détail + historique', async () => {
  const f1 = await upload('note.txt', 'contenu de test');
  assert.equal(f1.folderId, null);

  const folder = await mkFolder('Archives');
  const moved = await j(`/api/files/${f1.id}`, { method: 'PATCH', body: JSON.stringify({ folderId: folder.id }) });
  assert.equal(moved.status, 200);
  assert.equal(((await moved.json()) as { file: FileBody }).file.folderId, folder.id);

  const rootList = await j('/api/files?folder=root&limit=200');
  assert.ok(!((await rootList.json()) as { files: FileBody[] }).files.some((f) => f.id === f1.id));
  const inFolder = await j(`/api/files?folder=${folder.id}&limit=200`);
  assert.ok(((await inFolder.json()) as { files: FileBody[] }).files.some((f) => f.id === f1.id));
  const all = await j('/api/files?limit=200');
  assert.ok(((await all.json()) as { files: FileBody[] }).files.some((f) => f.id === f1.id));

  // renommage + conflit de nom dans le dossier cible
  const ren = await j(`/api/files/${f1.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'note-renommee.txt' }) });
  assert.equal(ren.status, 200);
  const f2 = await upload('note-renommee.txt', 'autre', folder.id); // même nom dans le même dossier
  const conflict = await j(`/api/files/${f1.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'note-renommee.txt' }) });
  assert.equal(conflict.status, 409);

  // dossier cible invalide
  const badFolder = await j(`/api/files/${f1.id}`, { method: 'PATCH', body: JSON.stringify({ folderId: 424242 }) });
  assert.equal(badFolder.status, 404);

  // détail : métadonnées + chemin de dossiers + journal
  const detail = await j(`/api/files/${f1.id}`);
  assert.equal(detail.status, 200);
  const d = (await detail.json()) as { file: FileBody & { createdAt: string; updatedAt: string | null }; folderPath: FolderBody[]; history: EventBody[] };
  assert.equal(d.file.name, 'note-renommee.txt');
  assert.equal(d.file.folderId, folder.id);
  assert.ok(d.file.updatedAt !== null);
  assert.equal(d.folderPath.length, 1);
  assert.equal(d.folderPath[0].name, 'Archives');
  const actions = d.history.map((e) => e.action);
  assert.ok(actions.includes('file_created'));
  assert.ok(actions.includes('file_moved'));
  assert.ok(actions.includes('file_renamed'));

  // upload direct dans un dossier
  const f3 = await upload('rapport.md', '# rapport', folder.id);
  assert.equal(f3.folderId, folder.id);

  // suppression : row + disque + événement
  // le nom stocké conserve le nom d'origine à l'upload ('note.txt'), pas le nom renommé
  const stored = fs.readdirSync(uploadsDir).find((n) => n.endsWith('note.txt'));
  assert.ok(stored);
  const del = await j(`/api/files/${f1.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const gone = await j(`/api/files/${f1.id}`);
  assert.equal(gone.status, 404);
  assert.ok(!fs.existsSync(path.join(uploadsDir, stored)));
  const events = await j('/api/events?limit=500');
  const evs = (await events.json()) as { events: EventBody[] };
  assert.ok(evs.events.some((e) => e.action === 'file_deleted' && e.fileId === f1.id));
});

test('dossier non vide : DELETE 409 avec compteurs, puis recursive=1 supprime tout (fichiers + sous-dossiers + événements)', async () => {
  const a = await mkFolder('A');
  const b = await mkFolder('B', a.id);
  const f = await upload('doc.txt', 'x', a.id);
  const f2 = await upload('doc2.txt', 'y', b.id);

  const notEmpty = await j(`/api/folders/${a.id}`, { method: 'DELETE' });
  assert.equal(notEmpty.status, 409);
  const counts = ((await notEmpty.json()) as { counts: { folders: number; files: number; directFolders: number; directFiles: number } }).counts;
  assert.equal(counts.folders, 1); // sous-dossier B
  assert.equal(counts.files, 2); // doc.txt (dans A) + doc2.txt (dans B)
  assert.equal(counts.directFiles, 1);

  const rec = await j(`/api/folders/${a.id}?recursive=1`, { method: 'DELETE' });
  assert.equal(rec.status, 200);
  const recBody = (await rec.json()) as { deletedFolders: number; deletedFiles: number };
  assert.equal(recBody.deletedFolders, 2);
  assert.equal(recBody.deletedFiles, 2);

  const folders = (await (await j('/api/folders')).json()) as { folders: FolderBody[] };
  assert.ok(!folders.folders.some((f) => f.id === a.id || f.id === b.id));
  assert.equal((await j(`/api/files/${f.id}`)).status, 404);
  assert.equal((await j(`/api/files/${f2.id}`)).status, 404);

  const events = (await (await j('/api/events?limit=500')).json()) as { events: EventBody[] };
  assert.ok(events.events.some((e) => e.action === 'file_deleted' && e.fileId === f.id));
  assert.ok(events.events.some((e) => e.action === 'folder_deleted' && e.folderId === a.id));
});

test('tri et filtres des fichiers avant la pagination, avec un ordre stable à taille égale', async () => {
  const folder = await mkFolder('Tri et filtres');
  const zebra = await upload('Zèbre.txt', 'z', folder.id);
  const teamA = await upload('Équipe-a.txt', 'a'.repeat(1024), folder.id);
  const alpha = await upload('Alpha.txt', 'a'.repeat(1024), folder.id);
  const teamB = await upload('équipe-b.txt', 'b'.repeat(4096), folder.id);
  await upload('équipe-b-hors-dossier.txt', 'b'.repeat(4096));

  const jan17 = Date.UTC(2026, 0, 17);
  const jan18 = Date.UTC(2026, 0, 18);
  const jan19 = Date.UTC(2026, 0, 19);
  const database = new DatabaseSync(path.join(path.dirname(uploadsDir), 'chat.db'));
  try {
    const stamp = database.prepare('UPDATE files SET created_at = ?, updated_at = ? WHERE id = ?');
    stamp.run(jan17, null, zebra.id);
    stamp.run(jan17, jan19, teamA.id);
    stamp.run(jan18, null, alpha.id);
    stamp.run(jan19 - 1, null, teamB.id);
  } finally {
    database.close();
  }

  const from = '/api/files?folder=' + folder.id;
  const list = async (params: string) => {
    const response = await j(from + params);
    assert.equal(response.status, 200);
    return await response.json() as { files: FileBody[]; nextBefore: number | null };
  };
  const byName = await list('&sort=name&direction=asc');
  assert.deepEqual(byName.files.map(({ id }) => id), [alpha.id, teamA.id, teamB.id, zebra.id]);
  const byDate = await list('&sort=date&direction=desc');
  assert.deepEqual(byDate.files.map(({ id }) => id), [teamA.id, teamB.id, alpha.id, zebra.id]);

  const firstPage = await list('&sort=size&direction=asc&limit=2');
  assert.deepEqual(firstPage.files.map(({ id }) => id), [zebra.id, teamA.id]);
  assert.equal(firstPage.nextBefore, teamA.id);
  const secondPage = await list('&sort=size&direction=asc&limit=2&before=' + firstPage.nextBefore);
  assert.deepEqual(secondPage.files.map(({ id }) => id), [alpha.id, teamB.id]);
  assert.equal(secondPage.nextBefore, null);

  const latest = await list('&sort=date&direction=desc&limit=1');
  assert.equal(latest.nextBefore, teamA.id);
  const previous = await list('&sort=date&direction=desc&limit=1&before=' + latest.nextBefore);
  assert.deepEqual(previous.files.map(({ id }) => id), [teamB.id]);

  const onTheDay = await list('&sort=date&activityFrom=' + jan18 + '&activityBefore=' + jan19);
  assert.deepEqual(onTheDay.files.map(({ id }) => id), [alpha.id, teamB.id]);
  const filtered = await list('&sort=size&direction=asc&limit=1&name=EQUIPE&query=-b&minBytes=4096&maxBytes=4096');
  assert.deepEqual(filtered.files.map(({ id }) => id), [teamB.id]);
  assert.equal(filtered.nextBefore, null);

  assert.equal((await j(from + '&minBytes=5&maxBytes=4')).status, 400);
  assert.equal((await j(from + '&activityFrom=2&activityBefore=1')).status, 400);
  assert.equal((await j(from + '&sort=unknown')).status, 400);
});

test('docsChanged est diffusé en WebSocket lors d une mutation documentaire', async () => {
  const ws = new WebSocket(`${baseUrl.replace('http', 'ws')}/ws?token=${token}`);
  await new Promise<void>((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  try {
    const seen = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout docsChanged')), 5000);
      ws.on('message', (data: WebSocket.RawData) => {
        const ev = JSON.parse(data.toString()) as Record<string, unknown>;
        if (ev.type === 'docsChanged') {
          clearTimeout(timer);
          resolve(ev);
        }
      });
    });
    const res = await j('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'WS-Events', parentId: null }) });
    assert.equal(res.status, 201);
    await seen;
  } finally {
    ws.close();
  }
});
