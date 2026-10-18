'use strict';
// node scripts/verification/verify-loading.cjs [Playwright dependency root] [unpacked EXE]
// Uses only hidden windows, a fresh portable profile and real temporary folders.
// Hold directory IPC replies until loading UI assertions finish; never build native helpers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
const { _electron } = dependencies('playwright');
const project = path.resolve(__dirname, '../..');
const packaged = Boolean(process.argv[3]);
const executable = packaged ? path.resolve(process.argv[3]) : require('electron');
const checksDirectory = path.join(project, '.checks', 'loading');
fs.mkdirSync(checksDirectory, { recursive: true });
const root = fs.mkdtempSync(path.join(checksDirectory, 'run-'));
const profile = path.join(root, 'profile');
const folders = [0, 1, 2, 3].map(index => path.join(root, `folder-${index}`));
for (const folder of folders) {
  fs.mkdirSync(path.join(folder, 'child', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'child', 'child-file.txt'), 'child fixture');
  for (let index = 0; index < 40; index++) fs.writeFileSync(path.join(folder, `file-${String(index).padStart(2, '0')}.txt`), 'fixture');
}
const panes = folders.map(folder => ({ path: folder, sort: 'name', direction: 1 }));
const session = { version: 1, workspaceId: 'design', workspaces: {
  design: { layout: 4, active: 0, panes }, documents: { layout: 2, active: 0, panes },
} };
const settings = path.join(profile, packaged ? 'quadpane-data' : '.quadpane-dev-data');
fs.mkdirSync(settings, { recursive: true });
fs.writeFileSync(path.join(settings, 'session.json'), JSON.stringify(session));
const harness = path.join(root, 'main.cjs');
fs.writeFileSync(harness, `
const service = require.resolve(${JSON.stringify(path.join(project, 'desktop/shell-menu.cjs'))});
require.cache[service] = { exports: { createShellMenuService: () => ({
  start() {}, close() {}, cancel() {}, pending: false,
  async show(_request, _host, mode) {
    if (mode === 'readClipboard') return { sources: [], operation: 'copy' };
    throw new Error('Unexpected shell call: ' + mode);
  },
}) } };
require(${JSON.stringify(path.join(project, 'desktop/main.cjs'))});
`);
let application, page;
const checks = [], errors = [];
const panel = (index = 0) => page.locator(`#panel-design-${index}`);
const input = (index = 0) => panel(index).locator('.path-input');
const requests = () => application.evaluate(() => global.loadingChecks.requests);
async function waitRequests(count) {
  await application.evaluate(async (_electron, count) => {
    const deadline = Date.now() + 10000;
    while (global.loadingChecks.requests.length < count) {
      if (Date.now() > deadline) throw new Error(`Expected ${count} directory requests; received ${global.loadingChecks.requests.length}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }, count);
  const sent = await requests();
  assert.equal(sent.length, count, 'Each action sends the expected number of directory requests');
  return sent;
}
async function release(records) {
  await application.evaluate((_electron, ids) => {
    for (const id of ids) global.loadingChecks.release(id);
  }, records.map(record => record.id));
}
async function settled(index = 0, folder) {
  await page.waitForFunction(({ index, folder }) => {
    const element = document.querySelector(`#panel-design-${index}`);
    return element?.getAttribute('aria-busy') === 'false' && (!folder || element.querySelector('.path-input').value === folder);
  }, { index, folder });
}
async function allSettled() {
  await page.waitForFunction(() => document.querySelectorAll('.file-panel').length === 8 &&
    [...document.querySelectorAll('.file-panel')].every(element => element.getAttribute('aria-busy') === 'false'));
}
async function remember(index = 0) {
  await panel(index).evaluate(element => {
    window.loadingProbe = {
      table: element.querySelector('.file-table'), row: element.querySelector('[data-file]'),
      scrollTop: element.querySelector('.file-scroll').scrollTop,
      selected: [...element.querySelectorAll('tr.selected')].map(row => row.dataset.file),
    };
  });
}
async function loading(index = 0, preserve = true) {
  await page.waitForFunction(index => document.querySelector(`#panel-design-${index}`)?.getAttribute('aria-busy') === 'true', index);
  const state = await panel(index).evaluate(element => {
    const button = element.querySelector('[data-action="refresh"]');
    const message = element.querySelector('.panel-message');
    const before = window.loadingProbe;
    return {
      hidden: message.hidden && getComputedStyle(message).display === 'none', text: message.textContent,
      animation: getComputedStyle(button.querySelector('svg')).animationName,
      highlighted: getComputedStyle(button).backgroundColor !== 'rgba(0, 0, 0, 0)',
      sameTable: before?.table === element.querySelector('.file-table'),
      sameRow: before?.row === element.querySelector('[data-file]'),
      sameScroll: before?.scrollTop === element.querySelector('.file-scroll').scrollTop,
      sameSelection: JSON.stringify(before?.selected) === JSON.stringify([...element.querySelectorAll('tr.selected')].map(row => row.dataset.file)),
    };
  });
  assert.equal(state.hidden, true, 'Loading must never show a panel-message overlay');
  assert.equal(state.text, '', 'Loading overlay text must be empty');
  assert.equal(state.animation, 'folder-loading', 'Only the small refresh icon signals loading');
  assert.equal(state.highlighted, true);
  if (preserve) {
    for (const key of ['sameTable', 'sameRow', 'sameScroll', 'sameSelection']) assert.equal(state[key], true, key);
  }
}
async function begin(action, { accurate = false, index = 0, count = 1 } = {}) {
  const before = (await requests()).length;
  await remember(index);
  await action();
  const sent = (await waitRequests(before + count)).slice(before);
  for (const record of sent) assert.deepEqual(record.options, { accurate }, 'Accuracy must cross the real preload IPC boundary');
  await loading(index);
  return sent;
}
async function navigate(folder) {
  const sent = await begin(async () => { await input().fill(folder); await input().press('Enter'); });
  assert.equal(sent[0].folder, folder);
  await release(sent); await settled(0, folder);
}
async function capture(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await application.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayHidden: true })).toPNG().toString('base64'));
  fs.writeFileSync(path.join(root, name), Buffer.from(png, 'base64'));
}
(async () => {
  const env = { ...process.env, PORTABLE_EXECUTABLE_DIR: profile };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_APP_FILENAME']) delete env[key];
  application = await _electron.launch({ executablePath: executable, args: [...(packaged ? [] : [harness]), '--pane-smoke-test'], env, timeout: 30000 });
  page = await application.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await allSettled();
  await application.evaluate(({ app, BrowserWindow, ipcMain }, { project, packaged, session, root }) => {
    const nodePath = process.getBuiltinModule('path');
    const load = process.getBuiltinModule('module').createRequire(nodePath.join(packaged ? app.getAppPath() : project, 'package.json'));
    const filesystem = load('./desktop/filesystem.cjs');
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setBackgroundThrottling(false);
    if (window.isVisible()) throw new Error('Fixture window must stay hidden');
    const pending = new Map();
    global.loadingChecks = { requests: [], release(id) {
      if (!pending.has(id)) throw new Error('Unknown pending directory request: ' + id);
      pending.get(id)(); pending.delete(id);
    } };
    const replace = (channel, action) => { ipcMain.removeHandler(channel); ipcMain.handle(channel, action); };
    replace('pane:bootstrap', () => ({ ok: true, value: { session, favorites: [], drives: [], preferences: { favorites: [], recentPaths: [] } } }));
    replace('pane:list-directory', async (_event, folder, options) => {
      const relative = nodePath.relative(root, folder);
      if (relative.startsWith('..') || nodePath.isAbsolute(relative)) throw new Error('Directory request escaped fixture');
      const id = global.loadingChecks.requests.length;
      global.loadingChecks.requests.push({ id, folder, options });
      await new Promise(resolve => pending.set(id, resolve));
      try { return { ok: true, value: await filesystem.listDirectory(folder, options) }; }
      catch (error) { return filesystem.errorResult(error); }
    });
    replace('pane:read-shell-clipboard', () => ({ ok: true, value: { sources: [], operation: 'copy' } }));
    for (const channel of ['pane:write-shell-clipboard', 'pane:complete-shell-paste', 'pane:shell-menu', 'pane:begin-native-drag', 'pane:trash-items', 'pane:open-path', 'pane:reveal-path', 'pane:transfer']) {
      replace(channel, () => { throw new Error('Unexpected external action: ' + channel); });
    }
  }, { project, packaged, session, root });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.reload();
  const initial = await waitRequests(8);
  for (const record of initial) assert.deepEqual(record.options, { accurate: false });
  await loading(0, false);
  assert.match(await panel().locator('.empty-state').innerText(), /폴더를 불러오고 있어요/);
  assert.equal(await panel().locator('[data-file]').count(), 0);
  assert.equal(await page.locator('.panel-message:visible').count(), 0);
  assert.equal(await page.locator('#refresh-button').getAttribute('aria-busy'), 'true');
  await capture('first-loading.png');
  await release(initial); await allSettled();
  assert.equal(await panel().locator('[data-file]').count(), 41);
  checks.push('First load has an inline empty-list placeholder and busy refresh icon, with no overlay');

  const child = path.join(folders[0], 'child');
  await panel().locator('[data-file]').nth(5).click();
  await panel().locator('.file-scroll').evaluate(element => { element.scrollTop = 160; });
  await navigate(child);
  let sent = await begin(() => panel().locator('[data-action="back"]').click());
  await release(sent); await settled(0, folders[0]);
  sent = await begin(() => panel().locator('[data-action="forward"]').click());
  await release(sent); await settled(0, child);
  await panel().locator('[data-file]').filter({ hasText: 'deep' }).click();
  sent = await begin(() => panel().locator('[data-file]').filter({ hasText: 'deep' }).dblclick());
  await release(sent); await settled(0, path.join(child, 'deep'));
  sent = await begin(() => page.keyboard.press('Alt+ArrowLeft'));
  await release(sent); await settled(0, child);
  checks.push('Direct navigation, folder open, back and forward preserve old table/rows/selection/scroll while pending and use accurate:false');

  for (const [name, action] of [
    ['panel button', () => panel().locator('[data-action="refresh"]').click()],
    ['global button', () => page.locator('#refresh-button').click()],
    ['F5', () => page.keyboard.press('F5')],
  ]) {
    sent = await begin(action, { accurate: true });
    assert.equal(sent[0].folder, child);
    assert.equal(await page.locator('#refresh-button').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#refresh-button svg').evaluate(icon => getComputedStyle(icon).animationName), 'folder-loading');
    if (name === 'panel button') {
      await capture('refresh-loading.png');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      for (const icon of [panel().locator('[data-action="refresh"] svg'), page.locator('#refresh-button svg')]) {
        assert.equal(await icon.evaluate(element => getComputedStyle(element).animationName), 'none');
      }
      assert.equal(await panel().getAttribute('aria-busy'), 'true');
      await panel(1).locator('.panel-tab-label').click();
      assert.equal(await page.locator('#refresh-button').getAttribute('aria-busy'), 'false');
      await panel().locator('.panel-tab-label').click();
      assert.equal(await page.locator('#refresh-button').getAttribute('aria-busy'), 'true');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
    await release(sent); await settled(0, child);
    assert.equal(await page.locator('#refresh-button').getAttribute('aria-busy'), 'false');
    assert.equal(await panel().locator('[data-action="refresh"] svg').evaluate(icon => getComputedStyle(icon).animationName), 'none');
    assert.equal(await panel().locator('[data-action="forward"]').isEnabled(), true, 'Refresh preserves forward history');
  }
  checks.push('Panel/global/F5 refresh send accurate:true; busy state follows active pane and stops after completion; reduced motion disables rotation');

  const missing = path.join(root, 'missing');
  sent = await begin(async () => { await input().fill(missing); await input().press('Enter'); });
  await release(sent); await settled();
  assert.equal(await panel().locator('.panel-error').isVisible(), true);
  assert.match(await panel().locator('.panel-error').innerText(), /폴더를 찾을 수 없습니다/);
  assert.equal(await panel().locator('[data-action="retry"]').isVisible(), true);
  assert.equal(await input().inputValue(), child);
  await capture('real-error.png');
  fs.mkdirSync(missing);
  sent = await begin(() => panel().locator('[data-action="retry"]').click());
  await release(sent); await settled(0, missing);
  assert.equal(await panel().locator('.panel-message').isVisible(), false);
  assert.match(await panel().locator('.empty-state').innerText(), /비어 있는 폴더예요/);
  checks.push('Real missing-folder error and retry stay visible; retry hides the banner while loading and succeeds after folder recovery');

  await navigate(folders[0]);
  sent = await begin(async () => {
    await panel().locator('[data-action="newfolder"]').click();
    await page.locator('#name-input').fill('created-during-check');
    await page.locator('#name-confirm').click();
  }, { count: 2 });
  assert.ok(fs.existsSync(path.join(folders[0], 'created-during-check')));
  await release(sent); await allSettled();
  await page.waitForFunction(() => document.querySelector('#activity-strip').getAttribute('aria-busy') === 'false');
  sent = await begin(() => page.evaluate(() => window.dispatchEvent(new Event('focus'))), { count: 8 });
  await release(sent); await allSettled();
  checks.push('Actual folder mutation refreshes affected panes with accurate:false; automatic focus refresh does the same for all loaded panes');

  assert.deepEqual(errors, []);
  const hidden = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()));
  assert.equal(hidden, true, 'No fixture window becomes visible');
  const fingerprint = packaged ? path.join(path.dirname(executable), 'resources/app.asar') : path.join(project, 'app.js');
  const report = { passed: true, packaged, checks, errors, requests: await requests(), fingerprint,
    sha256: createHash('sha256').update(fs.readFileSync(fingerprint)).digest('hex'),
    limits: 'Hidden Electron with gated directory IPC and real fixture files. Shell/clipboard actions are blocked; no real user profile, taskbar pins or native builds are used.' };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, ...report }, null, 2));
})().catch(async error => {
  fs.writeFileSync(path.join(root, 'failure.txt'), error.stack);
  if (page) await capture('failure.png').catch(() => {});
  console.error(error); console.log(`Evidence: ${root}`); process.exitCode = 1;
}).finally(async () => { await application?.close(); });
