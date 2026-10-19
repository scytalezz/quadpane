'use strict';
// node scripts/verification/verify-updates.cjs [Playwright dependency root]
// Headless browser, local route fulfillment and an injected IPC contract only.
// No updater service, network, installer, native shell or real user files are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
const { chromium } = dependencies('playwright');
const project = path.resolve(__dirname, '../..');
const root = path.join(project, '.checks', 'updates', `run-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });
const checks = [], errors = [], unexpectedRequests = [];
let browser, page;
async function fixture(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (url.hostname !== 'updates.test' || !['index.html', 'app.js', 'styles.css', 'theme.js'].includes(filename)) {
      unexpectedRequests.push(url.href); return route.abort();
    }
    return route.fulfill({ body: fs.readFileSync(path.join(project, filename)), contentType: filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'text/javascript' });
  });
  if (!options.noBridge) await context.addInitScript(options => {
    const folder = 'C:\\Update fixture';
    const pane = () => ({ path: folder, sort: 'name', direction: 1 });
    const session = { version: 1, workspaceId: 'design', workspaces: {
      design: { layout: 4, active: 0, panes: Array.from({ length: 4 }, pane) },
      documents: { layout: 2, active: 0, panes: Array.from({ length: 4 }, pane) },
    } };
    const ok = value => ({ ok: true, value });
    const failure = message => ({ ok: false, error: { message } });
    let listener;
    const f = window.updateFixture = {
      state: { currentVersion: '0.9.0', status: options.status || 'idle', latestVersion: null, progress: null, message: '', releaseUrl: null },
      calls: [], savedSessions: [], savedPreferences: [], bootFails: Boolean(options.bootFails),
      emit(patch) { Object.assign(f.state, patch); listener?.({ ...f.state }); },
      finishCheck(status) { f.emit({ status }); f.resolveCheck(ok({ ...f.state })); },
    };
    window.pane = {
      bootstrap: async () => f.bootFails ? failure('시작 fixture 오류') : ok({ update: { ...f.state }, session, preferences: { favorites: [], recentPaths: [], showHidden: false, showExtensions: true }, drives: [], favorites: [{ id: 'home', label: '홈', path: folder, icon: 'home' }] }),
      listDirectory: async location => ok({ path: location, name: 'Fixture', parent: 'C:\\', breadcrumbs: [], entries: [{ path: location + '\\sample.txt', name: 'sample.txt', type: 'file', size: 12, modified: '2026-01-01T00:00:00Z' }] }),
      saveSession: async value => {
        f.calls.push('session:start'); f.savedSessions.push(structuredClone(value));
        if (f.holdSession) await new Promise(resolve => { f.releaseSession = resolve; });
        f.calls.push('session:end'); return f.sessionFails ? failure('저장 fixture 오류') : ok(null);
      },
      savePreferences: async value => {
        f.calls.push('preferences:start'); f.savedPreferences.push(structuredClone(value));
        if (f.holdPreferences) await new Promise(resolve => { f.releasePreferences = resolve; });
        f.calls.push('preferences:end'); return f.preferencesFail ? failure('보기 설정 fixture 오류') : ok(value);
      },
      updateState: async () => options.stateReadFails ? failure('상태 조회 fixture 오류') : ok({ ...f.state }),
      onUpdateState: callback => { listener = callback; return () => { listener = null; f.unsubscribed = true; }; },
      checkForUpdates: () => {
        f.calls.push('check'); f.emit({ status: 'checking', message: '' });
        return new Promise(resolve => { f.resolveCheck = resolve; });
      },
      downloadUpdate: async () => {
        f.calls.push('download');
        if (f.downloadFails) throw new Error('다운로드 fixture 오류');
        f.emit({ status: 'downloading', progress: 0, message: '' }); return ok({ ...f.state });
      },
      installUpdate: async () => { f.calls.push('install'); return f.installFails ? failure('설치 fixture 오류') : ok({ restarting: true }); },
      transfer: async () => {
        f.calls.push('transfer'); await new Promise(resolve => { f.releaseTransfer = resolve; });
        return ok({ operation: 'copy', completed: [], failed: [], skipped: [] });
      },
      trashItems: async () => { f.calls.push('trash'); return ok({ operation: 'trash', completed: [], failed: [], skipped: [] }); },
      beginNativeDrag: async () => {
        f.calls.push('drag'); await new Promise(resolve => { f.releaseDrag = resolve; }); return ok({});
      },
    };
  }, options);
  const next = await context.newPage();
  next.setDefaultTimeout(10000);
  next.on('pageerror', error => errors.push(error.message));
  await next.goto('http://updates.test/');
  if (!options.noBridge && !options.bootFails) await next.waitForFunction(() => document.querySelectorAll('.file-panel[aria-busy="false"]').length === 8);
  return next;
}
const emit = patch => page.evaluate(patch => window.updateFixture.emit(patch), patch);
const calls = () => page.evaluate(() => window.updateFixture.calls);
const count = async name => (await calls()).filter(call => call === name).length;
const isOpen = selector => page.locator(selector).evaluate(element => element.open);
const visible = selector => page.locator(selector).isVisible();
const waitStatus = status => page.waitForFunction(status => document.querySelector('#update-button').dataset.status === status, status);
const readyForInstall = () => page.waitForFunction(() => !document.querySelector('#update-install').disabled);
const check = (condition, message) => assert.ok(condition, message);
(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await fixture();
  assert.equal(await page.locator('#app-version').innerText(), 'v0.9.0');
  assert.equal(await page.locator('#connection-status').count(), 0);
  assert.equal(await page.locator('body').innerText().then(text => text.includes('이 PC에 연결됨')), false);
  assert.equal(await isOpen('#update-dialog'), false);
  assert.equal(await count('check'), 0, 'Renderer does not duplicate the parent startup check');
  await page.locator('#update-button').focus(); await page.keyboard.press('Enter');
  await waitStatus('checking'); assert.equal(await count('check'), 1);
  check(await page.locator('#update-check').isDisabled());
  await page.evaluate(() => window.updateFixture.finishCheck('current'));
  await waitStatus('current'); check(await visible('#update-check'));
  await page.keyboard.press('Escape');
  assert.equal(await isOpen('#update-dialog'), false);
  assert.equal(await page.locator('#update-button').getAttribute('aria-expanded'), 'false');
  await page.locator('#update-button').press('Space'); await waitStatus('checking');
  assert.equal(await count('check'), 2, 'Current-version footer rechecks on keyboard activation');
  await page.evaluate(() => window.updateFixture.finishCheck('available'));
  await emit({ latestVersion: '0.10.0' });
  assert.equal(await count('download'), 0);
  check(await visible('#update-download')); check(!(await visible('#update-install')));
  await page.locator('#update-close').click();
  await emit({ status: 'error', message: 'offline <img src=x onerror=alert(1)>' });
  assert.equal(await isOpen('#update-dialog'), false);
  check((await page.locator('#update-button').getAttribute('title')).includes('offline'));
  check(!(await page.locator('#toast').getAttribute('class')).includes('visible'));
  await page.locator('#update-button').click();
  check((await page.locator('#update-message').innerText()).includes('<img'));
  assert.equal(await page.locator('#update-message img').count(), 0);
  await page.locator('#update-check').click();
  await page.evaluate(() => window.updateFixture.finishCheck('available'));
  await page.evaluate(() => { window.updateFixture.downloadFails = true; });
  await page.locator('#update-download').click();
  await page.locator('#update-action-error').waitFor();
  assert.equal(await count('install'), 0);
  await page.evaluate(() => { window.updateFixture.downloadFails = false; });
  await page.locator('#update-download').click(); await waitStatus('downloading');
  await emit({ progress: 42 });
  assert.equal(await page.locator('#update-progress').getAttribute('value'), '42');
  await page.locator('#update-close').click();
  await emit({ progress: 67 });
  assert.equal(await isOpen('#update-dialog'), false);
  check((await page.locator('#update-button').innerText()).includes('67%'));
  await page.locator('#update-button').click();
  assert.equal(await page.locator('#update-progress').getAttribute('value'), '67');
  await emit({ progress: null });
  assert.equal(await page.locator('#update-progress').getAttribute('value'), null);
  await page.keyboard.press('Escape'); await emit({ status: 'ready', progress: 100 });
  assert.equal(await isOpen('#update-dialog'), false);
  assert.equal(await count('install'), 0, 'Download completion never installs automatically');
  checks.push('All update states; keyboard checks; safe error text; quiet background failure; download close/reopen and determinate/indeterminate progress');

  await page.locator('#panel-design-0 [data-file]').click();
  await page.keyboard.down('Delete');
  check(await isOpen('#trash-dialog'));
  assert.equal(await page.evaluate(() => document.activeElement.id), 'trash-cancel');
  await page.locator('#update-button').evaluate(button => button.click());
  assert.equal(await isOpen('#update-dialog'), false, 'No modal stacking');
  await page.keyboard.press('Enter');
  assert.equal(await isOpen('#trash-dialog'), false); assert.equal(await count('trash'), 0);
  await page.keyboard.down('Delete');
  assert.equal(await isOpen('#trash-dialog'), false, 'Held Delete does not reopen canceled trash');
  await page.keyboard.up('Delete');
  await page.locator('#update-button').click();
  await page.keyboard.press('Delete'); await page.keyboard.press('Control+v');
  assert.equal(await count('trash'), 0); assert.equal(await count('transfer'), 0);
  assert.equal(await page.locator('dialog[open]').count(), 1);
  await page.keyboard.press('Escape');
  checks.push('Delete cancel/held-key guard preserved; update modal blocks file shortcuts and does not overlap trash dialog');

  await page.locator('#panel-design-0 [data-file]').click();
  await page.locator('#copy-button').click(); await page.locator('#paste-button').click();
  await page.waitForFunction(() => window.updateFixture.calls.includes('transfer'));
  await page.locator('#update-button').click();
  check(await page.locator('#update-install').isDisabled());
  await page.locator('#update-install').dispatchEvent('click'); assert.equal(await count('install'), 0);
  await page.evaluate(() => window.updateFixture.releaseTransfer()); await readyForInstall();
  await page.keyboard.press('Escape');
  await page.locator('#panel-design-0 [data-file]').dispatchEvent('dragstart');
  await page.waitForFunction(() => window.updateFixture.calls.includes('drag'));
  await page.locator('#update-button').click(); check(await page.locator('#update-install').isDisabled());
  await page.locator('#update-install').dispatchEvent('click'); assert.equal(await count('install'), 0);
  await page.evaluate(() => window.updateFixture.releaseDrag()); await readyForInstall();
  checks.push('In-flight file transfer and native drag block install, including synthetic clicks; controls unlock after completion');

  await page.evaluate(() => { window.updateFixture.sessionFails = true; });
  await page.locator('#update-install').click(); await page.locator('#update-action-error').waitFor();
  assert.equal(await count('install'), 0); check((await page.locator('#update-action-error').innerText()).includes('폴더 위치'));
  await page.evaluate(() => { window.updateFixture.sessionFails = false; window.updateFixture.preferencesFail = true; });
  await page.locator('#update-install').click();
  await page.waitForFunction(() => document.querySelector('#update-action-error').textContent.includes('보기 설정'));
  assert.equal(await count('install'), 0);
  await page.evaluate(() => { window.updateFixture.preferencesFail = false; window.updateFixture.installFails = true; });
  await page.locator('#update-install').click();
  await page.waitForFunction(() => document.querySelector('#update-action-error').textContent.includes('설치 fixture'));
  assert.equal(await count('install'), 1); await readyForInstall();
  await page.keyboard.press('Escape');
  await page.locator('[data-layout="2"]').click();
  await page.locator('#view-settings-button').click(); await page.locator('#show-hidden').check(); await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const f = window.updateFixture; f.installFails = false; f.holdSession = true; f.holdPreferences = true; f.calls = [];
  });
  await page.locator('#update-button').click(); await page.locator('#update-install').click();
  await page.waitForFunction(() => Boolean(window.updateFixture.releaseSession));
  assert.deepEqual(await calls(), ['session:start']);
  await page.locator('#update-install').dispatchEvent('click');
  await page.keyboard.press('Escape'); check(await isOpen('#update-dialog'), 'Restart preparation remains modal');
  await page.evaluate(() => window.updateFixture.releaseSession());
  await page.waitForFunction(() => Boolean(window.updateFixture.releasePreferences));
  assert.deepEqual(await calls(), ['session:start', 'session:end', 'preferences:start']);
  await page.evaluate(() => window.updateFixture.releasePreferences());
  await page.waitForFunction(() => window.updateFixture.calls.includes('install'));
  assert.deepEqual(await calls(), ['session:start', 'session:end', 'preferences:start', 'preferences:end', 'install']);
  assert.equal(await page.evaluate(() => window.updateFixture.savedSessions.at(-1).workspaces.design.layout), 2);
  assert.equal(await page.evaluate(() => window.updateFixture.savedPreferences.at(-1).showHidden), true);
  await page.locator('#update-install').dispatchEvent('click'); assert.equal(await count('install'), 1);
  check(await page.locator('#update-install').isDisabled());
  checks.push('Session/preferences save failures prevent restart; install failures allow retry; latest settings fully flush before exactly one explicit restart request');
  await page.screenshot({ path: path.join(root, 'ready.png') });
  await page.context().close();

  page = await fixture({ bootFails: true });
  await page.locator('#bootstrap-retry').waitFor();
  assert.equal(await page.locator('#storage-status').innerText(), '앱 시작 실패');
  await emit({ status: 'current' });
  assert.equal(await page.locator('#update-indicator').innerText(), '시작 실패');
  await page.evaluate(() => { window.updateFixture.bootFails = false; }); await page.locator('#bootstrap-retry').click();
  await page.waitForFunction(() => document.querySelectorAll('.file-panel[aria-busy="false"]').length === 8);
  check(!(await visible('#update-indicator')));
  await page.context().close();
  page = await fixture({ stateReadFails: true });
  assert.equal(await page.locator('#app-version').innerText(), 'v0.9.0');
  assert.equal(await isOpen('#update-dialog'), false);
  await page.context().close();
  page = await fixture({ status: 'unsupported' });
  await page.locator('#update-button').click(); assert.equal(await count('check'), 0);
  check(!(await visible('#update-check'))); check(!(await visible('#update-download')));
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 760 });
  check(await visible('#app-version'));
  const versionBox = await page.locator('#app-version').boundingBox();
  check(versionBox.x >= 0 && versionBox.x + versionBox.width <= 390);
  await page.screenshot({ path: path.join(root, 'narrow.png') });
  await page.context().close();
  page = await fixture({ noBridge: true });
  await page.locator('#update-button').click();
  check((await page.locator('#update-message').innerText()).includes('포터블'));
  check(!(await visible('#update-check'))); check(!(await visible('#update-install')));
  checks.push('Startup failure remains visible through update events and can retry; unsupported native/browser previews degrade gracefully; footer version remains visible at 390px');
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []);
  const report = { passed: true, checks, errors, unexpectedRequests, limits: 'Browser IPC fixture only; updater backend, real installer/download/relaunch and network are never invoked.' };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, ...report }, null, 2));
})().catch(async error => {
  fs.writeFileSync(path.join(root, 'failure.txt'), error.stack);
  await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
  console.error(error); console.log(`Evidence: ${root}`); process.exitCode = 1;
}).finally(async () => { await browser?.close(); });
