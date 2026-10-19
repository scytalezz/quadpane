'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createUpdateFetch } = require('./update-fetch.cjs');
const API = 'https://api.github.com/repos/scytalezz/quadpane/releases/latest';
const ASSET = 'https://github.com/scytalezz/quadpane/releases/download/v0.9.0/SHA256SUMS.txt';

function fixture(onEnd) {
  const calls = [], requests = [];
  const net = {
    async fetch(url, options) { calls.push({ url, options }); return new Response('body'); },
    request(options) {
      const request = new EventEmitter();
      request.options = options;
      request.abort = () => { request.aborted = true; request.emit('abort'); };
      request.end = () => { queueMicrotask(() => onEnd?.(request)); };
      requests.push(request);
      return request;
    },
  };
  return { fetch: createUpdateFetch(net), calls, requests };
}

test('release API uses Chromium streaming fetch and forbids automatic redirects', async () => {
  const f = fixture();
  await f.fetch(API, { redirect: 'manual', credentials: 'omit' });
  assert.equal(f.requests.length, 0);
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.equal(f.calls[0].options.credentials, 'omit');
});

test('asset HEAD redirect is returned for validation without fetching or following its target', async () => {
  const location = 'https://untrusted.invalid/asset.exe';
  const f = fixture(request => {
    request.emit('redirect', 302, 'HEAD', location);
    request.emit('error', new Error('Redirect was cancelled'));
  });
  const response = await f.fetch(ASSET);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), location);
  assert.equal(f.calls.length, 0);
  assert.equal(f.requests[0].options.method, 'HEAD');
  assert.equal(f.requests[0].options.redirect, 'manual');
  assert.equal(f.requests[0].options.credentials, 'omit');
  assert.equal(f.requests[0].aborted, true);
});

test('approved terminal URL streams through fetch; early Writable close does not lose the response', async () => {
  const f = fixture(request => {
    request.emit('close');
    request.emit('response', new EventEmitter());
  });
  const response = await f.fetch(ASSET, { headers: { Accept: 'application/octet-stream' } });
  assert.equal(await response.text(), 'body');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, ASSET);
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.deepEqual(f.requests[0].options.headers, { Accept: 'application/octet-stream' });
});

test('abort cancels a stalled HEAD and prevents the body request', async () => {
  const f = fixture();
  const controller = new AbortController();
  const result = f.fetch(ASSET, { signal: controller.signal });
  controller.abort(new Error('Timed out'));
  await assert.rejects(result, /Timed out/);
  assert.equal(f.requests[0].aborted, true);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.fetch(ASSET, { signal: controller.signal }), /Timed out/);
  assert.equal(f.requests.length, 1);
});

test('network error and external abort reject without attempting a GET', async () => {
  for (const event of ['error', 'abort']) {
    const f = fixture(request => request.emit(event, new Error('Network failed')));
    await assert.rejects(f.fetch(ASSET), /Network failed|cancelled/);
    assert.equal(f.calls.length, 0);
  }
});
