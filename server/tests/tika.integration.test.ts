import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { extractDocument } from '../src/documents/extract.js';

const url = process.env.TIKA_TEST_URL;
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/documents');

test('Tika réel : PDF texte, PDF scanné, image et image intégrée dans Word', { skip: !url, timeout: 180_000 }, async () => {
  for (const name of ['text.pdf', 'scan.pdf', 'contact.png', 'office.docx']) {
    const text = await extractDocument(path.join(fixtures, name), 'application/octet-stream', name, url);
    assert.match(text, /alice@example\.test/i, name);
  }
});

test('Tika réel : refuse un PDF de 21 pages et un document chiffré', { skip: !url, timeout: 180_000 }, async () => {
  for (const name of ['too-many-pages.pdf', 'encrypted.pdf']) {
    await assert.rejects(extractDocument(path.join(fixtures, name), 'application/pdf', name, url));
  }
});
