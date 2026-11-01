'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createXleClient } = require('../src/main/xle-admin');

const character = { id: 'gnisu', name: 'Gnisu', role: 'coordinator', provider: 'openai',
  enabled: true, provisioned: false, channel_id: null };
const status = { phase: 1, enabled: true, characters: 1, providers: {
  openai: { configured: true, direct_egress_enabled: false },
  xai: { configured: false, direct_egress_enabled: false },
} };
const reply = (data, code = 200) => new Response(JSON.stringify(data), {
  status: code, headers: { 'Content-Type': 'application/json' },
});
function fixture(respond = () => reply(status)) {
  const identity = {};
  let session = { identity, token: 'test-session-only', admin: true };
  const controller = new AbortController();
  const calls = [];
  const client = createXleClient({
    getSession: () => session,
    signal: controller.signal,
    fetch: async (...args) => { calls.push(args); return respond(...args); },
  });
  return { client, calls, controller, setSession: next => { session = next; }, getSession: () => session };
}
const rejects = (promise, key) => assert.rejects(promise, error => error.key === key);

test('XLE requests use fixed same-origin paths and reject redirects with no persistent storage', async () => {
  const f = fixture();
  assert.deepEqual(await f.client.status(), {
    enabled: true, characters: 1, providers: status.providers,
  });
  const [url, options] = f.calls[0];
  assert.equal(url, '/api/xle/status');
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.headers.Authorization, 'Bearer test-session-only');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.body, undefined);
});

test('non-admins, missing tokens and changed identities make no API requests', async () => {
  for (const change of [s => ({ ...s, admin: false }), s => ({ ...s, token: '' }),
    s => ({ ...s, token: 'changed' }), s => ({ ...s, identity: {} })]) {
    const f = fixture();
    f.setSession(change(f.getSession()));
    await rejects(f.client.status(), 'xle.error.session');
    assert.equal(f.calls.length, 0);
  }
});

test('logout during a response discards data and prevents further requests', async () => {
  let resolve;
  const f = fixture(() => new Promise(r => { resolve = r; }));
  const pending = f.client.status();
  f.setSession(null);
  resolve(reply(status));
  await rejects(pending, 'xle.error.session');
  await rejects(f.client.characters(), 'xle.error.session');
  assert.equal(f.calls.length, 1);
});

test('session changes during JSON decoding also discard the result', async () => {
  const f = fixture(() => ({ ok: true, status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => { f.setSession(null); return status; },
  }));
  await rejects(f.client.status(), 'xle.error.session');
});

test('closing a panel cancels requests and rejects late responses', async () => {
  let resolve;
  const f = fixture(() => new Promise(r => { resolve = r; }));
  const pending = f.client.status();
  f.controller.abort();
  assert.equal(f.calls[0][1].signal.aborted, true);
  resolve(reply(status));
  await rejects(pending, 'xle.error.session');
});

test('character responses discard unexpected credential fields', async () => {
  const f = fixture(() => reply({ enabled: true, characters: [
    { ...character, token: 'must-not-surface', webhook_token: 'also-private', personality: 'private canon' },
  ] }));
  assert.deepEqual(await f.client.characters(), { enabled: true, characters: [character] });
});

test('unsafe IDs, invalid channels, empty and oversized prompts never leave the client', async () => {
  const f = fixture();
  for (const id of ['../status', 'gnisu/preview', 'https://example.test', 'GNISU', null]) {
    await rejects(f.client.provision(id, 1), 'xle.error.character');
    await rejects(f.client.preview(id, 'hello'), 'xle.error.character');
  }
  for (const id of [0, -1, 1.1, '10', Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    await rejects(f.client.provision('gnisu', id), 'xle.error.channel');
  }
  for (const prompt of ['', '   ', 'a'.repeat(1001), null]) {
    await rejects(f.client.preview('gnisu', prompt), 'xle.error.prompt');
  }
  assert.equal(f.calls.length, 0);
});

test('provisioning sends only the selected character and channel', async () => {
  const provisioned = { ...character, provisioned: true, channel_id: 10 };
  const f = fixture(() => reply({ character: provisioned }, 201));
  assert.deepEqual(await f.client.provision('gnisu', 10), provisioned);
  const [url, options] = f.calls[0];
  assert.equal(url, '/api/xle/characters/gnisu/provision');
  assert.equal(options.method, 'POST');
  assert.deepEqual(JSON.parse(options.body), { channel_id: 10 });
});

test('preview returns text without interpreting markup and sends no channel or history', async () => {
  const response = '<img src=x onerror="alert(1)">';
  const f = fixture(() => reply({ character_id: 'gnisu', provider: 'openai', response }));
  assert.equal(await f.client.preview('gnisu', '  hello  '), response);
  const [url, options] = f.calls[0];
  assert.equal(url, '/api/xle/characters/gnisu/preview');
  assert.deepEqual(JSON.parse(options.body), { prompt: 'hello' });
});

test('known HTTP failures have actionable messages without exposing server error text', async () => {
  for (const [code, key] of [[401, 'session'], [403, 'forbidden'], [429, 'rateLimit'], [404, 'unavailable']]) {
    const f = fixture(() => reply({ error: 'sensitive server detail' }, code));
    await rejects(f.client.status(), `xle.error.${key}`);
  }
  const unknown = fixture(() => reply({ error: 'secret-key-and-origin-ip' }, 500));
  await rejects(unknown.client.status(), 'xle.error.request');
  const missingLore = fixture(() => reply({ error: 'Character lore has not been provided' }, 409));
  await rejects(missingLore.client.provision('gnisu', 10), 'xle.error.lore');
});

test('HTML fallbacks, network failures and malformed JSON do not leak raw responses', async () => {
  const html = fixture(() => new Response('<html>Login</html>', { headers: { 'content-type': 'text/html' } }));
  await rejects(html.client.status(), 'xle.error.unavailable');
  const network = fixture(() => { throw new Error('private IP and token'); });
  await rejects(network.client.status(), 'xle.error.network');
  const malformed = fixture(() => new Response('{', { headers: { 'content-type': 'application/json' } }));
  await rejects(malformed.client.status(), 'xle.error.invalidResponse');
});

test('incompatible status and duplicate or malformed character records are rejected', async () => {
  for (const data of [{ ...status, phase: 2 }, { ...status, enabled: 'yes' },
    { ...status, providers: {} }, { ...status, characters: 100 }]) {
    await rejects(fixture(() => reply(data)).client.status(), 'xle.error.invalidResponse');
  }
  for (const characters of [[character, character], [{ ...character, id: '../secret' }],
    [{ ...character, channel_id: '10' }], Array(33).fill(character)]) {
    await rejects(fixture(() => reply({ enabled: true, characters })).client.characters(), 'xle.error.invalidResponse');
  }
});

test('mismatched provision and preview responses cannot update the selected character', async () => {
  const f = fixture(() => reply({ character: { ...character, provisioned: true, channel_id: 99 } }));
  await rejects(f.client.provision('gnisu', 10), 'xle.error.invalidResponse');
  for (const data of [
    { character_id: 'da_scribe', provider: 'openai', response: 'wrong character' },
    { character_id: 'gnisu', provider: 'unknown', response: 'wrong provider' },
    { character_id: 'gnisu', provider: 'openai', response: 'x'.repeat(4001) },
  ]) await rejects(fixture(() => reply(data)).client.preview('gnisu', 'hello'), 'xle.error.invalidResponse');
});
