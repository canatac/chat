import path from 'node:path';
import type { DB } from '../db.js';
import { chunkText } from '../llm/rag.js';
import { isAudioMime } from '../llm/stt.js';
import { extractDocument } from './extract.js';
import { DOCUMENT_LIMITS as limits, DocumentError } from './limits.js';
import type { FileResources } from './resources.js';

interface Room { db: DB; uploadsDir: string; changed: () => void }

/** Une file persistée en SQLite ; un seul worker pour toute la VM. */
export class DocumentQueue {
  private rooms: Room[] = [];
  private cursor = 0;
  private active: Promise<void> | null = null;
  private closed = false;
  private readonly abort = new AbortController();
  constructor(private readonly tikaUrl: string, private readonly chunkSize: number, private readonly resources: FileResources) {}

  register(db: DB, uploadsDir: string, changed: () => void): void {
    db.recoverDocuments();
    this.rooms.push({ db, uploadsDir, changed });
    this.kick();
  }

  enqueue(db: DB, id: number): void {
    const file = db.getFileById(id);
    if (!file) throw new DocumentError(404, 'Fichier introuvable.');
    if (file.document_status === 'processing') throw new DocumentError(409, 'Analyse déjà en cours.');
    const pending = this.rooms.reduce((n, room) => n + room.db.pendingDocuments(), 0);
    if (pending > limits.pending || (file.document_status !== 'pending' && pending >= limits.pending)) {
      db.setDocumentStatus(id, 'blocked', 'File d’analyse pleine (16 documents). Réessayer plus tard.');
    } else db.setDocumentStatus(id, 'pending');
    this.kick();
  }

  private kick(): void {
    if (this.closed || this.active) return;
    this.active = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.run()).finally(() => { this.active = null; });
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      let selected: { room: Room; file: NonNullable<ReturnType<DB['nextDocument']>> } | undefined;
      for (let i = 0; i < this.rooms.length; i++) {
        const room = this.rooms[this.cursor++ % this.rooms.length];
        const file = room.db.nextDocument();
        if (file) { selected = { room, file }; break; }
      }
      if (!selected) return;
      const { room, file } = selected;
      room.db.setDocumentStatus(file.id, 'processing');
      room.changed();
      try {
        if (isAudioMime(file.mime, file.name) || file.mime.startsWith('video/')) throw new DocumentError(415, 'Média : seule sa transcription texte peut être analysée.');
        const text = await extractDocument(path.join(room.uploadsDir, file.path), file.mime, file.name, this.tikaUrl, this.abort.signal);
        if (this.closed || !room.db.getFileById(file.id)) continue;
        // Réserver aussi la croissance SQLite (texte, chunks, index et journal).
        const release = this.resources.reserve(Buffer.byteLength(text) * 4 + 65_536);
        try {
          room.db.transaction(() => {
            room.db.setDocumentStatus(file.id, 'pending');
            room.db.saveDocumentText(file.id, text);
            chunkText(text, this.chunkSize).forEach((chunk, i) => room.db.insertChunk(file.id, i, chunk));
            room.db.setDocumentStatus(file.id, 'ready');
          });
        } finally { release(); }
      } catch (error) {
        if (!this.closed) room.db.setDocumentStatus(file.id, 'blocked', error instanceof DocumentError ? error.message : 'Extraction impossible. Vérifier le fichier puis réessayer.');
      }
      if (!this.closed) room.changed();
    }
  }

  stats() {
    return { pending: this.rooms.reduce((n, room) => n + room.db.pendingDocuments(), 0), running: Boolean(this.active), concurrency: 1 };
  }

  async waitReady(db: DB, id: number): Promise<void> {
    const deadline = Date.now() + limits.timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      const file = db.getFileById(id);
      if (!file) throw new DocumentError(404, 'Fichier introuvable.');
      if (file.document_status === 'ready') return;
      if (file.document_status === 'blocked') throw new DocumentError(422, file.document_error ?? 'Analyse bloquée.');
      await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 50); timer.unref(); });
    }
    throw new DocumentError(409, 'Analyse encore en attente. Réessayer depuis le document.');
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    await this.active;
  }
}
