import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DB } from '../src/db.js';
import { buildDocsSection, chunkText, retrieveRelevantChunks, tokenize } from '../src/llm/rag.js';

test('tokenize enlève stopwords, accents et ponctuation', () => {
  const t = tokenize("Aujourd'hui, quel est le BUDGET prévu ?");
  assert.ok(!t.includes('est'));
  assert.ok(!t.includes('quel'));
  assert.ok(t.includes('budget'));
  assert.ok(t.includes('aujourdhui'));
});

test('chunkText découpe en chunks de taille bornée', () => {
  const text = Array.from({ length: 50 }, (_, i) => `Paragraphe ${i} avec du contenu sur le projet Alpha.`).join('\n\n');
  const chunks = chunkText(text, 500, 100);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 500));
  assert.ok(chunks.join(' ').includes('Paragraphe 49'));
});

test('retrieveRelevantChunks retrouve le bon document et buildDocsSection le cite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-test-'));
  const db = new DB(dir);
  try {
    const user = db.createUser('Alice', 'x');
    const f1 = db.insertFile(user.id, null, 'rapport-budget.txt', 'text/plain', 10, 'a.txt');
    const f2 = db.insertFile(user.id, null, 'recette-cuisine.txt', 'text/plain', 10, 'b.txt');
    db.insertChunk(f1.id, 0, "Le budget 2026 de l'entreprise est de 50000 euros, validé en comité.");
    db.insertChunk(f2.id, 0, 'Pour la recette du gâteau, il faut 200g de farine et 3 œufs.');
    const hits = retrieveRelevantChunks(db, 'quel est le budget 2026 ?', 3);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].fileName, 'rapport-budget.txt');
    assert.ok(hits[0].score > 0);
    const docs = buildDocsSection(hits);
    assert.match(docs, /rapport-budget\.txt/);
    assert.match(docs, /50000/);
    const none = retrieveRelevantChunks(db, 'zzz qqq', 3);
    assert.equal(none.length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
