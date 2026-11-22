import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import multer from 'multer';
import type { RequestHandler } from 'express';
import { DocumentError, MiB } from './limits.js';

/** Une instance par serveur, partagée entre TOUS les salons et tous les producteurs. */
export class FileResources {
  private reserved = 0;
  private writers = 0;
  constructor(readonly root: string, readonly maxBytes: number, readonly minFreeBytes: number) {}

  usedBytes(directory = this.root): number {
    let bytes = 0;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) bytes += this.usedBytes(item);
      else if (entry.isFile()) bytes += fs.statSync(item).size;
    }
    return bytes;
  }

  reserve(bytes: number): () => void {
    const stat = fs.statfsSync(this.root);
    if (bytes < 0 || this.usedBytes() + this.reserved + bytes > this.maxBytes) throw new DocumentError(507, 'Quota global de fichiers atteint. Supprimer des fichiers puis réessayer.');
    if (stat.bavail * stat.bsize - this.reserved - bytes < this.minFreeBytes) throw new DocumentError(507, 'Espace disque insuffisant. Libérer de l’espace puis réessayer.');
    this.reserved += bytes;
    let released = false;
    return () => { if (!released) { this.reserved -= bytes; released = true; } };
  }

  writer(bytes: number): () => void {
    if (this.writers >= 2) throw new DocumentError(429, 'Deux dépôts ou téléchargements sont déjà en cours. Réessayer plus tard.');
    const release = this.reserve(bytes);
    this.writers++;
    let released = false;
    return () => { if (!released) { release(); this.writers--; released = true; } };
  }

  writeText(filePath: string, text: string): void {
    const release = this.reserve(Buffer.byteLength(text));
    let fd: number | undefined;
    try { fd = fs.openSync(filePath, 'wx'); fs.writeFileSync(fd, text); }
    catch (error) { if (fd !== undefined) fs.rmSync(filePath, { force: true }); throw error; }
    finally { if (fd !== undefined) fs.closeSync(fd); release(); }
  }

  upload(directory: string, maxMb: number): RequestHandler {
    const maxBytes = maxMb * MiB;
    const signals = new WeakMap<object, AbortSignal>();
    const storage: multer.StorageEngine = {
      _handleFile: (req, file, cb) => {
        const filename = `${Date.now()}-${randomUUID()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)}`;
        const target = path.join(directory, filename);
        let size = 0;
        const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          callback(size > maxBytes ? new DocumentError(413, `Fichier limité à ${maxMb} Mio.`) : null, chunk);
        } });
        const signal = signals.get(req)!;
        void pipeline(file.stream, counter, fs.createWriteStream(target, { flags: 'wx' }), { signal }).then(() => {
          cb(null, { path: target, destination: directory, filename, size });
        }, (error) => {
          fs.rmSync(target, { force: true });
          cb(signal.aborted ? new DocumentError(408, 'Dépôt interrompu ou délai de 60 secondes dépassé.') : error);
        });
      },
      _removeFile: (_req, file, cb) => { fs.rm(file.path, { force: true }, cb); },
    };
    const parse = multer({ storage, limits: { fileSize: maxBytes, files: 1, fields: 12, parts: 14, fieldSize: 16 * 1024, fieldNameSize: 100 } }).single('file');
    return (req, res, next) => {
      let release: () => void;
      try { release = this.writer(maxBytes); } catch (error) {
        if (error instanceof DocumentError && error.statusCode === 429) res.setHeader('Retry-After', '5');
        res.status(error instanceof DocumentError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'Dépôt impossible.' });
        return;
      }
      const abort = new AbortController();
      signals.set(req, abort.signal);
      const onAbort = () => { abort.abort(); release(); };
      const timer = setTimeout(() => {
        abort.abort();
        if (!res.headersSent) res.status(408).json({ error: 'Délai de dépôt de 60 secondes dépassé.' });
        req.destroy();
      }, 60_000);
      timer.unref();
      req.once('aborted', onAbort);
      const cleanup = () => { clearTimeout(timer); req.off('aborted', onAbort); res.off('close', cleanup); release(); };
      res.once('close', cleanup);
      parse(req, res, (error: unknown) => {
        cleanup();
        if (res.headersSent || res.destroyed) return;
        if (!error) { next(); return; }
        const status = error instanceof DocumentError ? error.statusCode : error instanceof multer.MulterError ? 413 : 500;
        if (status === 429) res.setHeader('Retry-After', '5');
        res.status(status).json({ error: error instanceof DocumentError ? error.message : error instanceof multer.MulterError ? `Dépôt limité à un fichier de ${maxMb} Mio et des champs de 16 Kio.` : 'Impossible d’enregistrer le fichier.' });
      });
    };
  }
}
