'use strict';
// Hidden Chromium, local renderer and deferred bridge only. No native helper,
// real clipboard/input, Explorer or filesystem operations. Optional --baseline
// runs the same probes against 91a2771 without checking out or modifying files.
// node scripts/verification/verify-transfer-races.cjs [Playwright root] [--baseline] [--case=substring]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { execFileSync } = require('node:child_process');
const dependencyRoot = process.argv.slice(2).find(arg => !arg.startsWith('--'));
const { chromium } = (dependencyRoot ? createRequire(path.join(path.resolve(dependencyRoot), 'package.json')) : require)('playwright');
const baseline = process.argv.includes('--baseline');
const caseFilter = process.argv.find(arg => arg.startsWith('--case='))?.slice(7);
const project = path.resolve(__dirname, '../..');
const source = baseline ? execFileSync('git', ['show', '91a2771:app.js'], { cwd: project, encoding: 'utf8', windowsHide: true }) : fs.readFileSync(path.join(project, 'app.js'), 'utf8');
// Identical, observational instrumentation for both sources; production is unchanged.
const profiledSource = source + `\nconst originalRenderFiles = renderFiles;
renderFiles = function(pane) {
  const start = performance.now();
  try { return originalRenderFiles(pane); }
  finally { window.fixture.renderMilliseconds += performance.now() - start; }
};\n`;
const checks = [], failures = [], errors = [], metrics = [];
let browser;
const ok = value => ({ ok: true, value });
const clip = (name = 'alpha.txt', operation = 'copy') => ({ sources: [`C:\\Fixture\\design-0\\${name}`], operation, sequence: 21 });
const calls = (page, type) => page.evaluate(type => window.fixture.calls.filter(call => call.type === type), type);
const settle = (page, type, value, index = 0) => page.evaluate(({ type, value, index }) => window.fixture.settle(type, value, index), { type, value, index });
const key = (page, value) => page.evaluate(value => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: value, ctrlKey: true, bubbles: true, cancelable: true })), value);
const tick = page => page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)));
const idle = page => page.waitForFunction(() => [...document.querySelectorAll('.file-panel:not([hidden])')].every(panel => panel.getAttribute('aria-busy') === 'false'));
async function fixture({ layout = 4, active = 0, entries = 2, holdLists = false, movedFolder = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (url.hostname !== 'transfer-races.test' || !['index.html', 'app.js', 'styles.css', 'theme.js'].includes(filename)) {
      errors.push(`Unexpected request: ${url.href}`); return route.abort();
    }
    return route.fulfill({ body: filename === 'app.js' ? profiledSource : fs.readFileSync(path.join(project, filename)), contentType: filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'text/javascript' });
  });
  await context.addInitScript(({ layout, active, entries, holdLists, movedFolder }) => {
    const ok = value => ({ ok: true, value });
    const panes = workspace => Array.from({ length: 4 }, (_, index) => ({ path: `C:\\Fixture\\${workspace}-${index}`, sort: 'name', direction: 1 }));
    const session = { version: 1, workspaceId: 'design', workspaces: { design: { layout, active, panes: panes('design') }, documents: { layout: 2, active: 0, panes: panes('documents') } } };
    if (movedFolder) session.workspaces.documents.panes[0].path = 'C:\\Fixture\\design-0\\alpha.txt\\nested';
    const f = window.fixture = { calls: [], pending: {}, holdLists, listDelay: 0, autoRead: false, clipboard: null, pathless: false, renderMilliseconds: 0 };
    const record = (type, value) => f.calls.push({ type, value, time: performance.now() });
    const defer = (type, value) => {
      record(type, value);
      return new Promise((resolve, reject) => (f.pending[type] ||= []).push({ resolve, reject, value }));
    };
    f.settle = (type, value, index = 0) => {
      const [request] = (f.pending[type] || []).splice(index, 1);
      if (!request) throw new Error(`No pending ${type}`);
      request.resolve(value);
    };
    f.reject = (type, code) => {
      const request = (f.pending[type] || []).shift();
      if (!request) throw new Error(`No pending ${type}`);
      request.reject(Object.assign(new Error(`Fixture ${code}`), { code }));
    };
    f.directory = location => ok({ path: location, name: location, parent: 'C:\\Fixture', breadcrumbs: [], entries: Array.from({ length: entries }, (_, index) => {
      const name = index === 0 ? 'alpha.txt' : index === 1 ? 'beta.txt' : `file-${index}.txt`;
      return { path: `${location}\\${name}`, name, type: movedFolder && index === 0 ? 'folder' : 'file', size: 12, modified: '2026-01-01T00:00:00Z' };
    }) });
    const update = { status: 'ready', currentVersion: '0.9.1', latestVersion: '0.9.2' };
    window.pane = {
      bootstrap: async () => ok({ session, update, favorites: [], drives: [], preferences: { favorites: [], recentPaths: [] } }),
      listDirectory: async location => {
        record('list', location);
        if (f.holdLists) return defer('listWait', location);
        if (f.listDelay) await new Promise(resolve => setTimeout(resolve, f.listDelay));
        return f.directory(location);
      },
      saveSession: async value => { record('save', value); return ok(null); },
      savePreferences: async value => ok(value),
      readShellClipboard: () => f.autoRead ? (record('read', null), Promise.resolve(ok(f.clipboard))) : defer('read'),
      writeShellClipboard: value => defer('write', value),
      completeShellPaste: value => { record('complete', value); return Promise.resolve(ok(null)); },
      transfer: value => defer('transfer', value),
      beginNativeDrag: value => defer('drag', value),
      cancelShell: () => defer('cancel'),
      shellMenu: value => defer('menu', value),
      droppedPaths: files => { record('paths', files.map(file => file.name)); return f.pathless ? [] : f.dropPaths || files.map(file => `C:\\External\\${file.name}`); },
      updateState: async () => ok(update),
      installUpdate: async () => { record('install'); return ok({ restarting: true }); },
    };
  }, { layout, active, entries, holdLists, movedFolder });
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://transfer-races.test/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('.file-panel', { state: 'attached' });
  if (!holdLists) await idle(page);
  return page;
}
async function scenario(name, run, options) {
  if (caseFilter && !name.includes(caseFilter)) return;
  const page = await fixture(options);
  try { await run(page); checks.push(name); }
  catch (error) { failures.push({ name, error: error.message }); }
  finally { await page.context().close(); }
}
async function select(page, index = 0) {
  await page.locator('#panel-design-0 tr[data-file]').nth(index).click();
}
async function destination(page) {
  await page.locator('#panel-design-1 .panel-tab-label').click();
}
async function finishTransfer(page) {
  const request = (await calls(page, 'transfer')).at(-1).value;
  await settle(page, 'transfer', ok({ operation: request.operation, completed: request.sources.map(source => ({ source, destination: `${request.destination}\\${source.split('\\').pop()}` })), skipped: [], failed: [] }));
  await page.waitForFunction(() => document.querySelector('#activity-strip').getAttribute('aria-busy') === 'false');
  await idle(page);
}
async function externalDrop(page, { protectedMode = false, urlOnly = false } = {}) {
  return page.evaluate(({ protectedMode, urlOnly }) => {
    const target = document.querySelector('#panel-design-1 .file-scroll');
    const data = new DataTransfer();
    // Synthetic Chromium DataTransfer ignores its native dropEffect setter.
    // Observe the renderer assignment independently of OS drag negotiation.
    Object.defineProperty(data, 'dropEffect', { value: 'none', writable: true });
    if (urlOnly) data.setData('text/uri-list', 'https://example.test/download.zip');
    else data.items.add(new File(['fixture'], 'external.txt'));
    if (protectedMode) Object.defineProperty(data, 'files', { value: [] });
    const event = new DragEvent(protectedMode || urlOnly ? 'dragover' : 'drop', { bubbles: true, cancelable: true, dataTransfer: data });
    target.dispatchEvent(event);
    // Accepted drops stop propagation at #panels; inspect the dispatched
    // DataTransfer directly instead of a document listener that never runs.
    return { prevented: event.defaultPrevented, effect: data.dropEffect, feedback: document.querySelector('#drag-feedback').textContent, types: [...data.types], busy: target.closest('.file-panel').getAttribute('aria-busy'), rows: target.querySelectorAll('[data-file]').length };
  }, { protectedMode, urlOnly });
}
async function startDrag(page) {
  await select(page);
  await page.locator('#panel-design-0 tr[data-file]').first().dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
  await tick(page);
}
const shellFailure = code => ({ ok: false, error: { code, message: `Fixture ${code}` } });
(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  await scenario('recovery gate rejects incoming drops until explicit recovery succeeds', async page => {
    await startDrag(page); await settle(page, 'drag', shellFailure('SHELL_DISCONNECTED')); await tick(page);
    const button = page.locator('#shell-recovery-button');
    assert.equal(await button.isEnabled(), true);
    assert.equal((await externalDrop(page, { protectedMode: true })).effect, 'none');
    await externalDrop(page); await tick(page);
    assert.equal((await calls(page, 'transfer')).length, 0);
    await button.click(); await externalDrop(page); await tick(page);
    assert.equal((await calls(page, 'transfer')).length, 0);
    await settle(page, 'cancel', ok(null)); await tick(page);
    assert.equal(await button.isHidden(), true);
    assert.equal((await calls(page, 'transfer')).length, 0, 'Recovery never replays a rejected drop');
    await externalDrop(page); await tick(page);
    assert.equal((await calls(page, 'transfer')).length, 1);
    await finishTransfer(page);
  });
  await scenario('recovery gate rejects drops while cancellation owns the native handoff', async page => {
    await startDrag(page); await page.locator('#shell-recovery-button').click();
    await externalDrop(page); await tick(page);
    assert.equal((await calls(page, 'transfer')).length, 0);
    await settle(page, 'cancel', ok(null)); await tick(page);
    assert.equal(await page.locator('#activity-strip').getAttribute('aria-busy'), 'true', 'Acknowledgement cannot release the original drag');
    await settle(page, 'drag', shellFailure('SHELL_CANCELLED')); await tick(page);
    assert.equal(await page.locator('#activity-strip').getAttribute('aria-busy'), 'false');
  });
  await scenario('recovery menu success clears only the error captured before the retry', async page => {
    await startDrag(page); await settle(page, 'drag', shellFailure('SHELL_DISCONNECTED')); await tick(page);
    await page.locator('#panel-design-1 .file-scroll').dispatchEvent('contextmenu');
    await settle(page, 'menu', ok({ action: 'cancel' })); await tick(page); await idle(page);
    assert.equal(await page.locator('#shell-recovery-button').isHidden(), true);
    assert.equal((await calls(page, 'cancel')).length, 0);
  });
  for (const mode of ['drag', 'menu']) for (const ackFirst of [true, false]) {
    await scenario(`recovery ${mode} acknowledgement ${ackFirst ? 'before' : 'after'} original error retires only its own recovery latch`, async page => {
      if (mode === 'drag') await startDrag(page);
      else await page.locator('#panel-design-1 .file-scroll').dispatchEvent('contextmenu');
      await page.locator('#shell-recovery-button').click();
      const originalError = async () => {
        await page.evaluate(mode => window.fixture.reject(mode, 'SHELL_DISCONNECTED'), mode); await tick(page);
      };
      if (!ackFirst) await originalError();
      await settle(page, 'cancel', ok(null)); await tick(page);
      if (ackFirst) {
        assert.equal(await page.locator('#activity-strip').getAttribute('aria-busy'), 'true', 'Helper exit acknowledgement cannot release original IPC ownership');
        await originalError();
      }
      assert.equal(await page.locator('#shell-recovery-button').isHidden(), true);
      assert.equal(await page.locator('#activity-strip').getAttribute('aria-busy'), 'false');
      assert.match(await page.locator('#toast').textContent(), /SHELL_DISCONNECTED/, 'Uncertain outcome is still reported');
      assert.equal((await calls(page, mode)).length, 1);
      assert.equal((await calls(page, 'cancel')).length, 1);
      assert.equal((await calls(page, 'transfer')).length, 0);
    });
  }
  await scenario('recovery acknowledged old drag cannot erase a later cancel failure or a new drag error', async page => {
    await startDrag(page); await page.locator('#shell-recovery-button').click();
    await settle(page, 'cancel', ok(null)); await tick(page);
    await page.locator('#shell-recovery-button').click();
    await settle(page, 'cancel', shellFailure('SHELL_RECOVERY_FAILED')); await tick(page);
    await settle(page, 'drag', shellFailure('SHELL_DISCONNECTED')); await tick(page);
    assert.equal(await page.locator('#shell-recovery-button').isEnabled(), true, 'Old recovered request must not clear failed cleanup');
    await page.locator('#shell-recovery-button').click(); await settle(page, 'cancel', ok(null)); await tick(page);
    assert.equal(await page.locator('#shell-recovery-button').isHidden(), true);
    await startDrag(page); await settle(page, 'drag', shellFailure('SHELL_DISCONNECTED')); await tick(page);
    assert.equal(await page.locator('#shell-recovery-button').isEnabled(), true, 'An acknowledgement never covers a new native request');
    assert.equal((await calls(page, 'drag')).length, 2);
    assert.equal((await calls(page, 'transfer')).length, 0);
  });
  await scenario('native handoff cannot turn unrelated external sources into a move', async page => {
    await startDrag(page);
    assert.equal((await externalDrop(page, { protectedMode: true })).effect, 'copy');
    assert.equal((await externalDrop(page)).effect, 'copy'); await tick(page);
    assert.equal((await calls(page, 'transfer'))[0].value.operation, 'copy');
    await settle(page, 'drag', ok({ action: 'cancel' })); await finishTransfer(page);
  });
  await scenario('native handoff matching sources still move and transfer failure does not cancel or replay', async page => {
    await startDrag(page);
    await page.evaluate(() => { window.fixture.dropPaths = ['C:\\Fixture\\design-0\\alpha.txt']; });
    await page.evaluate(() => document.dispatchEvent(new Event('dragend')));
    assert.equal((await externalDrop(page, { protectedMode: true })).effect, 'copy', 'Protected payload has no verified source paths');
    assert.equal((await externalDrop(page)).effect, 'copy', 'Same paths after stale dragend do not prove OLE source identity or authorize external deletion'); await tick(page);
    assert.equal((await calls(page, 'transfer'))[0].value.operation, 'move');
    await page.locator('#shell-recovery-button').dispatchEvent('click'); await key(page, 'Escape');
    assert.equal((await calls(page, 'cancel')).length, 0, 'Shell recovery cannot abort an in-flight transfer');
    await settle(page, 'drag', shellFailure('SHELL_DISCONNECTED')); await tick(page);
    assert.equal(await page.locator('#shell-recovery-button').isDisabled(), true);
    await page.evaluate(() => window.fixture.reject('transfer', 'TRANSFER_FAILED')); await tick(page);
    assert.equal(await page.locator('#shell-recovery-button').isEnabled(), true);
    await page.locator('#shell-recovery-button').click();
    await page.evaluate(() => window.fixture.reject('cancel', 'SHELL_RECOVERY_FAILED')); await tick(page);
    assert.equal(await page.locator('#shell-recovery-button').isEnabled(), true);
    await page.locator('#shell-recovery-button').click(); await settle(page, 'cancel', ok(null)); await tick(page);
    assert.equal(await page.locator('#shell-recovery-button').isHidden(), true);
    assert.equal((await calls(page, 'transfer')).length, 1);
    assert.equal((await calls(page, 'drag')).length, 1);
  });
  await scenario('recovery successful menu retry cannot erase a later cancellation failure', async page => {
    await startDrag(page); await settle(page, 'drag', shellFailure('SHELL_DISCONNECTED')); await tick(page);
    await page.locator('#panel-design-1 .file-scroll').dispatchEvent('contextmenu');
    await page.locator('#shell-recovery-button').click();
    await settle(page, 'cancel', shellFailure('SHELL_RECOVERY_FAILED')); await tick(page);
    await settle(page, 'menu', ok({ action: 'cancel' })); await tick(page); await idle(page);
    assert.equal(await page.locator('#shell-recovery-button').isEnabled(), true);
    await page.locator('#shell-recovery-button').click(); await settle(page, 'cancel', ok(null)); await tick(page);
    assert.equal(await page.locator('#shell-recovery-button').isHidden(), true);
    assert.equal((await calls(page, 'menu')).length, 1);
  });
  await scenario('incoming external drop never starts outbound drag on focus or stale dragend', async page => {
    await externalDrop(page); await tick(page);
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('dragend')); });
    await finishTransfer(page);
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('dragend')); });
    await tick(page);
    assert.equal((await calls(page, 'drag')).length, 0);
    assert.equal((await calls(page, 'cancel')).length, 0);
    assert.equal((await calls(page, 'transfer')).length, 1);
  });
  await scenario('settled transfer releases mutation reservation while directory refresh is deferred', async page => {
    await externalDrop(page); await tick(page);
    await page.evaluate(() => { window.fixture.holdLists = true; });
    await settle(page, 'transfer', ok({ operation: 'copy', completed: [{ source: 'C:\\External\\external.txt', destination: 'C:\\Fixture\\design-1\\external.txt' }], skipped: [], failed: [] })); await tick(page);
    assert.equal(await page.locator('#operation-results-button').isVisible(), true);
    assert.equal(await page.locator('#activity-strip').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#panel-design-1').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#update-install').isDisabled(), true, 'Pending directory read still blocks install');
    await externalDrop(page); await tick(page);
    assert.equal((await calls(page, 'transfer')).length, 2);
    await page.evaluate(() => {
      const f = window.fixture; f.holdLists = false;
      while (f.pending.listWait?.length) f.settle('listWait', f.directory(f.pending.listWait[0].value));
    });
    await idle(page); await tick(page);
    assert.equal(await page.locator('#activity-strip').getAttribute('aria-busy'), 'true', 'Old refresh cannot release the next transfer');
    await finishTransfer(page);
  });
  for (const layout of [1, 2, 4]) await scenario(`startup loads only ${layout} visible panes`, async page => {
    const lists = await calls(page, 'list');
    metrics.push({ layout, directoryRequests: lists.length, hiddenRows: await page.locator('.file-panel[hidden] tr[data-file]').count(), renderMilliseconds: await page.evaluate(() => window.fixture.renderMilliseconds) });
    assert.equal(lists.length, layout);
    assert.equal(await page.locator('.file-panel[hidden] tr[data-file]').count(), 0);
    if (layout === 1) assert.match(lists[0].value, /design-3$/);
  }, { layout, active: layout === 1 ? 3 : 0, entries: 300 });
  await scenario('repeat paste while clipboard read is pending dispatches once', async page => {
    await destination(page); await key(page, 'v'); await key(page, 'v');
    await settle(page, 'read', ok(clip()));
    await page.waitForFunction(() => window.fixture.calls.some(call => call.type === 'transfer'));
    await finishTransfer(page);
    if ((await page.evaluate(() => window.fixture.pending.read?.length || 0))) await settle(page, 'read', ok(clip()));
    await tick(page);
    assert.equal((await calls(page, 'transfer')).length, 1);
  });
  await scenario('paste waits for an in-flight clipboard write', async page => {
    await select(page); await key(page, 'c'); await destination(page); await key(page, 'v');
    const readsBeforeWrite = (await calls(page, 'read')).length;
    await settle(page, 'write', ok(null)); await tick(page);
    await settle(page, 'read', ok(clip())); await tick(page);
    assert.equal(readsBeforeWrite, 0);
    assert.equal((await calls(page, 'transfer')).length, 1);
    await finishTransfer(page);
  });
  await scenario('late focus clipboard read cannot erase a newer copy', async page => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await idle(page);
    await select(page); await key(page, 'c'); await settle(page, 'write', ok(null));
    await settle(page, 'read', ok(null)); await tick(page);
    assert.equal(await page.locator('#paste-button').isEnabled(), true);
  });
  await scenario('overlapping copy writes are serialized; old failure preserves latest intent', async page => {
    await select(page); await key(page, 'c'); await select(page, 1); await key(page, 'c');
    const simultaneousWrites = (await calls(page, 'write')).length;
    await settle(page, 'write', { ok: false, error: { message: 'Old write failed' } }); await tick(page);
    await settle(page, 'write', ok(null)); await tick(page);
    assert.equal(simultaneousWrites, 1);
    assert.equal(await page.locator('#paste-button').isEnabled(), true);
    assert.equal((await calls(page, 'write'))[1].value.sources[0], clip('beta.txt').sources[0]);
  });
  await scenario('paste retains destination captured before delayed read', async page => {
    await destination(page); await key(page, 'v');
    const address = page.locator('#panel-design-1 .path-input');
    await address.fill('C:\\New destination'); await address.press('Enter'); await idle(page);
    await settle(page, 'read', ok(clip())); await tick(page);
    assert.equal((await calls(page, 'transfer'))[0].value.destination, 'C:\\Fixture\\design-1');
    await finishTransfer(page);
  });
  await scenario('protected file dragover accepts Files with an empty files list', async page => {
    const over = await externalDrop(page, { protectedMode: true });
    assert.equal(over.prevented, true); assert.equal(over.effect, 'copy', JSON.stringify(over));
    assert.equal((await calls(page, 'paths')).length, 0);
    await externalDrop(page); await externalDrop(page); await tick(page);
    assert.equal((await calls(page, 'transfer')).length, 1);
    assert.equal((await calls(page, 'transfer'))[0].value.operation, 'copy');
    await finishTransfer(page);
    assert.equal(await page.locator('#operation-results-button').isVisible(), true);
  });
  await scenario('URL-only browser download is unsupported and never converted to a path', async page => {
    const over = await externalDrop(page, { urlOnly: true });
    assert.equal(over.prevented, false); assert.equal((await calls(page, 'paths')).length, 0);
    assert.equal((await calls(page, 'transfer')).length, 0);
  });
  await scenario('pathless File drop reports why nothing was dispatched', async page => {
    await page.evaluate(() => { window.fixture.pathless = true; });
    await externalDrop(page);
    assert.equal((await calls(page, 'transfer')).length, 0);
    assert.match(await page.locator('#toast').textContent(), /경로/);
  });
  await scenario('incoming drop survives focus refresh; navigation to another path still blocks it', async page => {
    await page.evaluate(() => { window.fixture.holdLists = true; window.dispatchEvent(new Event('focus')); });
    const over = await externalDrop(page, { protectedMode: true });
    assert.equal(over.effect, 'copy');
    await externalDrop(page); await tick(page);
    assert.equal((await calls(page, 'transfer')).length, 1);
    // Resolve navigation before transfer to finish any queued refresh deterministically.
    await page.evaluate(() => {
      const f = window.fixture; f.holdLists = false;
      while (f.pending.listWait?.length) f.settle('listWait', f.directory(f.pending.listWait[0].value));
    });
    await idle(page); await finishTransfer(page);
    await page.evaluate(() => { window.fixture.holdLists = true; });
    await page.locator('#panel-design-1 .path-input').fill('C:\\Another folder');
    await page.locator('#panel-design-1 .path-input').press('Enter');
    assert.equal((await externalDrop(page, { protectedMode: true })).effect, 'none');
    await externalDrop(page);
    assert.equal((await calls(page, 'transfer')).length, 1);
  });
  await scenario('layout expansion and workspace switching load only newly visible panes once', async page => {
    assert.equal((await calls(page, 'list')).length, 1);
    await page.locator('[data-layout="2"]').click(); await idle(page);
    assert.equal((await calls(page, 'list')).length, 2);
    await page.locator('[data-layout="4"]').click(); await idle(page);
    assert.equal((await calls(page, 'list')).length, 4);
    await page.locator('[data-workspace="documents"]').click(); await idle(page);
    assert.equal((await calls(page, 'list')).length, 6);
    await page.locator('[data-workspace="design"]').click(); await idle(page);
    assert.equal((await calls(page, 'list')).length, 6);
    assert.equal(await page.locator('#panel-design-0 tr[data-file]').count(), 2);
  }, { layout: 1 });
  await scenario('focus invalidates hidden panes without listing until shown and preserves address draft', async page => {
    await page.locator('[data-workspace="documents"]').click(); await idle(page);
    await page.locator('[data-workspace="design"]').click(); await idle(page);
    const before = (await calls(page, 'list')).length;
    await page.locator('#panel-design-0 .path-input').fill('Uncommitted draft');
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await idle(page);
    assert.equal((await calls(page, 'list')).length - before, 4);
    assert.equal(await page.locator('#panel-design-0 .path-input').inputValue(), 'Uncommitted draft');
    await page.locator('[data-workspace="documents"]').click(); await idle(page);
    assert.equal((await calls(page, 'list')).length - before, 6);
  });
  await scenario('actual pending reads block update even after hidden; dormant panes do not', async page => {
    await page.locator('#update-button').click();
    assert.equal(await page.locator('#update-install').isDisabled(), true);
    await page.locator('#update-close').click();
    await page.locator('[data-workspace="documents"]').click();
    assert.equal((await calls(page, 'list')).length, 6);
    await page.evaluate(() => {
      const f = window.fixture;
      for (let index = f.pending.listWait.length - 1; index >= 0; index--) {
        const request = f.pending.listWait[index];
        if (request.value.includes('documents')) f.settle('listWait', f.directory(request.value), index);
      }
    });
    await idle(page);
    assert.equal(await page.locator('#update-install').isDisabled(), true);
    await page.evaluate(() => {
      const f = window.fixture;
      while (f.pending.listWait.length) f.settle('listWait', f.directory(f.pending.listWait[0].value));
    });
    await tick(page);
    assert.equal(await page.locator('#update-install').isEnabled(), true);
    assert.equal((await calls(page, 'install')).length, 0);
  }, { holdLists: true });
  await scenario('pending copy and clipboard read reserve updater through transfer completion', async page => {
    await select(page); await key(page, 'c');
    assert.equal(await page.locator('#update-install').isDisabled(), true);
    await destination(page); await key(page, 'v');
    await settle(page, 'write', ok(null)); await tick(page);
    assert.equal(await page.locator('#update-install').isDisabled(), true);
    await settle(page, 'read', ok(clip())); await tick(page);
    assert.equal(await page.locator('#update-install').isDisabled(), true);
    await finishTransfer(page);
    assert.equal(await page.locator('#update-install').isEnabled(), true);
  });
  await scenario('failed clipboard read releases reservation and a retry transfers once', async page => {
    await destination(page); await key(page, 'v');
    await settle(page, 'read', { ok: false, error: { message: 'Clipboard busy' } }); await tick(page);
    assert.equal((await calls(page, 'transfer')).length, 0);
    assert.match(await page.locator('#transfer-result').textContent(), /Clipboard busy/);
    await key(page, 'v'); await settle(page, 'read', ok(clip())); await tick(page);
    assert.equal((await calls(page, 'transfer')).length, 1); await finishTransfer(page);
  });
  await scenario('late focus read cannot resurrect cut files after successful move', async page => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await idle(page);
    await destination(page); await key(page, 'v');
    await settle(page, 'read', ok(clip('alpha.txt', 'move')), 1); await tick(page);
    await finishTransfer(page);
    await settle(page, 'read', ok(clip('alpha.txt', 'move'))); await tick(page);
    assert.equal(await page.locator('#paste-button').isDisabled(), true);
    assert.equal((await calls(page, 'complete')).length, 1);
    assert.deepEqual((await calls(page, 'complete'))[0].value, { sequence: 21, completed: clip().sources });
  });
  await scenario('a failed pending copy cannot paste an older OS clipboard', async page => {
    await select(page); await key(page, 'c'); await destination(page); await key(page, 'v');
    await settle(page, 'write', { ok: false, error: { message: 'Write busy' } }); await tick(page);
    assert.equal((await calls(page, 'read')).length, 0);
    assert.equal((await calls(page, 'transfer')).length, 0);
    assert.equal(await page.locator('#activity-strip').getAttribute('aria-busy'), 'false');
    assert.match(await page.locator('#toast').textContent(), /Write busy/);
  });
  await scenario('paste during a same-directory focus refresh dispatches once', async page => {
    await destination(page);
    await page.evaluate(() => { window.fixture.holdLists = true; window.dispatchEvent(new Event('focus')); });
    await key(page, 'v');
    await settle(page, 'read', ok(clip()), 1); await tick(page);
    assert.equal((await calls(page, 'transfer')).length, 1);
    await page.evaluate(() => {
      const f = window.fixture; f.holdLists = false;
      while (f.pending.listWait?.length) f.settle('listWait', f.directory(f.pending.listWait[0].value));
    });
    await idle(page); await finishTransfer(page);
  });
  await scenario('move relocates an unopened hidden descendant without loading it; switch reads the new path', async page => {
    await destination(page); await key(page, 'v');
    await settle(page, 'read', ok(clip('alpha.txt', 'move'))); await tick(page);
    await finishTransfer(page);
    assert.equal((await calls(page, 'list')).some(call => call.value.endsWith('nested')), false);
    const saved = (await calls(page, 'save')).at(-1).value;
    assert.equal(saved.workspaces.documents.panes[0].path, 'C:\\Fixture\\design-1\\alpha.txt\\nested');
    await page.locator('[data-workspace="documents"]').click(); await idle(page);
    assert.equal(await page.locator('#panel-documents-0 .path-input').inputValue(), saved.workspaces.documents.panes[0].path);
    assert.equal((await calls(page, 'list')).filter(call => call.value === saved.workspaces.documents.panes[0].path).length, 1);
  }, { movedFolder: true });
  await scenario('loaded hidden relocation clears obsolete rows and blocks drops until refreshed', async page => {
    await page.locator('[data-workspace="documents"]').click(); await idle(page);
    assert.equal(await page.locator('#panel-documents-0 tr[data-file]').count(), 2);
    await page.locator('[data-workspace="design"]').click(); await idle(page);
    await destination(page); await key(page, 'v');
    await settle(page, 'read', ok(clip('alpha.txt', 'move'))); await tick(page);
    await finishTransfer(page);
    await page.evaluate(() => { window.fixture.holdLists = true; });
    await page.locator('[data-workspace="documents"]').click();
    assert.equal(await page.locator('#panel-documents-0 tr[data-file]').count(), 0);
    const drop = () => page.evaluate(() => {
      const target = document.querySelector('#panel-documents-0 tr[data-file]') || document.querySelector('#panel-documents-0 .file-scroll');
      const data = new DataTransfer(); data.items.add(new File(['fixture'], 'external.txt'));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    await drop(); await tick(page);
    assert.equal((await calls(page, 'transfer')).length, 1, 'relocated listing is not a valid destination until read');
    await page.evaluate(() => {
      const f = window.fixture; f.holdLists = false;
      while (f.pending.listWait?.length) f.settle('listWait', f.directory(f.pending.listWait[0].value));
    });
    await idle(page); await drop(); await tick(page);
    assert.equal((await calls(page, 'transfer')).at(-1).value.destination, 'C:\\Fixture\\design-1\\alpha.txt\\nested\\alpha.txt');
    await finishTransfer(page);
  }, { movedFolder: true });
  await scenario('copy and cut use committed selection during focus refresh but block changed destinations', async page => {
    await select(page); await key(page, 'c'); await settle(page, 'write', ok(null)); await tick(page);
    await select(page, 1);
    await page.evaluate(() => { window.fixture.holdLists = true; window.dispatchEvent(new Event('focus')); });
    assert.equal(await page.locator('#copy-button').isEnabled(), true);
    await key(page, 'c'); await tick(page);
    assert.equal((await calls(page, 'write')).length, 2);
    assert.deepEqual((await calls(page, 'write'))[1].value.sources, clip('beta.txt').sources);
    await settle(page, 'write', ok(null)); await tick(page);
    await page.locator('#cut-button').click(); await tick(page);
    assert.equal((await calls(page, 'write')).at(-1).value.operation, 'move');
    await settle(page, 'write', ok(null)); await tick(page);
    await page.locator('#panel-design-0 .path-input').fill('C:\\Another folder');
    await page.locator('#panel-design-0 .path-input').press('Enter');
    await page.locator('#panel-design-0').focus(); await key(page, 'c'); await tick(page);
    assert.equal((await calls(page, 'write')).length, 3);
    assert.equal(await page.locator('#copy-button').isDisabled(), true);
  });
  await scenario('outgoing native drag can start during same-directory focus refresh', async page => {
    await select(page);
    await page.evaluate(() => { window.fixture.holdLists = true; window.dispatchEvent(new Event('focus')); });
    await page.locator('#panel-design-0 tr[data-file]').first().dispatchEvent('dragstart', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
    await tick(page);
    assert.deepEqual((await calls(page, 'drag'))[0].value, clip().sources);
    await settle(page, 'drag', { ok: true, value: { action: 'cancel' } });
  });
  assert.deepEqual(errors, [], 'No uncaught renderer errors or network requests');
  console.log(JSON.stringify({ baseline, checks, failures, metrics }, null, 2));
  if (failures.length && !baseline) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
