'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createUpdateService, MAX_DOWNLOAD_BYTES, CHECK_TIMEOUT_MS } = require('./update-service.cjs');

const API = 'https://api.github.com/repos/scytalezz/quadpane/releases/latest';
const REPO = 'https://github.com/scytalezz/quadpane';
const CONTENT = Buffer.from('portable executable fixture\0\x01\x02');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const filename = (version = '0.10.0') => `quadpane-${version}-portable-x64.exe`;
const downloadUrl = (name, version = '0.10.0') => `${REPO}/releases/download/v${version}/${name}`;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function releaseFixture({ version = '0.10.0', content = CONTENT, sums } = {}) {
  sums ??= `${digest(content)}  ${filename(version)}\n`;
  return {
    release: {
      tag_name: `v${version}`, draft: false, prerelease: false,
      html_url: `${REPO}/releases/tag/v${version}`,
      assets: [
        { name: filename(version), size: content.length, browser_download_url: downloadUrl(filename(version), version) },
        { name: 'SHA256SUMS.txt', size: Buffer.byteLength(sums), browser_download_url: downloadUrl('SHA256SUMS.txt', version) },
      ],
    },
    content, sums,
  };
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quadpane-update-test-'));
  const data = releaseFixture(options);
  if (options.modify) options.modify(data.release);
  const calls = [];
  const changes = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.credentials, 'omit');
    assert.ok(init.signal instanceof AbortSignal);
    if (options.fetch) {
      const response = await options.fetch(url, init, { ...data, directory, calls });
      if (response !== undefined) return response;
    }
    if (url === API) return Response.json(data.release);
    if (url === downloadUrl('SHA256SUMS.txt', options.version)) return new Response(data.sums);
    if (url === downloadUrl(filename(options.version), options.version)) return new Response(data.content);
    assert.fail(`Unexpected request: ${url}`);
  };
  const service = createUpdateService({
    currentVersion: options.currentVersion ?? '0.9.0', portableDirectory: directory,
    enabled: options.enabled ?? true, fetch: fetchFn,
    onChange: (state) => { changes.push(state); options.onChange?.(state); },
  });
  t.after(async () => {
    await service.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { service, directory, calls, changes, ...data, finalPath: path.join(directory, filename(options.version)) };
}

async function assertClean(directory, expected = []) {
  assert.deepEqual((await fs.readdir(directory)).sort(), [...expected].sort());
}

test('disabled/development service never performs network or filesystem work', async () => {
  let calls = 0;
  const service = createUpdateService({ currentVersion: '0.9.0', enabled: false, fetch: () => { calls++; } });
  assert.equal(service.getState().status, 'unsupported');
  assert.equal((await service.check()).status, 'unsupported');
  assert.equal((await service.download()).status, 'unsupported');
  await service.close();
  assert.equal(calls, 0);
});

test('no automatic network: check exposes only JSON-safe state and validated release URL', async (t) => {
  const f = await fixture(t, { onChange: (state) => { state.currentVersion = 'subscriber mutation'; } });
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.getState().status, 'idle');
  const state = await f.service.check();
  assert.deepEqual(state, {
    currentVersion: '0.9.0', status: 'available', latestVersion: '0.10.0', progress: null,
    message: '새 버전 0.10.0을 다운로드할 수 있습니다.', releaseUrl: `${REPO}/releases/tag/v0.10.0`,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  assert.equal(f.calls.length, 1);
  state.status = 'ready';
  assert.equal(f.service.getState().status, 'available');
  await assertClean(f.directory);
});

test('versions use numeric ordering, never downgrade, and exclude draft/prerelease', async (t) => {
  for (const [currentVersion, version, expected] of [
    ['0.9.0', '0.10.0', 'available'], ['0.10.0', '0.9.0', 'current'],
    ['0.9.0', '0.9.0', 'current'], ['0.9.10', '0.9.9', 'current'],
    ['9.99.99', '10.0.0', 'available'], ['0.9.9', '0.9.10', 'available'],
  ]) {
    const f = await fixture(t, { version, currentVersion });
    assert.equal((await f.service.check()).status, expected, `${currentVersion} -> ${version}`);
  }
  for (const flag of ['draft', 'prerelease']) {
    const f = await fixture(t, { modify: (release) => { release[flag] = true; } });
    assert.equal((await f.service.check()).status, 'current');
    assert.equal(f.service.getState().releaseUrl, null);
    assert.equal((await f.service.download()).status, 'error');
    assert.equal(f.calls.length, 1);
  }
});

test('strict bounded stable tags reject prefixes, suffixes, leading zeroes and huge components', async (t) => {
  for (const tag of ['0.10.0', 'V0.10.0', 'v01.10.0', 'v0.10', 'v0.10.0-beta.1', 'v0.10.0+build',
    'v1000000000.0.0', 'v99999999999999999999999999.0.0', 'v0.-1.0', 'v0.10.0\n', null]) {
    const f = await fixture(t, { modify: (release) => { release.tag_name = tag; } });
    assert.equal((await f.service.check()).status, 'error', String(tag));
    assert.equal(f.service.getState().releaseUrl, null);
  }
  assert.throws(() => createUpdateService({ currentVersion: '0.9.0+bad' }), { code: 'INVALID_RELEASE' });
});

test('latest 404 has no update; offline, invalid JSON and oversized JSON produce inline errors', async (t) => {
  const noRelease = await fixture(t, { fetch: () => new Response('', { status: 404 }) });
  assert.equal((await noRelease.service.check()).status, 'current');
  for (const response of [
    () => { throw new Error('private system/network details'); },
    () => new Response('', { status: 403 }),
    () => new Response('{bad'),
    () => new Response('null'),
    () => new Response('x', { headers: { 'Content-Length': '1048577' } }),
    () => new Response(' '.repeat(1048577)),
  ]) {
    const f = await fixture(t, { fetch: response });
    const state = await f.service.check();
    assert.equal(state.status, 'error');
    assert.doesNotMatch(state.message, /private system/);
    assert.match(state.message, /[가-힣]/u);
    assert.equal(f.calls.length, 1);
  }
});

test('release and initial asset URLs must match the exact fixed repository, tag and filename', async (t) => {
  const good = downloadUrl(filename());
  const unsafe = [
    good.replace('https:', 'http:'), good.replace('scytalezz', 'attacker'),
    good.replace('github.com', 'github.com.evil.test'), good.replace('github.com', 'user@github.com'),
    good.replace('github.com', 'github.com:443'), `${good}?x=1`, `${good}#fragment`, `${good}/`,
    good.replace('v0.10.0', 'v0.11.0'), good.replace('quadpane-0.10.0', 'quadpane-0.10.1'),
    'https://release-assets.githubusercontent.com/file', good.replace('/quadpane/releases/', '/quadpane/../quadpane/releases/'),
  ];
  for (const url of unsafe) {
    const f = await fixture(t, { modify: (release) => { release.assets[0].browser_download_url = url; } });
    assert.equal((await f.service.check()).status, 'error', url);
    assert.equal(f.calls.length, 1);
  }
  for (const url of [`${REPO}/releases/tag/v0.10.0?x=1`, 'https://evil.test/release', `${REPO}/releases/tag/v0.9.0`]) {
    const f = await fixture(t, { modify: (release) => { release.html_url = url; } });
    assert.equal((await f.service.check()).status, 'error');
  }
});

test('missing, duplicate and malformed assets and unsafe sizes are rejected', async (t) => {
  const modifications = [
    (r) => { r.assets.pop(); }, (r) => { r.assets.shift(); },
    (r) => { r.assets.push({ ...r.assets[0] }); },
    (r) => { r.assets.push({ ...r.assets[1] }); },
    (r) => { r.assets.push(null); }, (r) => { r.assets = {}; },
    (r) => { r.assets[1].browser_download_url += '?bad'; },
    (r) => { r.assets[1].size = 65537; },
    ...[0, -1, 1.5, '10', MAX_DOWNLOAD_BYTES + 1, Number.MAX_SAFE_INTEGER].map((size) => (r) => { r.assets[0].size = size; }),
  ];
  for (const modify of modifications) {
    const f = await fixture(t, { modify });
    assert.equal((await f.service.check()).status, 'error');
    assert.equal((await f.service.download()).status, 'error');
    assert.equal(f.calls.length, 1);
  }
});

test('download streams verified bytes, accepts CRLF and binary sums, and preserves running exe/data', async (t) => {
  const sums = `${digest(Buffer.from('other'))}  other.exe\r\n${digest(CONTENT).toUpperCase()} *${filename()}\r\n`;
  const f = await fixture(t, { sums, fetch: (url) => {
    if (!url.endsWith('.exe')) return undefined;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(CONTENT.subarray(0, 5));
      controller.enqueue(CONTENT.subarray(5));
      controller.close();
    } }), { headers: { 'Content-Length': String(CONTENT.length) } });
  } });
  await fs.writeFile(path.join(f.directory, 'quadpane-0.9.0-portable-x64.exe'), 'running old exe');
  await fs.mkdir(path.join(f.directory, 'quadpane-data'));
  await fs.writeFile(path.join(f.directory, 'quadpane-data', 'session.json'), 'user data');
  await f.service.check();
  assert.equal(f.calls.length, 1);
  assert.equal((await f.service.download()).status, 'ready');
  assert.deepEqual(await fs.readFile(f.finalPath), CONTENT);
  assert.equal(await f.service.verifyReady('renderer-controlled-path.exe'), f.finalPath);
  assert.equal(f.service.getState().currentVersion, '0.9.0');
  assert.equal(f.service.getState().progress, 100);
  assert.ok(f.changes.some((state) => state.progress > 0 && state.progress < 100));
  assert.equal(await fs.readFile(path.join(f.directory, 'quadpane-0.9.0-portable-x64.exe'), 'utf8'), 'running old exe');
  assert.equal(await fs.readFile(path.join(f.directory, 'quadpane-data', 'session.json'), 'utf8'), 'user data');
  await assertClean(f.directory, [filename(), 'quadpane-0.9.0-portable-x64.exe', 'quadpane-data']);
  assert.equal((await f.service.check()).status, 'ready');
  assert.equal((await f.service.download()).status, 'ready');
  assert.equal(f.calls.length, 3);
});

