'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');

test('native helper build compiles both binaries sequentially and stops with a named failure', () => {
  const source = fs.readFileSync(path.join(__dirname, 'build-shell-helper.cjs'), 'utf8');
  function build(results) {
    const calls = [], errors = [];
    let exit;
    try {
      vm.runInNewContext(source, {
        __dirname, console: { error: message => errors.push(message) },
        process: { env: {}, exit(code) { exit = code; throw new Error('test exit'); } },
        require(name) {
          if (name === 'node:fs') return { mkdirSync() {} };
          if (name === 'node:child_process') return { spawnSync(...args) { calls.push(args); return results.shift(); } };
          return require(name);
        },
      });
    } catch (error) { if (error.message !== 'test exit') throw error; }
    return { calls, errors, exit };
  }
  const success = build([{ status: 0 }, { status: 0 }]);
  assert.equal(success.calls.length, 2);
  assert.equal(success.exit, undefined);
  assert.ok(success.calls[0][1].includes('/target:exe'));
  assert.ok(success.calls[1][1].includes('/target:winexe'));
  assert.ok(success.calls[1][1].some(arg => arg.endsWith('Quadpane.Directory.exe')));
  assert.ok(!success.calls[1][1].some(arg => /Windows.Forms|Drawing/u.test(arg)));
  for (const result of [{ status: 7 }, { status: null, error: new Error('compiler missing') }, { status: null, signal: 'SIGTERM' }]) {
    const first = build([result]);
    assert.equal(first.calls.length, 1);
    assert.ok(first.exit > 0);
    assert.match(first.errors[0], /Failed to build Quadpane\.Shell\.exe/u);
    const second = build([{ status: 0 }, result]);
    assert.equal(second.calls.length, 2);
    assert.ok(second.exit > 0);
    assert.match(second.errors[0], /Failed to build Quadpane\.Directory\.exe/u);
  }
});

