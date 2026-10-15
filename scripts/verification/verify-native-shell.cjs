'use strict';
// Renderer/IPC integration. Real COM enumeration is covered by shell-menu.test.cjs.
// OS dialogs, drag loop and clipboard are intercepted to avoid touching user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
const { _electron } = dependencies('playwright');
const project = path.resolve(__dirname, '..', '..');
const fromSource = process.argv[3] === '--source';
const executable = fromSource ? require('electron') : path.resolve(process.argv[3] || path.join(project, 'dist-portable', 'win-unpacked', 'Quadpane.exe'));
const root = path.join(project, '.checks', 'native-integration', `run-${Date.now()}`);
const source = path.join(root, '원본'), target = path.join(root, '대상');
const profile = path.join(root, 'profile');
const settings = path.join(profile, fromSource ? '.quadpane-dev-data' : 'quadpane-data');
for (const dir of [source, target, path.join(target, 'folder'), settings]) fs.mkdirSync(dir, { recursive: true });
for (const name of ['alpha.txt', 'beta.txt', 'move.txt', 'copy.txt', 'shift.txt']) fs.writeFileSync(path.join(source, name), name);
const state = location => ({ path: location, sort: 'name', direction: 1 });
fs.writeFileSync(path.join(settings, 'session.json'), JSON.stringify({ version: 1, workspaceId: 'design', workspaces: {
  design: { layout: 4, active: 0, panes: [source, target, source, target].map(state) },
  documents: { layout: 4, active: 0, panes: [source, target, source, target].map(state) },
} }));
// Exercise the current renderer/preload/main without rebuilding a preview or ever
// starting the real helper. All shell IPC is replaced below before test gestures.
const harness = path.join(root, 'main.cjs');
if (fromSource) fs.writeFileSync(harness, `
const service = require.resolve(${JSON.stringify(path.join(project, 'desktop', 'shell-menu.cjs'))});
require.cache[service] = { exports: { createShellMenuService: () => ({
  start() {}, close() {}, cancel() {}, pending: false,
  async show(_request, _host, mode) {
    if (mode === 'readClipboard') return { sources: [], operation: 'copy' };
    throw new Error('Unexpected native helper call in isolated verification: ' + mode);
  },
}) } };
require(${JSON.stringify(path.join(project, 'desktop', 'main.cjs'))});
`);
let application, page;
const checks = [], errors = [];
const row = (name, index = 0) => page.locator(`#panel-design-${index} tr[data-file]`).filter({ has: page.locator('.file-name > span', { hasText: new RegExp(`^${name.replaceAll('.', '\\.')}$`) }) });
async function idle() { await page.waitForFunction(() => document.querySelector('#activity-strip').getAttribute('aria-busy') === 'false'); }
async function calls() { return application.evaluate(() => global.nativeCalls); }
async function count(type) { return (await calls()).filter(call => call.type === type).length; }
const cancelled = { ok: false, error: { code: 'SHELL_CANCELLED', message: 'Test cancellation' } };
async function settle(type, result = { ok: true, value: null }, reject = false) {
  await application.evaluate((_electron, { type, result, reject }) => {
    const pending = global.pendingNative[type].shift();
    if (!pending) throw new Error(`No pending ${type} IPC to settle`);
    if (reject) pending.reject(new Error(result));
    else pending.resolve(result);
  }, { type, result, reject });
  await page.waitForTimeout(100);
  await page.waitForFunction(() => !document.querySelector('#panels [aria-busy="true"]'));
}
async function startDrag(name) {
  await row(name).evaluate(element => element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })));
  await page.waitForTimeout(100);
}
async function assertShellSuppressed(message) {
  const before = { drag: await count('drag'), menu: await count('menu') };
  await startDrag('beta.txt');
  await row('beta.txt').click({ button: 'right' });
  await page.keyboard.press('Shift+F10');
  assert.deepEqual({ drag: await count('drag'), menu: await count('menu') }, before, message);
}
async function drop(name, modifiers = {}, native = true) {
  await row(name).click();
  await page.locator('#fixture-input').setInputFiles(path.join(source, name));
  if (native) {
    await row(name).evaluate(element => element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })));
    await page.waitForTimeout(100);
    assert.ok((await calls()).some(call => call.type === 'drag' && call.paths.includes(path.join(source, name))));
  }
  const effect = await page.evaluate(modifiers => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(document.querySelector('#fixture-input').files[0]);
    dataTransfer.effectAllowed = 'copyMove';
    const destination = document.querySelector('#panel-design-1 .file-scroll');
    destination.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, ...modifiers }));
    const feedback = document.querySelector('#drag-feedback').textContent;
    destination.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer, ...modifiers }));
    return feedback;
  }, modifiers);
  // In-app transfer must finish while native drag IPC remains unresolved: OLE's
  // nested drop loop can be waiting for this very transfer to acknowledge it.
  await row(name, 1).waitFor(); await idle();
  if (native) {
    assert.equal(await application.evaluate(() => global.pendingNative.drag.length), 1);
    await assertShellSuppressed('Dropping clears source visuals, not the native IPC reservation');
    await settle('drag', { ok: true, value: { action: 'drop' } });
  }
  return effect;
}
(async () => {
  application = await _electron.launch({ executablePath: executable,
    args: [...(fromSource ? [harness] : []), '--pane-smoke-test'], env: { ...process.env, PORTABLE_EXECUTABLE_DIR: profile }, timeout: 30000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  page.on('pageerror', error => errors.push(error.message));
  await row('alpha.txt').waitFor();
  await application.evaluate(({ ipcMain }) => {
    global.nativeCalls = []; global.nextMenuAction = 'cancel'; global.testClipboard = { sources: [], operation: 'copy' };
    global.pendingNative = { drag: [], menu: [], cancel: [] }; global.holdMenu = false;
    const deferred = type => new Promise((resolve, reject) => global.pendingNative[type].push({ resolve, reject }));
    for (const channel of ['pane:shell-menu', 'pane:begin-native-drag', 'pane:cancel-shell', 'pane:read-shell-clipboard', 'pane:write-shell-clipboard', 'pane:complete-shell-paste']) ipcMain.removeHandler(channel);
    ipcMain.handle('pane:shell-menu', (_event, request) => { global.nativeCalls.push({ type: 'menu', ...request }); return global.holdMenu ? deferred('menu') : { ok: true, value: { action: global.nextMenuAction } }; });
    ipcMain.handle('pane:begin-native-drag', (_event, paths) => { global.nativeCalls.push({ type: 'drag', paths }); return deferred('drag'); });
    ipcMain.handle('pane:read-shell-clipboard', () => ({ ok: true, value: global.testClipboard }));
    ipcMain.handle('pane:write-shell-clipboard', (_event, value) => { global.testClipboard = value; return { ok: true, value }; });
    ipcMain.handle('pane:complete-shell-paste', () => ({ ok: true, value: null }));
    ipcMain.handle('pane:cancel-shell', () => { global.nativeCalls.push({ type: 'cancel' }); return deferred('cancel'); });
  });
  await row('alpha.txt').click();
  await startDrag('alpha.txt');
  await startDrag('beta.txt');
  assert.equal((await calls()).filter(call => call.type === 'drag').length, 1, 'A second dragstart must not dispatch while native drag IPC is unresolved');
  await assertShellSuppressed('A native drag suppresses duplicate mouse and keyboard shell menus');
  await page.evaluate(() => document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() })));
  await assertShellSuppressed('A document drop must not release unresolved native drag IPC');
  // Escape must reach cancellation even when a pane input normally consumes it.
  await page.locator('#panel-design-0 .path-input').focus();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  assert.equal(await count('cancel'), 1, 'Repeated Escape must not dispatch overlapping cancellations');
  await settle('cancel');
  await assertShellSuppressed('An early cancel acknowledgement cannot release an unresolved drag');
  await settle('drag', cancelled);
  checks.push('Deferred native drag suppresses duplicate drag/menu IPC before and after drop; Escape from an input cancels once; early cancel acknowledgement preserves reservation');

  let drags = await count('drag');
  await startDrag('alpha.txt');
  assert.equal(await count('drag'), drags + 1, 'Dragging recovers after cancellation');
  await settle('drag', 'Mock rejected native drag IPC', true);
  await startDrag('alpha.txt');
  assert.equal(await count('drag'), drags + 2, 'Rejected drag IPC releases its reservation');
  await settle('drag', { ok: false, error: { code: 'SHELL_NATIVE_ERROR', message: 'Mock native failure' } });
  await startDrag('alpha.txt');
  assert.equal(await count('drag'), drags + 3, 'Native error response releases its reservation');
  await page.keyboard.press('Escape');
  await settle('drag', cancelled);
  await assertShellSuppressed('A late cancellation acknowledgement must not reach a newer gesture');
  await settle('cancel');
  await startDrag('alpha.txt');
  assert.equal(await count('drag'), drags + 4, 'Both drag and late cancel response settle before a new gesture');
  for (const rejection of [false, true]) {
    const cancels = await count('cancel');
    await page.keyboard.press('Escape');
    assert.equal(await count('cancel'), cancels + 1, 'Cancellation can be retried after a failed response');
    await settle('cancel', rejection ? 'Mock rejected cancel IPC' : { ok: false, error: { code: 'SHELL_NATIVE_ERROR', message: 'Mock cancel failure' } }, rejection);
    await assertShellSuppressed('Failed cancellation cannot release a still-live native drag');
  }
  await page.keyboard.press('Escape'); await settle('cancel'); await settle('drag', cancelled);
  checks.push('Drag errors and rejected IPC recover; late cancel responses cannot affect a newer drag; failed/rejected cancellation remains retryable without releasing live drag');

  await application.evaluate(() => { global.holdMenu = true; });
  await row('alpha.txt').click({ button: 'right' });
  assert.equal(await count('menu'), 1);
  await assertShellSuppressed('Deferred shell menu suppresses duplicate menus and native drags');
  await page.keyboard.press('Escape'); await settle('menu', cancelled); await idle();
  await assertShellSuppressed('Cancelled menu waits for its cancellation response before another operation');
  await settle('cancel');
  await row('alpha.txt').click({ button: 'right' });
  assert.equal(await count('menu'), 2, 'Menu dispatch recovers after cancellation');
  await settle('menu', 'Mock rejected menu IPC', true); await idle();
  await application.evaluate(() => { global.holdMenu = false; });
  checks.push('Deferred menu rejects duplicate menu/drag dispatch, handles Escape and recovers after cancellation and IPC rejection');
  await row('alpha.txt').click(); await row('beta.txt').click({ modifiers: ['Control'] });
  await row('alpha.txt').click({ button: 'right' }); await idle();
  assert.equal((await calls()).at(-1).paths.length, 2);
  assert.equal(await page.locator('#file-context-menu').evaluate(el => el.matches(':popover-open')), false);
  assert.equal(await page.locator('#copy-button').isEnabled(), true);
  await row('alpha.txt').click(); await page.keyboard.press('Shift+F10'); await idle();
  assert.equal((await calls()).at(-1).type, 'menu');
  await page.locator('#panel-design-1 .file-scroll').click({ button: 'right', position: { x: 30, y: 140 } }); await idle();
  assert.deepEqual((await calls()).at(-1).paths, []);
  checks.push('Right-click multi-selection, keyboard and background call shell IPC; no HTML menu; toolbar recovers');
  await application.evaluate(() => { global.nextMenuAction = 'rename'; });
  await row('alpha.txt').click({ button: 'right' }); await page.locator('#name-dialog').waitFor();
  await page.locator('#name-input').fill('renamed.txt'); await page.locator('#name-confirm').click();
  await row('renamed.txt').waitFor(); await idle();
  assert.equal(fs.readFileSync(path.join(source, 'renamed.txt'), 'utf8'), 'alpha.txt');
  checks.push('Shell rename handoff uses real existing rename service');
  await row('beta.txt').click(); await page.keyboard.press('Control+c');
  await page.waitForFunction(() => document.querySelector('#clipboard-status').textContent.includes('1개'));
  await page.locator('#panel-design-1 .file-scroll').click({ position: { x: 30, y: 140 } });
  await page.keyboard.press('Control+v'); await row('beta.txt', 1).waitFor(); await idle();
  checks.push('Keyboard copy/paste uses shared clipboard bridge and real transfer service (OS clipboard intercepted)');
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'fixture-input'; input.hidden = true; document.body.append(input); });
  assert.match(await drop('move.txt'), /이동/u);
  assert.equal(fs.existsSync(path.join(source, 'move.txt')), false);
  assert.match(await drop('copy.txt', { ctrlKey: true }), /복사/u);
  assert.equal(fs.existsSync(path.join(source, 'copy.txt')), true);
  assert.match(await drop('shift.txt', { shiftKey: true }, false), /복사/u);
  assert.equal(fs.existsSync(path.join(source, 'shift.txt')), true);
  checks.push('Default drag dispatch without Alt; disk-backed File drops perform internal move, Ctrl copy and external copy even with Shift; feedback matches operation');
  assert.deepEqual(errors, []);
  const resources = path.join(path.dirname(executable), 'resources');
  const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  const hashes = fromSource ? { rendererSHA256: hash(path.join(project, 'app.js')), mainSHA256: hash(path.join(project, 'desktop', 'main.cjs')) }
    : { asarSHA256: hash(path.join(resources, 'app.asar')), helperSHA256: hash(path.join(resources, 'native', 'Quadpane.Shell.exe')) };
  const report = { passed: true, fromSource, checks, errors, ...hashes,
    limits: 'Shell menu, drag loop and system clipboard IPC intercepted. No physical Explorer/browser drop, popup interaction, third-party invocation or property-sheet lifetime verified here.' };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, ...report }, null, 2));
})().catch(error => { console.error(error); fs.writeFileSync(path.join(root, 'failure.txt'), error.stack); process.exitCode = 1; })
  .finally(async () => { await application?.close(); });
