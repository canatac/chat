import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fetchToFile, guessMimeFromUrl, isPrivateHost, parseLienArg, validateLinkUrl } from '../src/llm/link.js';

test('isPrivateHost bloque localhost, IPs privées et métadonnées cloud', () => {
  assert.equal(isPrivateHost('localhost'), true);
  assert.equal(isPrivateHost('127.0.0.1'), true);
  assert.equal(isPrivateHost('10.0.0.5'), true);
  assert.equal(isPrivateHost('192.168.1.10'), true);
  assert.equal(isPrivateHost('172.16.0.2'), true);
  assert.equal(isPrivateHost('169.254.169.254'), true);
  assert.equal(isPrivateHost('::1'), true);
  assert.equal(isPrivateHost('metadata.google.internal'), true);
  assert.equal(isPrivateHost('proxycast.radiofrance.fr'), false);
  assert.equal(isPrivateHost('example.com'), false);
});

test('validateLinkUrl : protocole, SSRF, liste blanche', () => {
  assert.throws(() => validateLinkUrl('ftp://example.com/x', '', false), /Protocole/);
  assert.throws(() => validateLinkUrl('http://127.0.0.1/x', '', false), /SSRF/);
  assert.throws(() => validateLinkUrl('http://169.254.169.254/latest', '', false), /SSRF/);
  assert.throws(() => validateLinkUrl('http://10.1.2.3/x', '', false), /SSRF/);
  assert.throws(() => validateLinkUrl('not a url', '', false), /invalide/);
  assert.equal(validateLinkUrl('http://127.0.0.1/x', '', true).hostname, '127.0.0.1');
  assert.throws(() => validateLinkUrl('https://evil.com/x.m4a', 'radiofrance.fr', false), /non autorisé/);
  assert.equal(
    validateLinkUrl('https://proxycast.radiofrance.fr/x.m4a', 'proxycast.radiofrance.fr', false).hostname,
    'proxycast.radiofrance.fr',
  );
  assert.equal(
    validateLinkUrl('https://cdn.radiofrance.fr/x.m4a', '*.radiofrance.fr', false).hostname,
    'cdn.radiofrance.fr',
  );
});

test('guessMimeFromUrl via extension et content-type', () => {
  assert.equal(guessMimeFromUrl(new URL('https://x.fr/a/b.m4a')), 'audio/mp4');
  assert.equal(guessMimeFromUrl(new URL('https://x.fr/a/b.webm')), 'audio/webm');
  assert.equal(guessMimeFromUrl(new URL('https://x.fr/a/b'), 'audio/mpeg; charset=binary'), 'audio/mpeg');
  assert.equal(guessMimeFromUrl(new URL('https://x.fr/page'), 'text/html'), 'application/octet-stream');
});

test('parseLienArg : url + titre optionnel', () => {
  assert.deepEqual(parseLienArg('https://x.fr/a.m4a Mon émission du 13/11'), {
    url: 'https://x.fr/a.m4a',
    title: 'Mon émission du 13/11',
  });
  assert.deepEqual(parseLienArg('https://x.fr/a.m4a'), { url: 'https://x.fr/a.m4a', title: '' });
  assert.throws(() => parseLienArg('pas une url'), /Usage/);
});

test('fetchToFile : progression (done/total) notifiée pendant le téléchargement, fichier écrit intact', async () => {
  const http = await import('node:http');
  const payload = Buffer.alloc(300 * 1024, 7); // 300 Ko en 3 paquets
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': payload.length });
    res.write(payload.subarray(0, 100 * 1024));
    setTimeout(() => res.write(payload.subarray(100 * 1024, 200 * 1024)), 20);
    setTimeout(() => res.end(payload.subarray(200 * 1024)), 40);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  srv.unref();
  const port = (srv.address() as { port: number }).port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'link-'));
  try {
    const dest = path.join(dir, 'x.m4a');
    const seen: Array<[number, number | null]> = [];
    const { size, contentType } = await fetchToFile(
      new URL(`http://127.0.0.1:${port}/x.m4a`),
      dest,
      10,
      (done, total) => seen.push([done, total]),
    );
    assert.equal(size, payload.length);
    assert.equal(contentType, 'audio/mp4');
    assert.ok(seen.length >= 3, `au moins 3 notifications de progression, reçu ${seen.length}`);
    assert.ok(seen.every(([, total]) => total === payload.length));
    assert.ok(seen[0][0] < seen[seen.length - 1][0], 'progression croissante');
    assert.equal(seen[seen.length - 1][0], payload.length);
    assert.equal(fs.statSync(dest).size, payload.length);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
