const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
const { _electron } = dependencies('playwright');
const project = path.resolve(__dirname, '..', '..');
const executable = path.join(project, 'dist-portable', 'win-unpacked', 'Quadpane.exe');
const root = path.join(project, '.checks', 'workflows', `run-${Date.now()}`);
const source = path.join(root, '원본');
const target = path.join(root, '복사 대상');
const other = path.join(root, '다른 작업 공간');
const empty = path.join(root, '빈 폴더');
const folder = path.join(source, '프로젝트 & 자료');
const profile = path.join(root, 'app');
for (const directory of [source, target, other, empty, path.join(folder, '하위'), path.join(profile, 'quadpane-data')]) fs.mkdirSync(directory, { recursive: true });
const fileName = "client's & report.txt";
const moveName = '옮길 파일.md';
fs.writeFileSync(path.join(source, fileName), 'original source bytes');
fs.writeFileSync(path.join(source, moveName), 'move this content');
fs.writeFileSync(path.join(folder, '하위', '내용.txt'), 'nested folder contents');
const paneState = location => ({ path: location, sort: 'name', direction: 1 });
const session = { version: 1, workspaceId: 'design', workspaces: {
  design: { layout: 4, active: 0, panes: [source, target, empty, source].map(paneState) },
  documents: { layout: 2, active: 0, panes: [other, empty, source, target].map(paneState) },
} };
fs.writeFileSync(path.join(profile, 'quadpane-data', 'session.json'), JSON.stringify(session));
const checks = [];
const errors = [];
let application;
let page;
const panel = (workspace = 'design', index = 0) => page.locator(`#panel-${workspace}-${index}`);
const row = (name, workspace = 'design', index = 0) => panel(workspace, index).locator('tr[data-file]').filter({ hasText: name });
async function launch() {
  application = await _electron.launch({ executablePath: executable, args: ['--pane-smoke-test'], env: { ...process.env, PORTABLE_EXECUTABLE_DIR: profile }, timeout: 30000 });
  page = await application.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('textbox', { name: '1번 패널 폴더 경로', exact: true }).waitFor();
}
async function waitFor(check, description) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timeout: ${description}`);
}
const prefs = () => page.evaluate(async () => (await window.pane.bootstrap()).value.preferences);
const activate = async (workspace, index) => panel(workspace, index).locator('.panel-tab-label').click();
(async () => {
  await launch();
  await row(fileName).waitFor();
  await page.locator('#add-favorite-button').click();
  await waitFor(async () => (await prefs()).favorites.some(item => item.path === source), 'favorite saved');
  if (await page.locator('#add-favorite-button').isEnabled()) await page.locator('#add-favorite-button').click();
  assert.equal((await prefs()).favorites.filter(item => item.path === source).length, 1);
  await panel().locator('.path-dropdown-toggle').click();
  const menu = page.locator('.address-menu:visible');
  await menu.waitFor();
  assert.ok((await menu.innerText()).includes(source));
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.address-menu:visible').count(), 0);
  checks.push('Custom favorite add/dedup and accessible path dropdown');

  await row(fileName).click();
  await page.keyboard.press('Control+c');
  await activate('design', 1);
  await page.keyboard.press('Control+v');
  await waitFor(() => fs.existsSync(path.join(target, fileName)), 'real copy completed');
  await row(fileName, 'design', 1).waitFor();
  assert.equal(fs.readFileSync(path.join(target, fileName), 'utf8'), 'original source bytes');
  assert.ok(fs.existsSync(path.join(source, fileName)));
  await waitFor(async () => !(await page.locator('#paste-button').isDisabled()), 'transfer unlocked');
  fs.writeFileSync(path.join(target, fileName), 'KEEP EXISTING');
  await page.locator('#paste-button').click();
  await waitFor(async () => (await page.locator('#transfer-result').innerText()).includes('건너'), 'collision report');
  assert.equal(fs.readFileSync(path.join(target, fileName), 'utf8'), 'KEEP EXISTING');
  assert.equal(fs.readFileSync(path.join(source, fileName), 'utf8'), 'original source bytes');
  checks.push('Actual keyboard copy between panes and existing destination never overwritten');

  await row(moveName).click();
  await page.keyboard.press('Control+x');
  await page.locator('[data-workspace="documents"]').click();
  await page.locator('#paste-button').click();
  await waitFor(() => fs.existsSync(path.join(other, moveName)) && !fs.existsSync(path.join(source, moveName)), 'cross-workspace move');
  await row(moveName, 'documents').waitFor();
  assert.equal(fs.readFileSync(path.join(other, moveName), 'utf8'), 'move this content');
  await page.locator('[data-workspace="design"]').click();
  await waitFor(async () => (await row(moveName).count()) === 0, 'source panel refreshed after move');
  checks.push('Cut/paste moves real file across workspaces and refreshes source/destination views');

  await row(fileName).click();
  await row('프로젝트 & 자료').click({ modifiers: ['Control'] });
  assert.equal(await panel().locator('tr[aria-selected="true"]').count(), 2);
  await page.locator('#copy-button').click();
  await page.locator('[data-workspace="documents"]').click();
  await page.locator('#paste-button').click();
  await waitFor(() => fs.existsSync(path.join(other, '프로젝트 & 자료', '하위', '내용.txt')), 'multi file/folder copy');
  assert.equal(fs.readFileSync(path.join(other, fileName), 'utf8'), 'original source bytes');
  assert.equal(fs.readFileSync(path.join(other, '프로젝트 & 자료', '하위', '내용.txt'), 'utf8'), 'nested folder contents');
  assert.ok(fs.existsSync(path.join(folder, '하위', '내용.txt')));
  checks.push('Multi-selection copies a file plus recursive folder across workspaces');

  await page.locator('[data-workspace="design"]').click();
  const address = panel().locator('.path-input');
  await address.fill(empty); await address.press('Enter');
  await waitFor(async () => (await prefs()).recentPaths.includes(empty), 'recent address persisted');
  await panel().locator('.path-dropdown-toggle').click();
  await page.locator('.address-menu:visible .address-option').filter({ hasText: source }).first().click();
  await row(fileName).waitFor();
  assert.equal(await address.inputValue(), source);
  await application.close(); application = undefined;
  await launch();
  await row(fileName).waitFor();
  const restored = await prefs();
  assert.ok(restored.favorites.some(item => item.path === source));
  assert.ok(restored.recentPaths.includes(empty));
  await page.locator('.favorite-row').filter({ hasText: path.basename(source) }).locator('.favorite-remove').click();
  await waitFor(async () => !(await prefs()).favorites.some(item => item.path === source), 'favorite removal saved');
  await application.close(); application = undefined;
  await launch();
  assert.ok(!(await prefs()).favorites.some(item => item.path === source));
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(root, 'native-aria.txt'), await page.locator('body').ariaSnapshot());
  checks.push('Dropdown navigation, recent paths and favorite add/remove survive actual restarts');
  const closeSource = path.join(source, 'close-during-copy.bin');
  const closeTarget = path.join(empty, 'close-during-copy.bin');
  fs.writeFileSync(closeSource, Buffer.alloc(32 * 1024 * 1024, 85));
  await page.evaluate(({ source, destination }) => { window.closeTestTransfer = window.pane.transfer({ sources: [source], destination, operation: 'copy' }); }, { source: closeSource, destination: empty });
  await waitFor(() => fs.readdirSync(empty).some(name => name.startsWith('.pane-copy-')), 'native copy in progress before close');
  await application.close(); application = undefined;
  assert.ok(fs.existsSync(closeTarget), 'Close must wait for the native copy to finish');
  assert.equal(fs.statSync(closeTarget).size, fs.statSync(closeSource).size);
  assert.equal(createHash('sha256').update(fs.readFileSync(closeTarget)).digest('hex'), createHash('sha256').update(fs.readFileSync(closeSource)).digest('hex'));
  checks.push('Closing the actual app during a 32 MiB native copy waits for complete identical destination bytes');
  const report = { passed: true, root, executable, asarSHA256: createHash('sha256').update(fs.readFileSync(path.join(project, 'dist-portable/win-unpacked/resources/app.asar'))).digest('hex'), checks, errors };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  if (page) fs.writeFileSync(path.join(root, 'failure-aria.txt'), await page.locator('body').ariaSnapshot().catch(() => 'unavailable'));
  await application?.close().catch(() => {});
  fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2));
  console.error(error); process.exitCode = 1;
});
