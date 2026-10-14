'use strict';
// Hidden Electron integration: real files/preferences, trusted mouse input,
// and isolated clipboard/drag IPC so the user's clipboard and other apps are untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
const { _electron } = dependencies('playwright');
const project = path.resolve(__dirname, '..', '..');
const executable = path.resolve(process.argv[3] || path.join(project, 'dist-portable', 'win-unpacked', 'Quadpane.exe'));
assert.ok(fs.existsSync(executable), 'Build the Windows app before running this verification');
const packaged = true;
const root = path.join(project, '.checks', 'display-selection', `run-${Date.now()}`);
const source = path.join(root, '원본'), target = path.join(root, '대상');
const profile = path.join(root, 'profile');
const settings = path.join(profile, packaged ? 'quadpane-data' : '.quadpane-dev-data');
for (const directory of [source, target, settings, path.join(source, 'folder.name'), path.join(source, 'many-files'), path.join(source, 'secret-folder')]) fs.mkdirSync(directory, { recursive: true });
for (const name of ['alpha.txt', 'beta.hwp', 'gamma.pptx', '.env', 'README', 'secret.txt']) fs.writeFileSync(path.join(source, name), `fixture ${name}`);
for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(source, 'many-files', `item-${String(i).padStart(2, '0')}.txt`), `row ${i}`);
for (const name of ['secret.txt', 'secret-folder']) execFileSync('attrib.exe', ['+H', path.join(source, name)], { windowsHide: true });
const paneState = location => ({ path: location, sort: 'name', direction: 1 });
fs.writeFileSync(path.join(settings, 'session.json'), JSON.stringify({ version: 1, workspaceId: 'design', workspaces: {
  design: { layout: 2, active: 0, panes: [source, target, source, target].map(paneState) },
  documents: { layout: 2, active: 0, panes: [source, target, source, target].map(paneState) },
} }));
// Legacy preferences exercise migration in the real application.
fs.writeFileSync(path.join(settings, 'preferences.json'), JSON.stringify({ favorites: [], recentPaths: [] }));
let application, page;
const checks = [], errors = [];
function record(message) { checks.push(message); console.log(`PASS: ${message}`); }
const panel = (index = 0) => page.locator(`#panel-design-${index}`);
const row = (name, index = 0) => panel(index).locator('tr[data-file]').filter({ has: page.locator(`.file-name span[title="${name}"]`) });
const names = (index = 0, selected = false) => panel(index).locator(`tr[data-file]${selected ? '[aria-selected="true"]' : ''} .file-name span[title]`).evaluateAll(elements => elements.map(element => element.title));
async function idle() {
  await page.waitForFunction(() => document.querySelector('#activity-strip').getAttribute('aria-busy') === 'false');
}
async function loaded(index, directory) {
  await page.waitForFunction(({ index, directory }) => {
    const panel = document.getElementById(`panel-design-${index}`);
    return panel?.getAttribute('aria-busy') === 'false' && panel.querySelector('.path-input').value === directory;
  }, { index, directory });
}
async function go(directory, index = 0) {
  const input = panel(index).locator('.path-input');
  await input.fill(directory); await input.press('Enter'); await loaded(index, directory);
}
async function option(name, checked) {
  const checkbox = page.getByRole('checkbox', { name });
  if (!await checkbox.isVisible()) await page.getByRole('button', { name: '보기', exact: true }).click();
  await checkbox.setChecked(checked);
  await page.keyboard.press('Escape');
}
async function start() {
  const environment = { ...process.env, PORTABLE_EXECUTABLE_DIR: profile };
  delete environment.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: executable, args: [...(packaged ? [] : [project]), '--pane-smoke-test'], env: environment, timeout: 30000 });
  // Hidden windows otherwise throttle animation frames and mouse-input acknowledgements.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  page = await application.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await loaded(0, source); await loaded(1, target);
  await application.evaluate(({ ipcMain }) => {
    global.displayTest = { dragCalls: [], clipboard: null, failCompletion: false, completions: [] };
    for (const channel of ['pane:begin-native-drag', 'pane:read-shell-clipboard', 'pane:write-shell-clipboard', 'pane:complete-shell-paste']) ipcMain.removeHandler(channel);
    ipcMain.handle('pane:begin-native-drag', (_event, paths) => {
      global.displayTest.dragCalls.push(paths);
      return { ok: true, value: { action: 'cancel' } };
    });
    ipcMain.handle('pane:read-shell-clipboard', () => ({ ok: true, value: global.displayTest.clipboard }));
    ipcMain.handle('pane:write-shell-clipboard', (_event, value) => {
      global.displayTest.clipboard = { ...value, sequence: 42 };
      return { ok: true, value: global.displayTest.clipboard };
    });
    ipcMain.handle('pane:complete-shell-paste', (_event, request) => {
      global.displayTest.completions.push(request);
      if (global.displayTest.failCompletion) throw new Error('Injected clipboard completion failure');
      return { ok: true, value: null };
    });
  });
}
async function rubberBand(firstName, { control = false, cancel = false } = {}) {
  const scroll = await panel().locator('.file-scroll').boundingBox();
  const rows = panel().locator('tr[data-file]');
  const last = await rows.last().boundingBox();
  const first = await row(firstName).boundingBox();
  const start = { x: scroll.x + 8, y: Math.min(scroll.y + scroll.height - 8, last.y + last.height + 24) };
  assert.ok(start.y > last.y + last.height, 'Fixture must leave blank space below the rows');
  if (control) await page.keyboard.down('Control');
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(first.x + first.width - 24, first.y + 4, { steps: 16 });
  if (cancel) await page.keyboard.press('Escape');
  await page.mouse.up();
  if (control) await page.keyboard.up('Control');
}
async function capture(filename) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const image = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayHidden: true })).toPNG().toString('base64'));
  fs.writeFileSync(path.join(root, filename), Buffer.from(image, 'base64'));
}
(async () => {
  await start();
  assert.equal(await row('secret.txt').count(), 0);
  assert.equal(await row('secret-folder').count(), 0);
  await row('.env').waitFor(); await row('alpha.txt').waitFor();
  const listing = await page.evaluate(directory => window.pane.listDirectory(directory), source);
  assert.equal(listing.ok, true);
  for (const name of ['secret.txt', 'secret-folder']) assert.equal(listing.value.entries.find(entry => entry.name === name).hidden, true);
  assert.equal(listing.value.entries.find(entry => entry.name === '.env').hidden, false);
  record('Real Windows Hidden attributes respected by default; ordinary dotfile remains visible');

  await option(/숨김 항목/, true); await row('secret.txt').waitFor(); await row('secret-folder').waitFor();
  await row('secret.txt').click();
  await option(/숨김 항목/, false);
  assert.equal(await row('secret.txt').count(), 0); assert.deepEqual(await names(0, true), []);
  await row('alpha.txt').click(); await page.keyboard.press('Control+a');
  assert.deepEqual(new Set(await names(0, true)), new Set(await names()));
  assert.ok(!(await names(0, true)).includes('secret.txt'));
  record('Hidden toggle removes invisible selections; Ctrl+A selects only visible entries');

  await option(/확장자/, false);
  assert.equal(await row('alpha.txt').locator('.file-name span[title]').textContent(), 'alpha');
  assert.equal(await row('beta.hwp').locator('.file-name span[title]').textContent(), 'beta');
  assert.equal(await row('.env').locator('.file-name span[title]').textContent(), '.env');
  assert.equal(await row('folder.name').locator('.file-name span[title]').textContent(), 'folder.name');
  await row('alpha.txt').click(); await page.keyboard.press('F2');
  assert.equal(await page.locator('#name-input').inputValue(), 'alpha.txt');
  await page.keyboard.press('Escape');
  await page.locator('#global-search').fill('.hwp');
  assert.deepEqual(await names(), ['beta.hwp']);
  await page.locator('#global-search').fill('');
  record('Extension display changes only file labels; dotfiles, folder names, search and rename identities preserved');

  const visible = await names();
  const lastTwo = visible.slice(-2);
  await rubberBand(lastTwo[0]);
  assert.deepEqual(await names(0, true), lastTwo);
  await row(visible[0]).click();
  await rubberBand(lastTwo[0], { control: true });
  assert.deepEqual(new Set(await names(0, true)), new Set([visible[0], ...lastTwo]));
  const selectedBeforeCancel = await names(0, true);
  await rubberBand(visible[1], { cancel: true });
  assert.deepEqual(await names(0, true), selectedBeforeCancel);
  assert.equal((await application.evaluate(() => global.displayTest.dragCalls)).length, 0);
  record('Trusted mouse marquee replaces/adds selection; Escape restores prior selection and never starts file drag');
  await capture('selection.png');

  const dragged = await row(lastTwo[0]).boundingBox();
  await page.mouse.move(dragged.x + 80, dragged.y + dragged.height / 2);
  await page.mouse.down(); await page.mouse.move(dragged.x + 140, dragged.y + dragged.height / 2, { steps: 8 }); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('#activity-strip').getAttribute('aria-busy') === 'false');
  const dragCalls = await application.evaluate(() => global.displayTest.dragCalls);
  assert.ok(dragCalls.length > 0, 'Dragging a selected item must still initiate native drag');
  assert.deepEqual(new Set(dragCalls.at(-1)), new Set(selectedBeforeCancel.map(name => path.join(source, name))));
  record('Dragging selected file still forwards the full selection to native drag IPC');

  await go(path.join(source, 'many-files'));
  const scroll = panel().locator('.file-scroll');
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const scrollBox = await scroll.boundingBox();
  // A selectable left gutter remains available even when rows fill the viewport.
  const beforeScroll = await scroll.evaluate(element => element.scrollTop);
  await page.mouse.move(scrollBox.x + 2, scrollBox.y + scrollBox.height - 8); await page.mouse.down();
  await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + 2, { steps: 12 });
  await page.waitForFunction(before => document.querySelector('#panel-design-0 .file-scroll').scrollTop < before, beforeScroll, { timeout: 3000 });
  await page.mouse.up();
  assert.ok((await names(0, true)).length > 2);
  await go(source);
  record('Marquee auto-scrolls a long file list and selects across the scrolled area');

  await application.evaluate(() => { global.displayTest.failCompletion = true; });
  await row('alpha.txt').click(); await page.keyboard.press('Control+x');
  await panel(1).locator('.panel-tab-label').click(); await page.keyboard.press('Control+v');
  await row('alpha.txt', 1).waitFor(); await idle();
  assert.equal(fs.existsSync(path.join(source, 'alpha.txt')), false);
  assert.equal(fs.readFileSync(path.join(target, 'alpha.txt'), 'utf8'), 'fixture alpha.txt');
  assert.equal(await row('alpha.txt').count(), 0);
  assert.match(await page.locator('#operation-results-button').getAttribute('title'), /이동 완료 1개/);
  await page.locator('#operation-results-button').click();
  assert.ok(!(await page.locator('#transfer-result').textContent()).includes('FILE_OPERATION_ERROR'));
  await page.keyboard.press('Escape');
  record('Actual move remains successful and both panes refresh when post-move clipboard completion rejects');

  const overlap = path.join(source, 'overlap'), child = path.join(overlap, 'child.txt');
  fs.mkdirSync(overlap); fs.writeFileSync(child, 'nested content');
  await application.evaluate((_electron, sources) => {
    global.displayTest.failCompletion = false;
    global.displayTest.clipboard = { sources, operation: 'move', sequence: 43 };
  }, [child, overlap]);
  await panel(1).locator('.panel-tab-label').click(); await page.keyboard.press('Control+v');
  await row('overlap', 1).waitFor(); await idle();
  assert.equal(fs.readFileSync(path.join(target, 'overlap', 'child.txt'), 'utf8'), 'nested content');
  assert.equal(fs.existsSync(overlap), false);
  const completion = await application.evaluate(() => global.displayTest.completions.at(-1));
  assert.equal(completion.sequence, 43);
  assert.deepEqual(new Set(completion.completed), new Set([child, overlap]));
  assert.equal(await page.locator('#paste-button').isDisabled(), true);
  record('Moving overlapping parent/child clipboard sources preserves nesting and clears every moved source');

  await option(/숨김 항목/, true);
  await page.getByRole('button', { name: '보기', exact: true }).click();
  await capture('view-options.png');
  await page.keyboard.press('Escape');
  await application.close(); application = undefined;
  await start(); await row('secret.txt').waitFor();
  assert.equal(await row('beta.hwp').locator('.file-name span[title]').textContent(), 'beta');
  const saved = JSON.parse(fs.readFileSync(path.join(settings, 'preferences.json'), 'utf8'));
  assert.equal(saved.showHidden, true); assert.equal(saved.showExtensions, false);
  for (const width of [900, 760]) {
    await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setContentSize(width, 700), width);
    await page.getByRole('button', { name: '보기', exact: true }).click();
    const bounds = await page.getByRole('checkbox', { name: /숨김 항목/ }).boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
    assert.equal(viewport.scrollWidth, viewport.width, 'Display control must not overflow the page');
    await page.keyboard.press('Escape');
  }
  assert.deepEqual(errors, []);
  record('Display preferences survive a full process restart alongside existing folder settings');
  record('Display controls stay accessible at 900px and minimum 760px window widths');
  const report = { passed: true, root, executable, packaged, checks, errors,
    sourceSHA256: createHash('sha256').update(fs.readFileSync(path.join(project, 'app.js'))).digest('hex'),
    limits: 'Trusted Chromium mouse events and real isolated filesystem/preferences. System clipboard and outbound native drag are intercepted; no physical external-app drop or network share verified.' };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error); fs.writeFileSync(path.join(root, 'failure.txt'), error.stack); process.exitCode = 1; })
  .finally(async () => { await application?.close(); });