test('checksum must have one exact matching line; bad, duplicate, missing and path-alias lines fail', async (t) => {
  const valid = `${digest(CONTENT)}  ${filename()}\n`;
  for (const sums of [
    valid + valid, `${digest(CONTENT)}  other.exe\n`, `${digest(CONTENT)}  ./${filename()}\n`,
    `bad  ${filename()}\n`, `${digest(CONTENT)} ${filename()}\n`, `${valid}malformed\n`,
    `${digest(CONTENT)}  ${filename()}\r`, `${digest(CONTENT)}  ${filename()} \n`,
  ]) {
    const f = await fixture(t, { sums });
    await f.service.check();
    assert.equal((await f.service.download()).status, 'error');
    assert.equal(f.calls.length, 2);
    await assertClean(f.directory);
  }
});

test('checksum mismatch leaves no partial file and a retry uses validated release metadata', async (t) => {
  let attempt = 0;
  const f = await fixture(t, { fetch: (url) => {
    if (url.endsWith('.exe') && attempt++ === 0) return new Response(Buffer.alloc(CONTENT.length));
    return undefined;
  } });
  await f.service.check();
  assert.equal((await f.service.download()).status, 'error');
  assert.match(f.service.getState().message, /검증/u);
  await assertClean(f.directory);
  assert.equal((await f.service.download()).status, 'ready');
  assert.equal(f.calls.filter((call) => call.url === API).length, 1);
  assert.equal(await f.service.verifyReady(), f.finalPath);
});

