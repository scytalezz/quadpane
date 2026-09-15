const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { createRequire } = require('node:module');

const project = path.resolve(__dirname, '..', '..');
const requireDependencies = process.argv[2]
  ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json'))
  : require;
const { chromium } = requireDependencies('playwright');
const version = require('../../package.json').version;
const sourceExecutable = path.resolve(process.argv[3] || path.join(project, 'dist-portable', `pane-${version}-portable-x64.exe`));
assert.ok(fs.existsSync(sourceExecutable), `Portable EXE missing: ${sourceExecutable}`);
const runRoot = path.join(project, '.checks', 'portable-launch', `run-${Date.now()}`);
const originalRoot = path.join(runRoot, 'original');
const movedRoot = path.join(runRoot, 'moved');
fs.mkdirSync(originalRoot, { recursive: true });
const fixtureRoot = path.join(runRoot, '실제 파일');
const folderPaths = ['작업 A', '작업 B', '작업 C', '작업 D'].map(name => path.join(fixtureRoot, name));
folderPaths.forEach((folder, index) => {
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `확인 ${index + 1}.txt`);
  fs.writeFileSync(file, `portable fixture ${index + 1}`);
  fs.utimesSync(file, new Date('2024-05-06T12:34:56Z'), new Date('2024-05-06T12:34:56Z'));
});
const originalExecutable = path.join(originalRoot, path.basename(sourceExecutable));
fs.copyFileSync(sourceExecutable, originalExecutable);
const sha256 = createHash('sha256').update(fs.readFileSync(sourceExecutable)).digest('hex');
const observations = [];
let active;

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
async function connect(endpoint, processState) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (processState.error) throw processState.error;
    if (processState.exited) throw new Error(`Portable launcher exited before CDP became ready (${processState.code}): ${processState.output}`);
    try {
      const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1200) });
      if (response.ok) return chromium.connectOverCDP(endpoint, { timeout: 10000 });
    } catch { /* The launcher first extracts the runtime, then opens its endpoint. */ }
    await delay(300);
  }
  throw new Error(`Portable launcher CDP timed out: ${processState.output}`);
}
async function waitForExit(state) {
  const deadline = Date.now() + 20000;
  while (!state.exited && Date.now() < deadline) await delay(100);
  assert.ok(state.exited, 'Portable launcher did not exit after its window closed');
  assert.equal(state.code, 0, `Portable launcher exit code: ${state.code}; ${state.output}`);
  return state.code;
}
async function killOwnProcess() {
  if (!active || active.exited || !active.child.pid) return;
  await new Promise(resolve => execFile('taskkill', ['/PID', String(active.child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
}

async function launchAndCheck(executable, expectedTheme) {
  const port = await reservePort();
  const environment = { ...process.env };
  for (const key of ['PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_APP_FILENAME', 'ELECTRON_RUN_AS_NODE']) delete environment[key];
  const child = spawn(executable, ['--pane-smoke-test', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
    cwd: path.dirname(executable), windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
  active = { child, exited: false, code: null, output: '', error: null };
  const state = active;
  child.on('error', error => { state.error = error; });
  child.on('exit', code => { state.exited = true; state.code = code; });
  const collect = chunk => { state.output = (state.output + chunk.toString()).slice(-12000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const browser = await connect(`http://127.0.0.1:${port}`, state);
  const context = browser.contexts()[0];
  const pageDeadline = Date.now() + 15000;
  let page;
  while (!page && Date.now() < pageDeadline) {
    page = context.pages().find(candidate => candidate.url().includes('index.html'));
    if (!page) await delay(100);
  }
  assert.ok(page, 'Packaged index.html did not open');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('textbox', { name: '1번 패널 폴더 경로', exact: true }).waitFor({ timeout: 15000 });
  const url = page.url();
  assert.match(url, /^file:\/\/\/.+\.asar\/index\.html$/);
  const restored = Boolean(expectedTheme);
  if (restored) {
    await page.locator('[data-pane="design-0"]').getByText('확인 1.txt', { exact: true }).waitFor();
    assert.equal(await page.locator('.file-panel:visible').count(), 2, 'Split layout not restored');
    for (const index of [0, 1]) {
      assert.equal(await page.getByRole('textbox', { name: `${index + 1}번 패널 폴더 경로`, exact: true }).inputValue(), folderPaths[index]);
    }
  } else {
    await page.getByRole('button', { name: '4분할', exact: true }).click();
    for (const [index, folder] of folderPaths.entries()) {
      const address = page.getByRole('textbox', { name: `${index + 1}번 패널 폴더 경로`, exact: true });
      await address.fill(folder);
      await address.press('Enter');
      await page.locator(`[data-pane="design-${index}"]`).getByText(`확인 ${index + 1}.txt`, { exact: true }).waitFor();
    }
    await page.getByRole('button', { name: '2분할', exact: true }).click();
  }
  for (const index of [0, 1]) await page.locator(`[data-pane="design-${index}"]`).getByText(`확인 ${index + 1}.txt`, { exact: true }).waitFor();
  const rows = await page.locator('.file-panel:visible .file-table tbody tr[data-file]').count();
  assert.equal(rows, 2);
  const dates = await page.locator('.file-panel:visible .file-table tbody time').allTextContents();
  assert.deepEqual(dates, ['2024-05-06', '2024-05-06']);
  const native = await page.evaluate(() => window.pane.bootstrap());
  assert.equal(native.ok, true);
  assert.ok(native.value.drives.length > 0);
  if (!restored) {
    await page.locator('#add-favorite-button').click();
    await page.waitForFunction(async location => (await window.pane.bootstrap()).value.preferences.favorites.some(item => item.path === location), folderPaths[0]);
  } else {
    assert.ok(native.value.preferences.favorites.some(item => item.path === folderPaths[0]), 'Custom favorite not restored');
  }
  assert.deepEqual(await page.evaluate(() => [typeof require, typeof process]), ['undefined', 'undefined']);
  const before = await page.evaluate(() => document.documentElement.dataset.theme);
  if (expectedTheme) {
    assert.equal(before, expectedTheme, 'Theme was not restored across a real portable launch');
    assert.equal(await page.evaluate(() => localStorage.getItem('pane-theme')), expectedTheme);
  } else {
    await page.locator('#theme-toggle').click();
    expectedTheme = before === 'dark' ? 'light' : 'dark';
  }
  await page.reload();
  await page.locator('[data-pane="design-0"]').getByText('확인 1.txt', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '1번 패널 폴더 경로', exact: true }).inputValue(), folderPaths[0]);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), expectedTheme);
  assert.equal(await page.evaluate(() => localStorage.getItem('pane-theme')), expectedTheme);
  fs.writeFileSync(path.join(path.dirname(executable), `launch-${observations.length + 1}.txt`), await page.locator('body').ariaSnapshot());
  await page.close();
  const exitCode = await waitForExit(state);
  await browser.close().catch(() => {});
  const dataPath = path.join(path.dirname(executable), 'pane-data');
  for (const directory of ['profile', 'session', 'logs', 'crashes']) assert.ok(fs.statSync(path.join(dataPath, directory)).isDirectory(), `Missing portable ${directory} directory`);
  assert.ok(fs.existsSync(path.join(dataPath, 'session', 'Local Storage')), 'Persistent browser storage missing beside portable EXE');
  const saved = JSON.parse(fs.readFileSync(path.join(dataPath, 'session.json'), 'utf8'));
  assert.equal(saved.workspaces.design.layout, 2);
  assert.deepEqual(saved.workspaces.design.panes.map(pane => pane.path), folderPaths);
  const preferences = JSON.parse(fs.readFileSync(path.join(dataPath, 'preferences.json'), 'utf8'));
  assert.ok(preferences.favorites.some(item => item.path === folderPaths[0]));
  assert.deepEqual(errors, []);
  observations.push({ executable, loadedURL: url, rows, dates: dates.length, dateSample: dates[0], theme: expectedTheme, restored, paths: saved.workspaces.design.panes.map(pane => pane.path), layout: saved.workspaces.design.layout, favorites: preferences.favorites, driveCount: native.value.drives.length, dataPath, exitCode, errors });
  active = undefined;
  return expectedTheme;
}

(async () => {
  const theme = await launchAndCheck(originalExecutable);
  await launchAndCheck(originalExecutable, theme);
  fs.mkdirSync(movedRoot);
  const movedExecutable = path.join(movedRoot, path.basename(sourceExecutable));
  fs.copyFileSync(originalExecutable, movedExecutable);
  fs.cpSync(path.join(originalRoot, 'pane-data'), path.join(movedRoot, 'pane-data'), { recursive: true });
  await launchAndCheck(movedExecutable, theme);
  const report = { passed: true, sourceExecutable, sha256, runRoot, observations };
  fs.writeFileSync(path.join(runRoot, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  await killOwnProcess();
  fs.writeFileSync(path.join(runRoot, 'failure.json'), JSON.stringify({ error: error.stack, output: active?.output, observations }, null, 2));
  console.error(error);
  process.exitCode = 1;
});
