const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
const { _electron } = dependencies('playwright');
const project = path.resolve(__dirname, '..', '..');
const executable = path.join(project, 'dist-portable', 'win-unpacked', 'Quadpane.exe');
const root = path.join(project, '.checks', 'real-files', `run-${Date.now()}`);
const fixture = path.join(root, 'files');
const alpha = path.join(fixture, '한글 Alpha');
const beta = path.join(fixture, 'Beta & notes');
const empty = path.join(fixture, '빈 폴더');
const child = path.join(alpha, '하위 폴더');
const missing = path.join(fixture, '존재하지 않는 폴더');
const profile = path.join(root, 'application');
for (const directory of [alpha, beta, empty, child, path.join(profile, 'quadpane-data')]) fs.mkdirSync(directory, { recursive: true });
const firstFile = path.join(alpha, "client's & report.txt");
fs.writeFileSync(firstFile, Buffer.alloc(1234, 65));
fs.utimesSync(firstFile, new Date('2024-05-06T12:34:56Z'), new Date('2024-05-06T12:34:56Z'));
fs.writeFileSync(path.join(alpha, '최근 파일.md'), '# Real fixture');
fs.writeFileSync(path.join(alpha, 'report.constructor'), 'prototype regression');
fs.writeFileSync(path.join(alpha, 'report.__proto__'), 'prototype regression');
fs.writeFileSync(path.join(beta, 'beta.txt'), 'beta');
fs.writeFileSync(path.join(child, 'child.txt'), 'child');
const fileHash = () => createHash('sha256').update(fs.readFileSync(firstFile)).digest('hex');
const originalHash = fileHash();
const paneState = location => ({ path: location, sort: 'name', direction: 1 });
const state = {
  version: 1, workspaceId: 'design',
  workspaces: {
    design: { layout: 4, active: 0, panes: [alpha, beta, empty, alpha].map(paneState) },
    documents: { layout: 2, active: 0, panes: [beta, alpha, empty, child].map(paneState) },
  },
};
const sessionFile = path.join(profile, 'quadpane-data', 'session.json');
fs.writeFileSync(sessionFile, JSON.stringify(state));
const passed = [];
let application;
const browserErrors = [];
async function launch() {
  application = await _electron.launch({ executablePath: executable, args: ['--pane-smoke-test'], env: { ...process.env, PORTABLE_EXECUTABLE_DIR: profile }, timeout: 30000 });
  const page = await application.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.getByRole('textbox', { name: '1번 패널 폴더 경로', exact: true }).waitFor();
  return page;
}
const address = (page, number) => page.getByRole('textbox', { name: `${number}번 패널 폴더 경로`, exact: true });
const firstPanel = page => page.locator('[data-pane="design-0"]');
async function navigate(page, number, location) {
  await address(page, number).fill(location);
  await address(page, number).press('Enter');
  await page.waitForFunction(({ number, location }) => {
    const panel = document.querySelector(`[data-pane="design-${number - 1}"]`);
    return panel?.querySelector('input')?.value === location && !panel.querySelector('[aria-busy="true"]') && panel.getAttribute('aria-busy') !== 'true';
  }, { number, location });
}
(async () => {
  let page = await launch();
  await firstPanel(page).getByText("client's & report.txt", { exact: true }).waitFor();
  assert.equal(await address(page, 1).inputValue(), alpha);
  assert.equal(await address(page, 2).inputValue(), beta);
  assert.equal(await page.locator('.file-panel:visible').count(), 4);
  await firstPanel(page).getByText('report.constructor', { exact: true }).waitFor();
  await firstPanel(page).getByText('report.__proto__', { exact: true }).waitFor();
  const bootstrap = await page.evaluate(() => window.pane.bootstrap());
  assert.equal(bootstrap.ok, true);
  assert.ok(bootstrap.value.drives.some(drive => drive.path.toLowerCase() === path.parse(project).root.toLowerCase()));
  assert.ok(!(await page.locator('body').innerText()).includes('샘플 드라이브'));
  const listing = await page.evaluate(location => window.pane.listDirectory(location), alpha);
  assert.equal(listing.ok, true);
  const real = listing.value.entries.find(entry => entry.name === "client's & report.txt");
  assert.equal(real.size, 1234);
  assert.equal(real.modified, fs.statSync(firstFile).mtime.toISOString());
  assert.equal(listing.value.entries.find(entry => entry.name === '하위 폴더').type, 'folder');
  assert.equal(await firstPanel(page).locator('time').filter({ hasText: '2024-05-06' }).count(), 1);
  assert.deepEqual(await page.evaluate(() => [typeof require, typeof process]), ['undefined', 'undefined']);
  passed.push('Actual drive discovery, persisted initial paths, real names/size/mtime, isolated renderer');

  const rows = firstPanel(page).locator('tr[data-file]');
  await rows.filter({ hasText: "client's & report.txt" }).click();
  await page.locator('#file-info-button').click();
  const info = page.getByRole('dialog');
  await info.waitFor();
  assert.ok((await info.innerText()).includes("client's & report.txt"));
  await page.keyboard.press('Escape');
  await rows.filter({ hasText: '하위 폴더' }).dblclick();
  await firstPanel(page).getByText('child.txt', { exact: true }).waitFor();
  assert.equal(await address(page, 1).inputValue(), child);
  await firstPanel(page).getByRole('button', { name: '뒤로', exact: true }).click();
  await firstPanel(page).getByText("client's & report.txt", { exact: true }).waitFor();
  await page.keyboard.press('Control+l');
  assert.equal(await address(page, 1).evaluate(element => element === document.activeElement), true);
  await address(page, 1).fill('수정 중인 주소');
  await address(page, 1).press('Escape');
  assert.equal(await address(page, 1).inputValue(), alpha);
  passed.push('Real file properties, folder double-click/back, Ctrl+L address focus and Escape draft reset');

  await address(page, 1).fill(missing);
  await address(page, 1).press('Enter');
  await page.waitForFunction(() => document.body.innerText.includes('찾을 수') || document.body.innerText.includes('존재하지'));
  const invalid = await page.evaluate(async () => {
    const results = [];
    for (const value of ['C:relative', 'https://example.com/', '\\\\.\\C:', 123]) results.push(await window.pane.listDirectory(value));
    return results;
  });
  assert.ok(invalid.every(result => result.ok === false));
  await navigate(page, 1, empty);
  await page.waitForFunction(() => document.querySelector('[data-pane="design-0"] tbody')?.children.length === 0);
  assert.equal(await firstPanel(page).locator('tr[data-file]').count(), 0);
  passed.push('Missing/invalid path handling and actual empty directory');

  await navigate(page, 1, child);
  await firstPanel(page).getByText('child.txt', { exact: true }).waitFor();
  await page.getByRole('button', { name: '2분할', exact: true }).click();
  await application.close(); application = undefined;
  const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(saved.workspaces.design.panes[0].path, child);
  assert.equal(saved.workspaces.design.layout, 2);
  page = await launch();
  await firstPanel(page).getByText('child.txt', { exact: true }).waitFor();
  assert.equal(await address(page, 1).inputValue(), child);
  assert.equal(await page.locator('.file-panel:visible').count(), 2);
  assert.equal(await address(page, 2).inputValue(), beta);
  passed.push('Paths and layout saved even on immediate close, then restored on actual restart');
  await application.close(); application = undefined;

  const unavailable = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  unavailable.workspaces.design.panes[0].path = missing;
  fs.writeFileSync(sessionFile, JSON.stringify(unavailable));
  page = await launch();
  await page.waitForFunction(location => document.querySelector('[data-pane="design-0"] input')?.value === location, missing);
  await page.waitForFunction(() => document.body.innerText.includes('찾을 수') || document.body.innerText.includes('존재하지'));
  assert.equal(await address(page, 1).inputValue(), missing);
  const stored = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  assert.equal(stored.workspaces.design.panes[0].path, missing);
  await navigate(page, 1, alpha);
  await firstPanel(page).getByText("client's & report.txt", { exact: true }).waitFor();
  assert.equal(fileHash(), originalHash, 'Browsing must not modify the source file');
  assert.deepEqual(browserErrors, []);
  fs.writeFileSync(path.join(root, 'native-aria.txt'), await page.locator('body').ariaSnapshot());
  await application.close(); application = undefined;
  passed.push('Unavailable restored path retained and recoverable, unchanged file bytes, no runtime errors');
  const report = { passed: true, executable, root, sessionFile, sourceFileHash: originalHash, asarSHA256: createHash('sha256').update(fs.readFileSync(path.join(project,'dist-portable/win-unpacked/resources/app.asar'))).digest('hex'), checks: passed };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  if (application) await application.close().catch(() => {});
  fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify({ error: error.stack, checks: passed, browserErrors }, null, 2));
  console.error(error);
  process.exitCode = 1;
});
