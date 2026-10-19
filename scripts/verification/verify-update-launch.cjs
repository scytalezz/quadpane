'use strict';

// node scripts/verification/verify-update-launch.cjs <dependencies/node_modules> <candidate.exe> <0.9.1-fixture.exe>
// Both EXEs must already be built. This verifies a MOCKED future GitHub release,
// using the real backend, preload IPC, download adapter, and app.relaunch.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { createRequire } = require('node:module');
const { promisify } = require('node:util');

const project = path.resolve(__dirname, '..', '..');
const futureVersion = '0.9.1';
const futureFilename = `quadpane-${futureVersion}-portable-x64.exe`;
const latestURL = 'https://api.github.com/repos/scytalezz/quadpane/releases/latest';
const releaseURL = `https://github.com/scytalezz/quadpane/releases/tag/v${futureVersion}`;
const assetBase = `https://github.com/scytalezz/quadpane/releases/download/v${futureVersion}/`;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const execFileAsync = promisify(execFile);

async function bounded(promise, description, timeout = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function waitFor(probe, description, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await probe();
    if (value) return value;
    await delay(150);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`);
}

async function reservePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index++) {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      servers.push(server);
    }
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

// Use the Node inspector directly: Playwright's Electron launch assumes its
// child is Electron, while an NSIS portable child first extracts another EXE.
async function connectInspector(port, checkLauncher) {
  const target = await waitFor(async () => {
    checkLauncher?.();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return (await response.json()).find(item => item.webSocketDebuggerUrl);
    } catch { /* NSIS is still extracting or the main process is starting. */ }
    return null;
  }, `main-process inspector on ${port}`, 60000);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let sequence = 0;
  const pending = new Map();
  const rejectPending = error => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  socket.addEventListener('close', () => rejectPending(new Error('Main inspector disconnected')));
  socket.addEventListener('error', () => rejectPending(new Error('Main inspector socket failed')));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Main inspector connection timed out')); }, 10000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Main inspector connection failed')); }, { once: true });
  });
  return {
    async evaluate(expression) {
      const result = await new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Main inspector evaluation timed out')); }, 15000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: {
          expression, awaitPromise: true, returnByValue: true,
        } }));
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2000);
        socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.close();
      });
    },
  };
}

// This function is serialized into the packaged MAIN process, never imported
// by the app. Do not replace any IPC handler, update service, or app.getVersion.
async function patchMain(config) {
  const req = typeof require === 'function' ? require
    : process.mainModule?.require.bind(process.mainModule)
      || process.getBuiltinModule('module').createRequire(`${process.resourcesPath}/app.asar/package.json`);
  const { app, net, BrowserWindow, session } = req('electron');
  const fs = req('node:fs');
  const assert = req('node:assert/strict');
  const { EventEmitter } = req('node:events');
  const { Readable } = req('node:stream');
  await app.whenReady();
  assert.ok(app.commandLine.hasSwitch('pane-smoke-test'), 'Both launches must be hidden smoke launches');
  assert.ok(app.isPackaged, 'The fixture must be an actual packaged portable');
  assert.equal(process.env.PORTABLE_EXECUTABLE_FILE, config.executable);
  const evidence = { mockedFutureRelease: true, requests: [], unexpectedRequests: [], blockedNetwork: [],
    streamBytes: 0, streamChunks: 0, relaunch: null };
  const json = JSON.stringify(config.release);
  function record(transport, url, options) {
    evidence.requests.push({ transport, url, method: options.method || 'GET', redirect: options.redirect });
    const allowed = transport === 'net.request'
      ? [config.checksumURL, config.executableURL] : [config.latestURL, config.checksumURL, config.executableURL];
    if (!allowed.includes(url)) {
      evidence.unexpectedRequests.push({ transport, url });
      throw new Error(`Fixture refuses real network: ${url}`);
    }
  }
  net.request = options => {
    record('net.request', options.url, options);
    assert.equal(options.method, 'HEAD');
    assert.equal(options.redirect, 'manual');
    const request = new EventEmitter();
    let aborted = false;
    request.abort = () => {
      if (aborted) return;
      aborted = true;
      request.emit('abort');
      request.emit('close');
    };
    request.end = () => queueMicrotask(() => {
      if (aborted) return;
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-length': [String(options.url === config.executableURL ? config.size : Buffer.byteLength(config.sums))] };
      request.emit('response', response);
    });
    return request;
  };
  net.fetch = async (url, options = {}) => {
    record('net.fetch', url, options);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    options.signal?.throwIfAborted();
    if (url === config.executableURL) {
      const input = fs.createReadStream(config.fixture, { highWaterMark: 64 * 1024, signal: options.signal });
      async function* chunks() {
        for await (const chunk of input) {
          evidence.streamBytes += chunk.length;
          evidence.streamChunks++;
          yield chunk;
        }
      }
      return new Response(Readable.toWeb(Readable.from(chunks(), { objectMode: false })), {
        status: 200, headers: { 'content-length': String(config.size), 'content-type': 'application/octet-stream' },
      });
    }
    const body = url === config.latestURL ? json : config.sums;
    return new Response(body, { status: 200, headers: {
      'content-length': String(Buffer.byteLength(body)), 'content-type': url === config.latestURL ? 'application/json' : 'text/plain',
    } });
  };
  // Any accidental underlying HTTP(S) traffic is cancelled, never passed on.
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    evidence.blockedNetwork.push(details.url);
    callback({ cancel: true });
  });
  for (const window of BrowserWindow.getAllWindows()) {
    assert.equal(window.isVisible(), false);
    window.webContents.setBackgroundThrottling(false);
  }
  if (config.nextArgs) {
    const realRelaunch = app.relaunch;
    app.relaunch = function (options) {
      evidence.relaunch = { production: options, testArgs: config.nextArgs, realRelaunchCalled: false };
      fs.writeFileSync(config.relaunchEvidence, JSON.stringify(evidence, null, 2));
      assert.deepEqual(options.args, [], 'Production relaunch must discard inherited/debug arguments');
      assert.equal(options.execPath, config.nextExecutable, 'Production must relaunch the verified downloaded EXE');
      assert.equal(app.commandLine.hasSwitch('pane-smoke-test'), true);
      const result = Reflect.apply(realRelaunch, app, [{ ...options, args: config.nextArgs }]);
      evidence.relaunch.realRelaunchCalled = true;
      fs.writeFileSync(config.relaunchEvidence, JSON.stringify(evidence, null, 2));
      return result;
    };
  }
  globalThis.__portableUpdateVerification = evidence;
  return {
    pid: process.pid, parentPid: process.ppid, version: app.getVersion(), executable: process.execPath,
    portableExecutable: process.env.PORTABLE_EXECUTABLE_FILE, portableDirectory: process.env.PORTABLE_EXECUTABLE_DIR,
    profile: app.getPath('userData'), session: app.getPath('sessionData'),
    windowsHidden: BrowserWindow.getAllWindows().every(window => !window.isVisible()),
  };
}

async function main() {
  assert.equal(process.platform, 'win32', 'This verifier runs actual Windows portable EXEs');
  assert.ok(process.argv[3] && process.argv[4], 'Usage: node verify-update-launch.cjs <dependencies/node_modules> <candidate.exe> <0.9.1-fixture.exe>');
  const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
  const { chromium } = dependencies('playwright');
  const candidate = path.resolve(process.argv[3]);
  const fixture = path.resolve(process.argv[4]);
  for (const filename of [candidate, fixture]) {
    assert.equal(path.extname(filename).toLowerCase(), '.exe');
    assert.ok(fs.statSync(filename).isFile(), `Missing portable fixture: ${filename}`);
  }
  const [candidateHash, fixtureHash] = await Promise.all([hashFile(candidate), hashFile(fixture)]);
  assert.notEqual(candidateHash, fixtureHash, 'The future fixture must be a separate 0.9.1 build');
  const runRoot = path.join(project, '.checks', 'update-launch', `run-${Date.now()}-${randomUUID().slice(0, 8)}`);
  const portableRoot = path.join(runRoot, '업데이트 한글 경로');
  const temporaryRoot = path.join(runRoot, 'runtime');
  const dataRoot = path.join(portableRoot, 'quadpane-data');
  const firstExecutable = path.join(portableRoot, path.basename(candidate));
  const nextExecutable = path.join(portableRoot, futureFilename);
  assert.notEqual(firstExecutable.toLowerCase(), nextExecutable.toLowerCase(), 'Candidate must precede the 0.9.1 fixture');
  fs.mkdirSync(temporaryRoot, { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'profile'), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, 'session'), { recursive: true });
  fs.copyFileSync(candidate, firstExecutable);
  const folders = ['작업 A', '작업 B', '작업 C', '작업 D'].map(name => path.join(runRoot, '실제 파일', name));
  for (const [index, folder] of folders.entries()) {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `확인 ${index + 1}.txt`), `update fixture ${index + 1}`);
  }
  const pane = (folder, index) => ({ path: folder, sort: index % 2 ? 'modified' : 'name', direction: index % 2 ? -1 : 1 });
  const seedSession = { version: 1, workspaceId: 'design', workspaces: {
    design: { layout: 4, active: 0, panes: folders.map(pane) },
    documents: { layout: 2, active: 1, panes: [...folders].reverse().map(pane) },
  } };
  const seedPreferences = { favorites: [{ path: folders[3], label: '업데이트 보존 즐겨찾기' }],
    recentPaths: [folders[2], folders[1]], showHidden: true, showExtensions: true };
  const marker = randomUUID();
  const markerFiles = ['profile', 'session'].map(directory => path.join(dataRoot, directory, 'update-verification-marker.txt'));
  for (const filename of markerFiles) fs.writeFileSync(filename, marker);
  fs.writeFileSync(path.join(dataRoot, 'session.json'), JSON.stringify(seedSession));
  fs.writeFileSync(path.join(dataRoot, 'preferences.json'), JSON.stringify(seedPreferences));
  assert.ok(process.env.APPDATA, 'APPDATA is needed to verify real taskbar pins');
  const pinnedDirectory = path.join(process.env.APPDATA, 'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar');
  const snapshotPins = () => ({ exists: fs.existsSync(pinnedDirectory), links: fs.existsSync(pinnedDirectory)
    ? Object.fromEntries(fs.readdirSync(pinnedDirectory).filter(name => name.toLowerCase().endsWith('.lnk')).sort().map(name => {
      const filename = path.join(pinnedDirectory, name);
      return [name, { sha256: createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), mtimeMs: fs.statSync(filename).mtimeMs }];
    })) : {} });
  const pinsBefore = snapshotPins();
  const size = fs.statSync(fixture).size;
  const sums = `${fixtureHash}  ${futureFilename}\n`;
  const config = { fixture, size, sums, latestURL, checksumURL: `${assetBase}SHA256SUMS.txt`, executableURL: `${assetBase}${futureFilename}`,
    release: { tag_name: `v${futureVersion}`, draft: false, prerelease: false, html_url: releaseURL,
      assets: [{ name: futureFilename, size, browser_download_url: `${assetBase}${futureFilename}` },
        { name: 'SHA256SUMS.txt', size: Buffer.byteLength(sums), browser_download_url: `${assetBase}SHA256SUMS.txt` }] } };
  const report = { passed: false, mockedFutureRelease: true,
    scope: 'Synthetic GitHub v0.9.1 metadata and network; actual separately built portable EXE, backend, IPC, download and Electron relaunch.',
    candidate, candidateHash, fixture, fixtureHash, size, runRoot, observations: [], ownedProcesses: [] };
  const browsers = [];
  const inspectors = [];
  const errors = [];
  let launcher;
  let launchedChild;
  let firstPage;
  let secondPage;
  let installed = false;
  const ownPrefix = `${runRoot}${path.sep}`.toLowerCase();
  const insideRun = filename => typeof filename === 'string' && path.resolve(filename).toLowerCase().startsWith(ownPrefix);
  // TEMP/TMP keep NSIS extraction under this unique run. Discover detached
  // relaunch descendants by their actual executable path, never by image name.
  async function ownedProcesses() {
    const prefixLiteral = ownPrefix.replace(/'/g, "''");
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); @(Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith('${prefixLiteral}', [StringComparison]::OrdinalIgnoreCase) } | Select-Object @{Name='ProcessId';Expression={$_.Id}},@{Name='ExecutablePath';Expression={$_.Path}},@{Name='Created';Expression={$_.StartTime.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    const parsed = stdout.trim() ? JSON.parse(stdout.replace(/^\uFEFF/, '')) : [];
    const processes = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of processes) {
      assert.ok(insideRun(item.ExecutablePath), 'Process ownership must be confined to this run');
      if (!report.ownedProcesses.some(saved => saved.ProcessId === item.ProcessId && saved.Created === item.Created)) report.ownedProcesses.push(item);
    }
    return processes;
  }
  async function cleanup() {
    const failures = [];
    for (const inspector of inspectors) await inspector.close().catch(error => failures.push(error.message));
    for (const page of [secondPage, firstPage]) {
      if (page && !page.isClosed()) await bounded(page.close(), 'closing owned renderer').catch(error => failures.push(error.message));
    }
    // Kill only processes whose current executable still belongs to this run.
    // Revalidate PID + creation time in PowerShell before touching a PID.
    const deadline = Date.now() + 20000;
    let quietSince;
    while (Date.now() < deadline) {
      const processes = await ownedProcesses();
      if (!processes.length) {
        quietSince ??= Date.now();
        if (Date.now() - quietSince >= 3000) break;
        await delay(300);
        continue;
      }
      quietSince = undefined;
      for (const item of processes) {
        const script = `$p=Get-Process -Id ${Number(item.ProcessId)} -ErrorAction SilentlyContinue; if ($p -and $p.StartTime.ToUniversalTime().ToString('o') -eq '${item.Created}' -and $p.Path -and $p.Path.StartsWith('${ownPrefix.replace(/'/g, "''")}', [StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $p.Id -Force -ErrorAction Stop }`;
        await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000 })
          .catch(error => failures.push(error.message));
      }
      await delay(300);
    }
    for (const browser of browsers) await bounded(browser.close(), 'disconnecting owned CDP').catch(error => failures.push(error.message));
    return { failures, remaining: await ownedProcesses() };
  }
  function checkLauncher() {
    if (launcher.error) throw launcher.error;
    if (launcher.exited) throw new Error(`Candidate portable exited before ready (${launcher.code}): ${launcher.output}`);
  }
  async function attach(port, inspectorPort, executable, nextArgs, check) {
    const inspector = await connectInspector(inspectorPort, check);
    inspectors.push(inspector);
    const observation = await inspector.evaluate(`(${patchMain.toString()})(${JSON.stringify({ ...config, executable, nextArgs,
      nextExecutable, relaunchEvidence: path.join(runRoot, 'relaunch.json') })})`);
    assert.ok(insideRun(observation.executable), 'NSIS runtime must be isolated under this run TEMP/TMP');
    assert.equal(observation.profile, path.join(dataRoot, 'profile'));
    assert.equal(observation.session, path.join(dataRoot, 'session'));
    assert.equal(observation.portableDirectory, portableRoot);
    const endpoint = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      check?.();
      try { return (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, `renderer CDP on ${port}`, 45000);
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
    browsers.push(browser);
    const page = await waitFor(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('index.html')),
      'packaged index.html');
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('textbox', { name: '1번 패널 폴더 경로', exact: true }).waitFor();
    await page.locator('[data-pane="design-0"]').getByText('확인 1.txt', { exact: true }).waitFor();
    assert.match(page.url(), /^file:\/\/\/.+\.asar\/index\.html$/);
    await page.waitForFunction(version => document.querySelector('#app-version')?.textContent === `v${version}`, observation.version);
    assert.deepEqual(await page.evaluate(() => [typeof require, typeof process]), ['undefined', 'undefined']);
    observation.loadedURL = page.url();
    observation.footer = await page.locator('#app-version').innerText();
    report.observations.push(observation);
    const processes = await ownedProcesses();
    assert.ok(processes.some(item => item.ProcessId === observation.pid), 'Attached main PID must belong to this run');
    assert.ok(processes.some(item => item.ExecutablePath.toLowerCase() === executable.toLowerCase()), 'Actual NSIS portable launcher must be running');
    assert.deepEqual(snapshotPins(), pinsBefore, 'Smoke startup must leave real taskbar pins untouched');
    return { inspector, page, observation };
  }
  async function bootstrap(page) {
    const result = await page.evaluate(() => window.pane.bootstrap());
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.value.sessionWarning, undefined);
    assert.equal(result.value.preferencesWarning, undefined);
    return result.value;
  }
  try {
    const [firstCDP, firstInspector, secondCDP, secondInspector] = await reservePorts(4);
    const launchArgs = (cdp, inspector) => ['--pane-smoke-test', `--inspect=127.0.0.1:${inspector}`,
      `--remote-debugging-port=${cdp}`, '--remote-debugging-address=127.0.0.1'];
    const environment = { ...process.env, TEMP: temporaryRoot, TMP: temporaryRoot };
    for (const name of ['PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_APP_FILENAME',
      'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_INSPECT_RESUME_ON_START']) delete environment[name];
    const child = spawn(firstExecutable, launchArgs(firstCDP, firstInspector), {
      cwd: portableRoot, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    launchedChild = child;
    launcher = { pid: child.pid, exited: false, code: null, output: '', error: null };
    child.on('error', error => { launcher.error = error; });
    child.on('exit', code => { launcher.exited = true; launcher.code = code; });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { launcher.output = (launcher.output + chunk).slice(-20000); });
    const first = await attach(firstCDP, firstInspector, firstExecutable, launchArgs(secondCDP, secondInspector), checkLauncher);
    firstPage = first.page;
    assert.notEqual(first.observation.version, futureVersion, 'Candidate must have an older genuine app version');
    const original = await bootstrap(firstPage);
    assert.equal(original.update.status, 'idle');
    assert.deepEqual(original.session, seedSession);
    assert.deepEqual(original.preferences, seedPreferences);
    await firstPage.getByRole('button', { name: '2분할', exact: true }).click();
    await firstPage.locator('#add-favorite-button').click();
    await firstPage.waitForFunction(async folder => {
      const { value } = await window.pane.bootstrap();
      return value.session.workspaces.design.layout === 2 && value.preferences.favorites.some(item => item.path === folder);
    }, folders[0]);
    await firstPage.locator('#theme-toggle').click();
    const theme = await firstPage.evaluate(value => {
      localStorage.setItem('update-verification-marker', value);
      return document.documentElement.dataset.theme;
    }, marker);
    const saved = await bootstrap(firstPage);
    report.saved = { session: saved.session, preferences: saved.preferences, theme, marker };
    // Observe real pushed IPC states; update handlers and renderer stay intact.
    await firstPage.evaluate(() => {
      window.__updateStates = [];
      window.pane.onUpdateState(state => window.__updateStates.push(state));
    });
    const checked = await firstPage.evaluate(() => window.pane.checkForUpdates());
    assert.equal(checked.ok, true, JSON.stringify(checked));
    assert.equal(checked.value.status, 'available', JSON.stringify(checked));
    assert.equal(checked.value.latestVersion, futureVersion);
    const downloaded = await bounded(firstPage.evaluate(() => window.pane.downloadUpdate()), 'local fixture download', 120000);
    assert.equal(downloaded.ok, true, JSON.stringify(downloaded));
    assert.equal(downloaded.value.status, 'ready', JSON.stringify(downloaded));
    assert.equal(downloaded.value.progress, 100);
    assert.equal(await hashFile(nextExecutable), fixtureHash, 'Backend must write the exact real next-version EXE');
    assert.equal(await hashFile(firstExecutable), candidateHash, 'Original portable must remain unchanged');
    assert.equal(fs.readdirSync(portableRoot).some(name => name.startsWith('.quadpane-update-')), false, 'Download staging must be removed');
    report.updateStates = await firstPage.evaluate(() => window.__updateStates);
    for (const status of ['checking', 'available', 'downloading', 'ready']) {
      assert.ok(report.updateStates.some(state => state.status === status), `Missing pushed IPC state: ${status}`);
    }
    assert.ok(report.updateStates.some(state => state.status === 'downloading' && state.progress > 0 && state.progress < 100), 'Streaming download must report intermediate progress');
    const transport = await first.inspector.evaluate('globalThis.__portableUpdateVerification');
    assert.equal(transport.streamBytes, size);
    assert.ok(transport.streamChunks > 1, 'EXE must stream from disk in multiple chunks');
    assert.deepEqual(transport.unexpectedRequests, []);
    assert.deepEqual(transport.blockedNetwork, []);
    assert.deepEqual(transport.requests.map(item => [item.transport, item.url, item.method]), [
      ['net.fetch', latestURL, 'GET'], ['net.request', config.checksumURL, 'HEAD'], ['net.fetch', config.checksumURL, 'GET'],
      ['net.request', config.executableURL, 'HEAD'], ['net.fetch', config.executableURL, 'GET'],
    ]);
    report.transport = transport;
    await firstPage.locator('#update-button').click();
    await firstPage.locator('#update-install').waitFor();
    await firstPage.waitForFunction(() => !document.querySelector('#update-install').disabled);
    fs.writeFileSync(path.join(runRoot, 'before-update.txt'), await firstPage.locator('body').ariaSnapshot());
    // Detach the Node debugger before quit, so it cannot hold the old process.
    await first.inspector.close();
    installed = true;
    await firstPage.locator('#update-install').click({ noWaitAfter: true });
    await waitFor(() => fs.existsSync(path.join(runRoot, 'relaunch.json')), 'production app.relaunch call');
    const second = await attach(secondCDP, secondInspector, nextExecutable);
    secondPage = second.page;
    assert.equal(second.observation.version, futureVersion, 'New process app.getVersion() must come from a separately built 0.9.1 fixture');
    assert.notEqual(second.observation.pid, first.observation.pid, 'Update must start a new main process');
    assert.equal(second.observation.footer, `v${futureVersion}`);
    await waitFor(() => launcher.exited, 'original NSIS launcher exit');
    assert.equal(launcher.code, 0, launcher.output);
    report.relaunch = JSON.parse(fs.readFileSync(path.join(runRoot, 'relaunch.json'), 'utf8'));
    assert.deepEqual(report.relaunch.relaunch.production, { execPath: nextExecutable, args: [] });
    assert.equal(report.relaunch.relaunch.realRelaunchCalled, true);
    const restored = await bootstrap(secondPage);
    assert.deepEqual(restored.session, saved.session, 'Both workspaces, paths, sorting and layout must survive');
    assert.deepEqual(restored.preferences, saved.preferences, 'Favorites, recents and view preferences must survive');
    assert.equal(await secondPage.locator('.file-panel:visible').count(), 2);
    for (const index of [0, 1]) {
      assert.equal(await secondPage.getByRole('textbox', { name: `${index + 1}번 패널 폴더 경로`, exact: true }).inputValue(), folders[index]);
      await secondPage.locator(`[data-pane="design-${index}"]`).getByText(`확인 ${index + 1}.txt`, { exact: true }).waitFor();
    }
    assert.deepEqual(await secondPage.evaluate(() => ({ theme: document.documentElement.dataset.theme,
      storedTheme: localStorage.getItem('pane-theme'), marker: localStorage.getItem('update-verification-marker') })),
    { theme, storedTheme: theme, marker });
    assert.equal(await secondPage.locator('#show-hidden').isChecked(), saved.preferences.showHidden);
    assert.equal(await secondPage.locator('#show-extensions').isChecked(), saved.preferences.showExtensions);
    for (const filename of markerFiles) assert.equal(fs.readFileSync(filename, 'utf8'), marker);
    // The future build is a passive launch/profile fixture: do not exercise
    // its updater or require it to contain the candidate's service fixes.
    const current = await secondPage.evaluate(() => window.pane.updateState());
    assert.equal(current.ok, true, JSON.stringify(current));
    assert.equal(current.value.status, 'idle');
    assert.equal(current.value.currentVersion, futureVersion);
    report.secondTransport = await second.inspector.evaluate('globalThis.__portableUpdateVerification');
    assert.deepEqual(report.secondTransport.requests, [], 'The target fixture must remain passive');
    assert.deepEqual(report.secondTransport.unexpectedRequests, []);
    assert.deepEqual(report.secondTransport.blockedNetwork, []);
    fs.writeFileSync(path.join(runRoot, 'after-update.txt'), await secondPage.locator('body').ariaSnapshot());
    await second.inspector.close();
    await bounded(secondPage.close(), 'closing updated renderer');
    await waitFor(async () => (await ownedProcesses()).length === 0, 'all owned portable, Electron and native helper processes to exit', 45000);
    for (const browser of browsers) await bounded(browser.close(), 'disconnecting exited CDP');
    for (const key of ['session', 'preferences']) {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataRoot, `${key}.json`), 'utf8')), saved[key], `Saved ${key} must survive shutdown`);
    }
    assert.ok(fs.existsSync(path.join(dataRoot, 'session', 'Local Storage')));
    for (const observation of report.observations) {
      assert.equal(fs.existsSync(path.dirname(observation.executable)), false, 'NSIS must remove its extracted runtime after exit');
    }
    assert.deepEqual(snapshotPins(), pinsBefore, 'Actual taskbar pins must remain byte-for-byte unchanged');
    assert.deepEqual(errors, []);
    report.passed = true;
    report.realPinsUnchanged = true;
    report.remainingOwnedProcesses = [];
    report.originalLauncherExitCode = launcher.code;
    fs.writeFileSync(path.join(runRoot, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.error = error.stack;
    report.launcher = launcher;
    report.installAttempted = installed;
    report.rendererErrors = errors;
    report.cleanup = await cleanup().catch(error => ({ error: error.stack }));
    // A failed OS cleanup must not leave the verifier blocked on child pipes;
    // any surviving owned PIDs remain explicitly recorded in failure.json.
    launchedChild?.stdout?.destroy();
    launchedChild?.stderr?.destroy();
    launchedChild?.unref();
    try { report.realPinsUnchanged = JSON.stringify(snapshotPins()) === JSON.stringify(pinsBefore); }
    catch (error) { report.pinSnapshotError = error.message; }
    fs.writeFileSync(path.join(runRoot, 'failure.json'), JSON.stringify(report, null, 2));
    console.error(`Update transition verification failed; evidence: ${path.join(runRoot, 'failure.json')}`);
    throw error;
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

// Export only test harness pieces for offline contract checks; production never imports this script.
module.exports = { patchMain, connectInspector };