test('truncation, excess bytes, invalid Content-Length and stream errors remove staging', async (t) => {
  const responses = [
    () => new Response(CONTENT.subarray(0, -1)),
    () => new Response(Buffer.concat([CONTENT, Buffer.from('extra')])),
    () => new Response(CONTENT, { headers: { 'Content-Length': String(CONTENT.length - 1) } }),
    () => new Response(CONTENT, { headers: { 'Content-Length': String(MAX_DOWNLOAD_BYTES + 1) } }),
    () => new Response(CONTENT, { headers: { 'Content-Length': 'NaN' } }),
    () => new Response(new ReadableStream({ start(c) { c.enqueue(CONTENT.subarray(0, 4)); c.error(new Error('broken')); } })),
  ];
  for (const response of responses) {
    const f = await fixture(t, { fetch: (url) => url.endsWith('.exe') ? response() : undefined });
    await f.service.check();
    assert.equal((await f.service.download()).status, 'error');
    await assertClean(f.directory);
    assert.equal(f.service.getState().progress, null);
  }
});

test('checksum body is bounded and its declared release size is enforced', async (t) => {
  for (const response of [
    () => new Response('x'.repeat(65537)),
    () => new Response('x', { headers: { 'Content-Length': '65537' } }),
    () => new Response('short'),
  ]) {
    const f = await fixture(t, { fetch: (url) => url.endsWith('SHA256SUMS.txt') ? response() : undefined });
    await f.service.check();
    assert.equal((await f.service.download()).status, 'error');
    assert.equal(f.calls.length, 2);
    await assertClean(f.directory);
  }
});

