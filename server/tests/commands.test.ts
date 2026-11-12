import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildUserPrompt, COMMAND_HELP, formatContext, parseCommand } from '../src/llm/commands.js';

test('parseCommand renvoie null pour un message normal', () => {
  assert.equal(parseCommand('bonjour tout le monde'), null);
  assert.equal(parseCommand('  salut  '), null);
});

test('parseCommand reconnaît les commandes', () => {
  assert.deepEqual(parseCommand('/resume'), { name: 'resume', arg: '' });
  assert.deepEqual(parseCommand('/resume 20'), { name: 'resume', arg: '20' });
  assert.deepEqual(parseCommand('/solve le serveur ne répond plus'), {
    name: 'solve',
    arg: 'le serveur ne répond plus',
  });
  assert.deepEqual(parseCommand('/ASK quelle heure est-il ?'), { name: 'ask', arg: 'quelle heure est-il ?' });
  assert.equal(parseCommand('/aide')?.name, 'help');
  assert.equal(parseCommand('/help')?.name, 'help');
});

test('parseCommand renvoie help pour une commande inconnue', () => {
  assert.equal(parseCommand('/inconnu xyz')?.name, 'help');
});

test('buildUserPrompt intègre le contexte et la question', () => {
  const prompt = buildUserPrompt({ name: 'ask', arg: 'quel est le budget ?' }, '10:00 Alice : le budget est de 5k');
  assert.match(prompt, /10:00 Alice : le budget est de 5k/);
  assert.match(prompt, /quel est le budget \?/);
});

test('buildUserPrompt resume mentionne le nombre de messages', () => {
  const prompt = buildUserPrompt({ name: 'resume', arg: '30' }, 'ctx');
  assert.match(prompt, /30 derniers messages/);
  const fallback = buildUserPrompt({ name: 'resume', arg: 'abc' }, 'ctx');
  assert.match(fallback, /50 derniers messages/);
});

test('buildUserPrompt solve intègre le problème', () => {
  const prompt = buildUserPrompt({ name: 'solve', arg: 'panne imprimante' }, 'ctx');
  assert.match(prompt, /panne imprimante/);
  assert.match(prompt, /pistes de solution/);
});

test('formatContext formate heure, auteur et contenu', () => {
  const out = formatContext([
    { id: 1, user_id: 2, name: 'Alice', content: 'Salut', created_at: Date.UTC(2026, 0, 1, 10, 5) },
  ]);
  assert.match(out, /Alice : Salut/);
  assert.match(out, /\d{2}:\d{2}/);
});

test('COMMAND_HELP liste les commandes', () => {
  assert.match(COMMAND_HELP, /\/resume/);
  assert.match(COMMAND_HELP, /\/solve/);
  assert.match(COMMAND_HELP, /\/ask/);
});