// Compile private copies only. Never run build-shell-helper or touch its outputs.
test('isolated native directory reader', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quadpane-directory-reader-'));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), path.resolve(directory));
    assert.ok(relative.startsWith('quadpane-directory-reader-') && !relative.includes(path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const executable = path.join(directory, 'Quadpane.Directory.exe');
  const contracts = path.join(directory, 'DirectoryReaderContractTest.exe');
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const source = path.join(__dirname, 'native', 'DirectoryReader.cs');
  for (const [output, target, extra] of [
    [executable, 'winexe', []],
    [contracts, 'exe', ['/main:DirectoryReaderContractTest', path.join(__dirname, 'native', 'DirectoryReaderContractTest.cs')]],
  ]) {
    const result = spawnSync(compiler, ['/nologo', `/target:${target}`, '/platform:x64', '/optimize+',
      '/r:System.Web.Extensions.dll', `/out:${output}`, source, ...extra],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  }

  function run(input, args = []) {
    const result = spawnSync(executable, args, { encoding: 'utf8', input, windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.stderr, '');
    return result;
  }
  function request(id, target, accurate) { return JSON.stringify({ id, path: path.toNamespacedPath(target), accurate }); }
  function batch(targets, accurate) {
    const result = run(targets.map((target, i) => request(i + 1, target, accurate)).join('\n') + '\n');
    assert.equal(result.status, 0, result.stdout);
    assert.ok(!result.stdout.startsWith('\uFEFF'), 'stdout has no BOM');
    const responses = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(responses.map(response => response.id), targets.map((_, i) => i + 1));
    return responses;
  }

  await t.test('PE subsystem is Windows GUI (2), with native metadata/tag contracts', () => {
    const binary = fs.readFileSync(executable);
    const pe = binary.readUInt32LE(0x3c);
    assert.equal(binary.toString('ascii', pe, pe + 4), 'PE\0\0');
    assert.equal(binary.readUInt16LE(pe + 24 + 68), 2, 'GUI subsystem must not allocate a console');
    const result = spawnSync(contracts, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Native reader contracts passed/u);
  });

  const fixture = path.join(directory, 'fixture');
  const empty = path.join(fixture, '빈 폴더');
  fs.mkdirSync(empty, { recursive: true });
  const name = "한글 & ' [literal] ` 😀.txt";
  const filename = path.join(fixture, name);
  const content = Buffer.from('안녕하세요\nactual bytes');
  fs.writeFileSync(filename, content);
  const modified = new Date('2025-02-03T04:05:06.789Z');
  fs.utimesSync(filename, modified, modified);
  const dotFile = path.join(fixture, '.visible');
  fs.writeFileSync(dotFile, 'dot');
  for (const target of [filename, empty]) {
    const result = spawnSync(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'attrib.exe'),
      ['+H', path.toNamespacedPath(target), '/D'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }

  await t.test('UTF-8 names, size, UTC mtime, hidden files/folders and empty vs missing/non-directory', () => {
    const [listing, blank, missing, file, trailing] = batch([fixture, empty, path.join(fixture, 'missing'), filename, fixture + path.sep]);
    assert.equal(listing.ok, true);
    assert.equal(listing.entries.length, 3, 'exclude . and ..');
    assert.deepEqual(listing.entries.find(entry => entry.name === name), {
      name, type: 'file', size: content.length, modified: modified.toISOString(), hidden: true,
    });
    const folder = listing.entries.find(entry => entry.name === '빈 폴더');
    assert.equal(folder.type, 'folder');
    assert.equal(folder.size, null);
    assert.equal(folder.hidden, true);
    assert.equal(listing.entries.find(entry => entry.name === '.visible').hidden, false);
    assert.deepEqual(blank, { id: 2, ok: true, entries: [] });
    assert.equal(missing.ok, false);
    assert.ok([2, 3].includes(missing.error.win32Code));
    assert.ok(!Object.hasOwn(missing, 'entries'));
    assert.deepEqual(file, { id: 4, ok: false, error: { win32Code: 267 } });
    assert.deepEqual(trailing.entries, listing.entries);
  });

  await t.test('multiple requests flush while stdin stays open, then EOF exits the same process', { timeout: 10000 }, async t => {
    const child = spawn(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let errors = '';
    child.stderr.setEncoding('utf8').on('data', data => { errors += data; });
    child.stdin.on('error', () => {});
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    const lines = readline.createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    for (const [id, target, accurate] of [[5, fixture], [17, empty, false], [9007199254740991, fixture, true]]) {
      child.stdin.write(request(id, target, accurate) + '\r\n');
      const next = await iterator.next();
      assert.equal(next.done, false);
      const response = JSON.parse(next.value);
      assert.equal(response.id, id);
      assert.equal(response.ok, true);
      assert.equal(child.exitCode, null);
    }
    child.stdin.end();
    assert.deepEqual(await closed, { code: 0, signal: null });
    assert.equal(errors, '');
    assert.equal((await iterator.next()).done, true);
  });

  await t.test('long Unicode directory paths and junctions use native enumeration', () => {
    const long = path.join(directory, 'long', 'x'.repeat(140), '한'.repeat(140));
    fs.mkdirSync(long, { recursive: true });
    fs.writeFileSync(path.join(long, '끝 😀.txt'), 'long');
    const linkRoot = path.join(directory, 'links');
    fs.mkdirSync(linkRoot);
    const junction = path.join(linkRoot, 'junction');
    fs.symlinkSync(fixture, junction, 'junction');
    const [listing, links, target] = batch([long, linkRoot, junction]);
    assert.equal(listing.ok, true);
    assert.equal(listing.entries[0].name, '끝 😀.txt');
    assert.equal(listing.entries[0].size, 4);
    assert.equal(links.entries[0].isSymbolicLink, true);
    assert.equal(links.entries[0].type, 'folder');
    assert.equal(target.entries.length, 3);
  });

  await t.test('junctions return target metadata, preserve source Hidden, and flag missing targets', () => {
    const links = path.join(directory, 'target-metadata-links');
    const target = path.join(directory, 'hidden-target');
    fs.mkdirSync(links);
    fs.mkdirSync(target);
    const targetTime = new Date('2024-01-02T03:04:05.678Z');
    fs.utimesSync(target, targetTime, targetTime);
    const attributes = spawnSync(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'attrib.exe'),
      ['+H', path.toNamespacedPath(target), '/D'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    assert.equal(attributes.status, 0, attributes.stdout + attributes.stderr);
    fs.symlinkSync(target, path.join(links, 'visible-junction'), 'junction');
    fs.symlinkSync(path.join(directory, 'missing-target'), path.join(links, 'broken-junction'), 'junction');
    for (const accurate of [false, true]) {
      const [response] = batch([links], accurate);
      assert.equal(response.ok, true);
      assert.equal(response.entries.length, 2);
      assert.deepEqual(response.entries.find(entry => entry.name === 'visible-junction'), {
        name: 'visible-junction', type: 'folder', size: null, modified: targetTime.toISOString(), hidden: false, isSymbolicLink: true,
      });
      const broken = response.entries.find(entry => entry.name === 'broken-junction');
      assert.equal(broken.isSymbolicLink, true);
      assert.equal(broken.unavailable, true);
      assert.equal(broken.type, 'folder');
      assert.equal(broken.size, null);
      assert.equal(broken.hidden, false);
      assert.equal(typeof broken.modified, 'string');
    }
  });

  await t.test('file symlinks return target size/mtime and flag missing targets', t => {
    const links = path.join(directory, 'file-links');
    fs.mkdirSync(links);
    try { fs.symlinkSync(filename, path.join(links, 'visible-link.txt'), 'file'); }
    catch (error) {
      if (error.code === 'EPERM' || error.code === 'EACCES') { t.skip('file symlink privilege is unavailable'); return; }
      throw error;
    }
    fs.symlinkSync(path.join(directory, 'missing-file'), path.join(links, 'broken-link.txt'), 'file');
    for (const accurate of [false, true]) {
      const [response] = batch([links], accurate);
      assert.equal(response.ok, true);
      assert.deepEqual(response.entries.find(entry => entry.name === 'visible-link.txt'), {
        name: 'visible-link.txt', type: 'file', size: content.length, modified: modified.toISOString(), hidden: false, isSymbolicLink: true,
      });
      const broken = response.entries.find(entry => entry.name === 'broken-link.txt');
      assert.equal(broken.unavailable, true);
      assert.equal(broken.isSymbolicLink, true);
      assert.equal(broken.type, 'file');
    }
  });

  await t.test('accurate mode refreshes both hard-link names after writing through the other name', () => {
    const hardlinks = path.join(directory, 'hardlinks');
    fs.mkdirSync(hardlinks);
    const original = path.join(hardlinks, 'original.txt');
    const alias = path.join(hardlinks, 'other-name.txt');
    fs.writeFileSync(original, 'old');
    fs.utimesSync(original, modified, modified);
    fs.linkSync(original, alias);
    const updated = Buffer.from('new content written through the other hard-link name');
    const updatedTime = new Date('2025-10-11T12:13:14.567Z');
    fs.writeFileSync(alias, updated);
    fs.utimesSync(alias, updatedTime, updatedTime);
    // NTFS may retain stale per-name enumeration metadata. Fast mode deliberately
    // permits that snapshot; accurate mode must resolve both names via handles.
    const [fast] = batch([hardlinks]);
    assert.equal(fast.ok, true);
    assert.equal(fast.entries.length, 2);
    const [accurate] = batch([hardlinks], true);
    assert.equal(accurate.ok, true);
    assert.deepEqual(accurate.entries.map(entry => entry.name).sort(), ['original.txt', 'other-name.txt']);
    for (const entry of accurate.entries) {
      assert.deepEqual(entry, { name: entry.name, type: 'file', size: updated.length, modified: updatedTime.toISOString(), hidden: false });
    }
  });

  await t.test('accurate accepts only an optional boolean and invalid requests do not stop the service', () => {
    const values = [null, 0, 1, 'true', [], {}];
    const input = values.map((value, index) => request(index + 1, empty, value));
    input.push(request(7, empty, false), request(8, empty, true), request(9, empty));
    const result = run(input.join('\n') + '\n');
    assert.equal(result.status, 0);
    const responses = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(responses.slice(0, values.length), values.map((_, index) => ({ id: index + 1, ok: false, error: { win32Code: 87 } })));
    assert.deepEqual(responses.slice(values.length), [7, 8, 9].map(id => ({ id, ok: true, entries: [] })));
  });

  await t.test('large listings exceed the serializer default without truncation', async () => {
    const large = path.join(directory, 'large');
    fs.mkdirSync(large);
    const count = 6400;
    for (let start = 0; start < count; start += 64) {
      await Promise.all(Array.from({ length: Math.min(64, count - start) }, (_, offset) =>
        fs.promises.writeFile(path.join(large, `${String(start + offset).padStart(5, '0')}-${'x'.repeat(235)}`), '')));
    }
    const result = run(request(1, large) + '\n');
    assert.equal(result.status, 0);
    assert.ok(result.stdout.length > 2097152);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    assert.equal(response.entries.length, count);
    assert.equal(new Set(response.entries.map(entry => entry.name)).size, count);
  });

  await t.test('invalid requests return error 87 and preserve valid ids; later requests still work', () => {
    const input = ['not JSON', '{}', '{"id":0}', '{"id":"2"}', '{"id":1.5}',
      JSON.stringify({ id: 8, path: fixture }), JSON.stringify({ id: 9, path: path.toNamespacedPath(fixture) + '\0suffix' }),
      request(10, empty)].join('\n');
    const result = run(input); // A final line without a newline is still a request.
    assert.equal(result.status, 0);
    const responses = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(responses.slice(0, 7), [0, 0, 0, 0, 0, 8, 9].map(id => ({ id, ok: false, error: { win32Code: 87 } })));
    assert.deepEqual(responses[7], { id: 10, ok: true, entries: [] });
    assert.equal(run('').stdout, '');
    const invalidUtf8 = run(Buffer.from([0xff, 0x0a]));
    assert.notEqual(invalidUtf8.status, 0);
    assert.equal(invalidUtf8.stdout, '');
    assert.notEqual(run('', ['unexpected']).status, 0);
  });

  await t.test('a missing UNC share root returns a native error, never an empty listing', () => {
    const [response] = batch([`\\\\localhost\\quadpane-missing-${path.basename(directory)}\\`]);
    assert.equal(response.ok, false);
    assert.ok(response.error.win32Code > 0);
    assert.ok(!Object.hasOwn(response, 'entries'));
  });

  await t.test('UNC share root with/without trailing slash and subdirectory listing (optional SMB fixture)',
    { skip: !process.env.QUADPANE_DIRECTORY_TEST_UNC }, () => {
      const unc = process.env.QUADPANE_DIRECTORY_TEST_UNC;
      assert.match(unc, /^\\\\/u);
      const root = path.win32.parse(unc).root;
      const targets = [root, root.replace(/\\$/u, ''), unc];
      for (const [index, response] of batch(targets).entries()) {
        assert.equal(response.ok, true, JSON.stringify(response));
        assert.deepEqual(response.entries.map(entry => entry.name).sort(), fs.readdirSync(targets[index]).sort());
      }
    });
});