test('redirects permit exact official HTTPS CDN hosts and use manual handling on every hop', async (t) => {
  for (const host of ['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']) {
    const target = `https://${host}/github-production-release-asset/123/file?token=fixture`;
    const f = await fixture(t, { fetch: (url) => {
      if (url.endsWith('.exe')) return new Response(null, { status: 302, headers: { Location: target } });
      if (url === target) return new Response(CONTENT);
      return undefined;
    } });
    await f.service.check();
    assert.equal((await f.service.download()).status, 'ready');
    assert.equal(f.calls.at(-1).url, target);
  }
});

test('redirects reject untrusted hosts, credentials, explicit ports, other repo paths and non-HTTPS', async (t) => {
  for (const location of [
    'https://evil.test/file', 'http://release-assets.githubusercontent.com/file',
    'https://release-assets.githubusercontent.com.evil.test/file',
    'https://user:password@release-assets.githubusercontent.com/file',
    'https://release-assets.githubusercontent.com:443/file',
    'https://release-assets.githubusercontent.com:8080/file',
    'https://release-assets.githubusercontent.com/file#fragment',
    'https://github.com/attacker/repo/releases/download/v0.10.0/file.exe',
    'file:///C:/Windows/file.exe', '//release-assets.githubusercontent.com/file', '/relative/file',
  ]) {
    const f = await fixture(t, { fetch: (url) => url.endsWith('.exe')
      ? new Response(null, { status: 302, headers: { Location: location } }) : undefined });
    await f.service.check();
    assert.equal((await f.service.download()).status, 'error', location);
    assert.equal(f.calls.length, 3);
    await assertClean(f.directory);
  }
});

test('redirect loops, redirected API and fetch adapters following redirects are rejected', async (t) => {
  const loop = 'https://release-assets.githubusercontent.com/loop';
  const f = await fixture(t, { fetch: (url) => {
    if (url.endsWith('.exe') || url === loop) return new Response(null, { status: 307, headers: { Location: loop } });
    return undefined;
  } });
  await f.service.check();
  assert.equal((await f.service.download()).status, 'error');
  assert.equal(f.calls.length, 8);
  await assertClean(f.directory);
  const apiRedirect = await fixture(t, { fetch: () => new Response(null, { status: 302, headers: { Location: API } }) });
  assert.equal((await apiRedirect.service.check()).status, 'error');
  assert.equal(apiRedirect.calls.length, 1);
  for (const properties of [{ redirected: { value: true } }, { url: { value: 'https://evil.test/file' } }]) {
    const adapter = await fixture(t, { fetch: (_url, _init, data) => Object.defineProperties(Response.json(data.release), properties) });
    assert.equal((await adapter.service.check()).status, 'error');
  }
});

test('existing matching executable is reused without downloading or overwriting it', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.finalPath, CONTENT);
  const before = await fs.stat(f.finalPath);
  await f.service.check();
  assert.equal((await f.service.download()).status, 'ready');
  const after = await fs.stat(f.finalPath);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(f.calls.length, 2);
  assert.equal(await f.service.verifyReady(), f.finalPath);
});

test('existing conflicting file or directory remains intact and stops the download', async (t) => {
  for (const directory of [false, true]) {
    const f = await fixture(t);
    if (directory) await fs.mkdir(f.finalPath);
    else await fs.writeFile(f.finalPath, Buffer.alloc(CONTENT.length, 0x61));
    await f.service.check();
    assert.equal((await f.service.download()).status, 'error');
    assert.match(f.service.getState().message, /같은 이름/u);
    assert.equal(f.calls.length, 2);
    if (directory) assert.ok((await fs.stat(f.finalPath)).isDirectory());
    else assert.deepEqual(await fs.readFile(f.finalPath), Buffer.alloc(CONTENT.length, 0x61));
    await assertClean(f.directory, [filename()]);
  }
});

