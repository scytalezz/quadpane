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
const root = path.join(project, '.checks', 'native-integration', `run-${Date.now()}`);
const source = path.join(root, '원본'), target = path.join(root, '대상');
const profile = path.join(root, 'profile');
for (const dir of [source, target, path.join(target, 'folder'), path.join(profile, 'quadpane-data')]) fs.mkdirSync(dir, { recursive: true });
for (const name of ['alpha.txt', 'beta.txt', 'move.txt', 'copy.txt', 'shift.txt']) fs.writeFileSync(path.join(source, name), name);
const state = location => ({ path: location, sort: 'name', direction: 1 });
fs.writeFileSync(path.join(profile, 'quadpane-data', 'session.json'), JSON.stringify({ version: 1, workspaceId: 'design', workspaces: {
  design: { layout: 4, active: 0, panes: [source, target, source, target].map(state) },
  documents: { layout: 4, active: 0, panes: [source, target, source, target].map(state) },
} }));
let application, page;
const checks = [], errors = [];
const row = (name, index = 0) => page.locator(`#panel-design-${index} tr[data-file]`).filter({ has: page.locator('.file-name > span', { hasText: new RegExp(`^${name.replaceAll('.', '\\.')}$`) }) });
async function idle() { await page.waitForFunction(() => document.querySelector('#activity-strip').getAttribute('aria-busy') === 'false'); }
async function calls() { return application.evaluate(() => global.nativeCalls); }
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
  if (native) await application.evaluate(() => { global.finishDrag?.({ ok: true, value: { action: 'drop' } }); global.finishDrag = null; });
  await row(name, 1).waitFor(); await idle();
  return effect;
}
(async () => {
  application = await _electron.launch({ executablePath: path.join(project, 'dist-portable', 'win-unpacked', 'Quadpane.exe'),
    args: ['--pane-smoke-test'], env: { ...process.env, PORTABLE_EXECUTABLE_DIR: profile }, timeout: 30000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await row('alpha.txt').waitFor();
  await application.evaluate(({ ipcMain }) => {
    global.nativeCalls = []; global.nextMenuAction = 'cancel'; global.testClipboard = { sources: [], operation: 'copy' };
    for (const channel of ['pane:shell-menu', 'pane:begin-native-drag', 'pane:read-shell-clipboard', 'pane:write-shell-clipboard']) ipcMain.removeHandler(channel);
    ipcMain.handle('pane:shell-menu', (_event, request) => { global.nativeCalls.push({ type: 'menu', ...request }); return { ok: true, value: { action: global.nextMenuAction } }; });
    ipcMain.handle('pane:begin-native-drag', (_event, paths) => { global.nativeCalls.push({ type: 'drag', paths }); return new Promise(resolve => { global.finishDrag = resolve; }); });
    ipcMain.handle('pane:read-shell-clipboard', () => ({ ok: true, value: global.testClipboard }));
    ipcMain.handle('pane:write-shell-clipboard', (_event, value) => { global.testClipboard = value; return { ok: true, value }; });
  });
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
  const resources = path.join(project, 'dist-portable', 'win-unpacked', 'resources');
  const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
  const report = { passed: true, checks, errors, asarSHA256: hash(path.join(resources, 'app.asar')), helperSHA256: hash(path.join(resources, 'native', 'Quadpane.Shell.exe')),
    limits: 'Shell menu, drag loop and system clipboard IPC intercepted. No physical Explorer/browser drop, popup interaction, third-party invocation or property-sheet lifetime verified here.' };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, ...report }, null, 2));
})().catch(error => { console.error(error); fs.writeFileSync(path.join(root, 'failure.txt'), error.stack); process.exitCode = 1; })
  .finally(async () => { await application?.close(); });
