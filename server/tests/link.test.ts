import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guessMimeFromUrl, isPrivateHost, parseLienArg, validateLinkUrl } from '../src/llm/link.js';

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