test('atomic link never clobbers a file created while the download is in flight', async (t) => {
  for (const matching of [false, true]) {
    const collision = matching ? CONTENT : Buffer.alloc(CONTENT.length, 0x72);
    const f = await fixture(t, { fetch: async (url, _init, data) => {
      if (url.endsWith('.exe')) {
        await fs.writeFile(path.join(data.directory, filename()), collision);
        return new Response(CONTENT);
      }
      return undefined;
    } });
    await f.service.check();
    assert.equal((await f.service.download()).status, matching ? 'ready' : 'error');
    assert.deepEqual(await fs.readFile(f.finalPath), collision);
    await assertClean(f.directory, [filename()]);
  }
});

test('exFAT/FAT fallback exclusively copies, syncs and verifies when hard links are unsupported', async (t) => {
  for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP']) {
    const link = t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported'), { code }); });
    const f = await fixture(t);
    await f.service.check();
    assert.equal((await f.service.download()).status, 'ready', code);
    assert.equal(link.mock.callCount(), 1);
    assert.deepEqual(await fs.readFile(f.finalPath), CONTENT);
    assert.equal(await f.service.verifyReady(), f.finalPath);
    await assertClean(f.directory, [filename()]);
    link.mock.restore();
  }
});

test('exclusive-copy fallback preserves same-name races and reuses only matching bytes', async (t) => {
  for (const matching of [false, true]) {
    const collision = matching ? CONTENT : Buffer.alloc(CONTENT.length, 0x69);
    const link = t.mock.method(fs, 'link', async (_source, destination) => {
      await fs.writeFile(destination, collision);
      throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' });
    });
    const f = await fixture(t);
    await f.service.check();
    assert.equal((await f.service.download()).status, matching ? 'ready' : 'error');
    assert.deepEqual(await fs.readFile(f.finalPath), collision);
    await assertClean(f.directory, [filename()]);
    link.mock.restore();
  }
});

test('exclusive-copy fallback removes its own partial destination on write failure or abort', async (t) => {
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }); });
  const originalOpen = fs.open;
  for (const abort of [false, true]) {
    const f = await fixture(t);
    const open = t.mock.method(fs, 'open', async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === f.finalPath && args[1] === 'wx') {
        const writeFile = handle.writeFile.bind(handle);
        t.mock.method(handle, 'writeFile', async (bytes) => {
          await writeFile(bytes.subarray(0, 4));
          if (abort) { void f.service.close(); return; }
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        });
      }
      return handle;
    });
    await f.service.check();
    const state = await f.service.download();
    if (!abort) { assert.equal(state.status, 'error'); assert.match(state.message, /남은 공간/u); }
    await assertClean(f.directory);
    open.mock.restore();
  }
});

test('exclusive-copy fallback rehashes after sync and removes a corrupt copy', async (t) => {
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('unsupported'), { code: 'ENOTSUP' }); });
  const f = await fixture(t);
  const originalOpen = fs.open;
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === f.finalPath && args[1] === 'wx') {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, 'sync', async () => {
        await handle.write(Buffer.from('corrupt'), 0, 7, 0);
        await sync();
      });
    }
    return handle;
  });
  await f.service.check();
  assert.equal((await f.service.download()).status, 'error');
  assert.match(f.service.getState().message, /검증/u);
  await assertClean(f.directory);
});

test('other hard-link failures do not silently fall back to a copy', async (t) => {
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  const f = await fixture(t);
  await f.service.check();
  assert.equal((await f.service.download()).status, 'error');
  await assertClean(f.directory);
});

test('parallel clicks deduplicate checks and downloads; check cannot replace downloading or ready', async (t) => {
  const apiGate = deferred();
  const downloadGate = deferred();
  const downloadStarted = deferred();
  const f = await fixture(t, { fetch: async (url) => {
    if (url === API) await apiGate.promise;
    if (url.endsWith('.exe')) { downloadStarted.resolve(); await downloadGate.promise; }
    return undefined;
  } });
  const checking = f.service.check();
  assert.strictEqual(f.service.check(), checking);
  const downloading = f.service.download();
  assert.strictEqual(f.service.download(), downloading);
  assert.strictEqual(f.service.check(), downloading);
  apiGate.resolve();
  await downloadStarted.promise;
  assert.equal(f.service.getState().status, 'downloading');
  assert.strictEqual(f.service.check(), downloading);
  downloadGate.resolve();
  assert.equal((await downloading).status, 'ready');
  assert.equal(f.calls.length, 3);
  assert.equal((await f.service.check()).status, 'ready');
  assert.equal(f.calls.length, 3);
});

