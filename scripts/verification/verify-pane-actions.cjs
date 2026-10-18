'use strict';
// Isolated renderer integration. File creation/rename use temporary files;
// trash, shell menus, native drag and the system clipboard are intercepted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
const { _electron } = dependencies('playwright');
const project = path.resolve(__dirname, '../..');
const baseline = process.argv.includes('--baseline');
const executable = process.argv[3] && !baseline ? path.resolve(process.argv[3]) : require('electron');
const packaged = Boolean(process.argv[3] && !baseline);
const root = path.join(project, '.checks', 'pane-actions', `run-${Date.now()}`);
const profile = path.join(root, 'profile');
const folders = [0, 1, 2, 3].map(index => path.join(root, `folder-${index}`));
for (const folder of folders) {
  fs.mkdirSync(folder, { recursive: true });
  for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) fs.writeFileSync(path.join(folder, name), name);
}
const settings = path.join(profile, packaged ? 'quadpane-data' : '.quadpane-dev-data');
fs.mkdirSync(settings, { recursive: true });
const panes = folders.map(location => ({ path: location, sort: 'name', direction: 1 }));
fs.writeFileSync(path.join(settings, 'session.json'), JSON.stringify({ version: 1, workspaceId: 'design', workspaces: {
  design: { layout: 4, active: 0, panes }, documents: { layout: 2, active: 0, panes },
} }));
let source = project;
if (baseline) {
  source = path.join(root, 'baseline');
  fs.mkdirSync(path.join(source, 'desktop'), { recursive: true });
  const files = ['app.js', 'index.html', 'styles.css', 'theme.js', ...fs.readdirSync(path.join(project, 'desktop')).filter(name => name.endsWith('.cjs') && !name.endsWith('.test.cjs')).map(name => `desktop/${name}`)];
  for (const file of files) fs.writeFileSync(path.join(source, file), execFileSync('git', ['show', `HEAD:${file}`], { cwd: project }));
  fs.copyFileSync(path.join(project, 'desktop/quadpane.ico'), path.join(source, 'desktop/quadpane.ico'));
}
const harness = path.join(root, 'main.cjs');
fs.writeFileSync(harness, `
const service = require.resolve(${JSON.stringify(path.join(source, 'desktop/shell-menu.cjs'))});
require.cache[service] = { exports: { createShellMenuService: () => ({
  start() {}, close() {}, cancel() {}, pending: false,
  async show(_request, _host, mode) { if (mode === 'readClipboard') return { sources: [], operation: 'copy' }; throw new Error('Unexpected shell call: ' + mode); },
}) } };
require(${JSON.stringify(path.join(source, 'desktop/main.cjs'))});
`);
let application, page;
const checks = [], errors = [];
const panel = (index = 0) => page.locator(`#panel-design-${index}`);
const row = (name, index = 0) => panel(index).locator('tr[data-file]').filter({ has: page.locator('.file-name > span', { hasText: new RegExp(`^${name.replaceAll('.', '\\.')}$`) }) });
const open = () => page.locator('#trash-dialog').evaluate(dialog => dialog.open);
async function idle() { await page.waitForFunction(() => document.querySelector('#activity-strip').getAttribute('aria-busy') === 'false'); }
async function capture(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayHidden: true })).toPNG().toString('base64'));
  fs.writeFileSync(path.join(root, name), Buffer.from(png, 'base64'));
}
(async () => {
  const env = { ...process.env, PORTABLE_EXECUTABLE_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await _electron.launch({ executablePath: executable, args: [...(packaged ? [] : [harness]), '--pane-smoke-test'], env, timeout: 30000 });
  page = await application.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await application.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false);
    global.actionChecks = { trash: [], drag: [], pendingTrash: null };
    ipcMain.removeHandler('pane:trash-items');
    ipcMain.handle('pane:trash-items', (_event, request) => {
      global.actionChecks.trash.push(request);
      return new Promise(resolve => { global.actionChecks.pendingTrash = resolve; });
    });
    ipcMain.removeHandler('pane:begin-native-drag');
    ipcMain.handle('pane:begin-native-drag', (_event, paths) => { global.actionChecks.drag.push(paths); return { ok: true, value: { action: 'cancel' } }; });
  });
  for (let index = 0; index < 4; index++) await row('alpha.txt', index).waitFor();
  // Ordinary cancellation must dismiss the modal without dispatching any trash IPC.
  await row('alpha.txt').click(); await page.keyboard.press('Delete');
  await page.locator('#trash-cancel').click();
  assert.equal(await open(), false, 'Cancel closes the delete confirmation');
  await row('beta.txt').click();
  assert.equal(await open(), false, 'Selecting another file must not reopen confirmation');
  checks.push('Cancel closes confirmation; subsequent selection does not reopen it');
  // Repeated keydown while Delete is held must not reopen after a cancellation.
  await page.keyboard.down('Delete'); await page.locator('#trash-cancel').click();
  await page.keyboard.down('Delete');
  assert.equal(await open(), false, 'Held Delete must not reopen a cancelled confirmation');
  await page.keyboard.up('Delete');
  checks.push('Held Delete does not retrigger after cancellation');
  for (const close of ['escape', 'close']) {
    await page.keyboard.press('Delete');
    if (close === 'escape') await page.keyboard.press('Escape');
    else await page.locator('#trash-dialog [aria-label="닫기"]').click();
    assert.equal(await open(), false);
    await row('alpha.txt').click();
    assert.equal(await open(), false);
  }
  assert.equal(await application.evaluate(() => global.actionChecks.trash.length), 0);
  await page.locator('#trash-confirm').evaluate(button => button.click());
  assert.equal(await application.evaluate(() => global.actionChecks.trash.length), 0, 'A late activation after cancellation must not dispatch a stale deletion');
  checks.push('Escape and close button cancel without trash requests');
  // Toolbar actions target their own pane, including when another pane was active.
  for (const index of [0, 1]) {
    assert.equal(await panel(index).locator('[data-action="rename"]').isDisabled(), index === 1);
    await panel(index).locator('[data-action="newfolder"]').click();
    await page.locator('#name-input').fill(`created-${index}`);
    await page.locator('#name-confirm').click(); await idle();
    await row(`created-${index}`, index).waitFor();
    assert.ok(fs.existsSync(path.join(folders[index], `created-${index}`)));
  }
  await row('beta.txt', 1).click(); await row('alpha.txt', 0).click();
  await panel(1).locator('[data-action="rename"]').click();
  assert.equal(await page.locator('#name-input').inputValue(), 'beta.txt');
  await page.locator('#name-input').fill('renamed.txt');
  await page.locator('#name-confirm').click(); await idle(); await row('renamed.txt', 1).waitFor();
  assert.ok(fs.existsSync(path.join(folders[1], 'renamed.txt')));
  assert.ok(fs.existsSync(path.join(folders[0], 'beta.txt')));
  checks.push('New folder and rename affect the clicked pane using real temporary files');
  await row('alpha.txt', 0).click();
  await panel(1).locator('[data-action="trash"]').click();
  assert.match(await page.locator('#trash-items').innerText(), /renamed\.txt/);
  await page.locator('#trash-confirm').click();
  await page.waitForFunction(() => document.querySelector('#activity-strip').getAttribute('aria-busy') === 'true');
  assert.equal(await panel(0).locator('[data-action="newfolder"]').isDisabled(), true);
  assert.equal(await panel(1).locator('[data-action="trash"]').isDisabled(), true);
  const sent = await application.evaluate(() => global.actionChecks.trash);
  assert.deepEqual(sent, [{ paths: [path.join(folders[1], 'renamed.txt')] }]);
  await application.evaluate(() => global.actionChecks.pendingTrash({ ok: true, value: { operation: 'trash', completed: [], skipped: [], failed: [] } }));
  await idle();
  assert.ok(fs.existsSync(path.join(folders[1], 'renamed.txt')), 'Trash is intercepted, never executed');
  checks.push('Trash requires explicit confirmation; pending operation disables toolbar actions');
  // Begin marquee in the left gutter beside a row, not only beneath the list.
  await row('alpha.txt').click();
  const scroll = await panel().locator('.file-scroll').boundingBox();
  const first = await row('alpha.txt').boundingBox(), last = await row('gamma.txt').boundingBox();
  const padding = await panel().locator('.file-scroll').evaluate(element => ({ left: parseFloat(getComputedStyle(element).paddingLeft), right: parseFloat(getComputedStyle(element).paddingRight) }));
  assert.deepEqual(padding, { left: 12, right: 8 });
  await page.mouse.move(scroll.x + 6, first.y + 3); await page.mouse.down();
  await page.mouse.move(first.x + 120, last.y + last.height - 3, { steps: 12 }); await page.mouse.up();
  assert.ok(await panel().locator('tr.selected').count() >= 3);
  assert.equal(await application.evaluate(() => global.actionChecks.drag.length), 0);
  checks.push('12px left gutter supports multi-selection without starting native drag');
  for (const width of [1280, 900, 760]) {
    await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 720), width);
    await page.waitForTimeout(120);
    for (const layout of [4, 2, 1]) {
      await page.locator(`button[data-layout="${layout}"]`).click();
      for (const nav of await page.locator('.file-panel:visible .panel-navigation').all()) {
        const bounds = await nav.boundingBox();
        const input = await nav.locator('.path-input').boundingBox();
        assert.ok(input.width >= 40, `Address input usable at ${width}px / ${layout} panes: ${input.width}`);
        for (const action of ['back', 'forward', 'up', 'refresh', 'newfolder', 'rename', 'trash']) {
          const button = await nav.locator(`[data-action="${action}"]`).boundingBox();
          assert.ok(button && button.x >= bounds.x && button.x + button.width <= bounds.x + bounds.width + 1, `${action} fits ${width}px / ${layout} panes`);
        }
      }
      if (layout === 4) await capture(`toolbar-${width}.png`);
    }
  }
  checks.push('All action icons and address inputs fit 1/2/4 panes at 1280/900/760px');
  assert.deepEqual(errors, []);
  const fingerprint = packaged ? path.join(path.dirname(executable), 'resources/app.asar') : path.join(source, 'app.js');
  const report = { passed: true, baseline, packaged, checks, errors, fingerprint, sha256: createHash('sha256').update(fs.readFileSync(fingerprint)).digest('hex'), limits: 'Hidden Electron; native drag and trash IPC intercepted. Actual trash confirmation dispatch is checked; user files are untouched.' };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, ...report }, null, 2));
})().catch(async error => {
  console.error(error);
  fs.writeFileSync(path.join(root, 'failure.txt'), error.stack);
  if (page) await capture('failure.png').catch(() => {});
  console.log(`Evidence: ${root}`);
  process.exitCode = 1;
}).finally(async () => { await application?.close(); });