test('close aborts a pending check even if the adapter ignores the signal; no later events/network', async (t) => {
  const started = deferred();
  const f = await fixture(t, { fetch: () => { started.resolve(); return new Promise(() => {}); } });
  const checking = f.service.check();
  await started.promise;
  const eventCount = f.changes.length;
  await f.service.close();
  await checking;
  assert.equal(f.calls[0].init.signal.aborted, true);
  await f.service.check();
  await f.service.download();
  assert.equal(f.calls.length, 1);
  assert.equal(f.changes.length, eventCount);
});

test('close during an executable body read cancels the stream and removes partial files', async (t) => {
  const started = deferred();
  let cancelled = false;
  const f = await fixture(t, { fetch: (url) => {
    if (!url.endsWith('.exe')) return undefined;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(CONTENT.subarray(0, 4)); },
      pull() { started.resolve(); return new Promise(() => {}); },
      cancel() { cancelled = true; },
    }));
  } });
  await f.service.check();
  const downloading = f.service.download();
  await started.promise;
  await f.service.close();
  await downloading;
  assert.equal(cancelled, true);
  assert.equal(f.calls.at(-1).init.signal.aborted, true);
  await assertClean(f.directory);
});

test('timeout aborts a stalled request and permits a fresh manual retry', async (t) => {
  let stalled = true;
  const started = deferred();
  const f = await fixture(t, { fetch: () => {
    if (stalled) { started.resolve(); return new Promise(() => {}); }
    return undefined;
  } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const checking = f.service.check();
  await started.promise;
  t.mock.timers.tick(CHECK_TIMEOUT_MS);
  assert.equal((await checking).status, 'error');
  assert.match(f.service.getState().message, /시간이 초과/u);
  assert.equal(f.calls[0].init.signal.aborted, true);
  stalled = false;
  assert.equal((await f.service.check()).status, 'available');
});

for (const reason of ['close', 'timeout']) {
  test(`${reason} during a chunk write observes an aborted stream read and cleans partial bytes`, async (t) => {
    let interrupted = false;
    const f = await fixture(t, { fetch: (url, { signal }) => {
      if (!url.endsWith('.exe')) return undefined;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(CONTENT.subarray(0, 4));
        signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      } }));
    } });
    const originalOpen = fs.open;
    t.mock.method(fs, 'open', async (...args) => {
      const handle = await originalOpen(...args);
      if (args[1] === 'wx') {
        const write = handle.writeFile.bind(handle);
        t.mock.method(handle, 'writeFile', async bytes => {
          await write(bytes);
          if (!interrupted) {
            interrupted = true;
            if (reason === 'close') void f.service.close();
            else t.mock.timers.tick(10 * 60_000);
          }
        });
      }
      return handle;
    });
    await f.service.check();
    if (reason === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
    const result = await f.service.download();
    if (reason === 'timeout') assert.match(result.message, /시간이 초과/u);
    await f.service.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(interrupted, true);
    await assertClean(f.directory);
  });
}

test('verifyReady rehashes the selected path and rejects same-size tampering or removal', async (t) => {
  for (const remove of [false, true]) {
    const f = await fixture(t);
    await f.service.check();
    await f.service.download();
    if (remove) await fs.unlink(f.finalPath);
    else await fs.writeFile(f.finalPath, Buffer.alloc(CONTENT.length, 0x78));
    const verification = f.service.verifyReady();
    assert.strictEqual(f.service.verifyReady(), verification);
    await assert.rejects(verification, { code: 'FILE_CHANGED' });
    assert.equal(f.service.getState().status, 'error');
    assert.equal(f.calls.length, 3);
  }
});

test('downloads require an explicit successful check and verifyReady requires validated ready bytes', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.service.download()).status, 'error');
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.service.verifyReady(), { code: 'NOT_READY' });
  await f.service.close();
  await assert.rejects(f.service.verifyReady(), { code: 'CLOSED' });
  assert.equal(f.calls.length, 0);
});
