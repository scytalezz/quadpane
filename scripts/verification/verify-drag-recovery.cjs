'use strict';
// node scripts/verification/verify-drag-recovery.cjs [Playwright dependency root]
// Headless browser + local renderer + deferred bridge fixture. No main process,
// native helper, clipboard, disk file operations, pins or global mouse input.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
const { chromium } = dependencies('playwright');
const project = path.resolve(__dirname, '../..');
const checks = [], failures = [], errors = [], unexpectedRequests = [];
let browser;
const ok = value => ({ ok: true, value });
const failure = code => ({ ok: false, error: { code, message: `Fixture ${code}` } });

async function fixture(native = true) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (url.hostname !== 'drag-recovery.test' || !['index.html', 'app.js', 'styles.css', 'theme.js'].includes(filename)) {
      unexpectedRequests.push(url.href); return route.abort();
    }
    return route.fulfill({ body: fs.readFileSync(path.join(project, filename)), contentType: filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'text/javascript' });
  });
  await context.addInitScript(native => {
    const ok = value => ({ ok: true, value });
    const folder = index => `C:\\Drag fixture\\${index}`;
    const panes = () => Array.from({ length: 4 }, (_, index) => ({ path: folder(index), sort: 'name', direction: 1 }));
    const session = { version: 1, workspaceId: 'design', workspaces: {
      design: { layout: 4, active: 0, panes: panes() }, documents: { layout: 2, active: 0, panes: panes() },
    } };
    const f = window.dragFixture = { calls: [], pending: {}, holdLists: false, data: {} };
    const defer = (type, value) => {
      f.calls.push({ type, value });
      return new Promise((resolve, reject) => (f.pending[type] ||= []).push({ resolve, reject }));
    };
    f.settle = (type, result, rejected) => {
      const request = f.pending[type]?.shift();
      if (!request) throw new Error(`No pending ${type}`);
      if (rejected) request.reject(Object.assign(new Error(result.error.message), { code: result.error.code }));
      else request.resolve(result);
    };
    const update = { currentVersion: '0.9.0', status: 'ready', latestVersion: '0.9.1', message: '' };
    window.pane = {
      bootstrap: async () => ok({ session, update, favorites: [], drives: [], preferences: { favorites: [], recentPaths: [] } }),
      listDirectory: async location => {
        f.calls.push({ type: 'list', value: location });
        if (f.holdLists) await defer('listWait', location);
        return ok({ path: location, name: location, parent: 'C:\\', breadcrumbs: [], entries: ['alpha.txt', 'beta.txt'].map(name => ({
          path: `${location}\\${name}`, name, type: 'file', size: 12, modified: '2026-01-01T00:00:00Z',
        })) });
      },
      saveSession: async () => ok(null),
      savePreferences: async value => ok(value),
      readShellClipboard: async () => { f.calls.push({ type: 'clipboard' }); return ok({ sources: [], operation: 'copy' }); },
      updateState: async () => ok(update),
      installUpdate: async () => { f.calls.push({ type: 'install' }); return ok({ restarting: true }); },
      transfer: request => defer('transfer', request),
      shellMenu: request => defer('menu', request),
      cancelShell: () => defer('cancel'),
      droppedPaths: files => files.map(file => `${folder(0)}\\${file.name}`),
      ...(native ? { beginNativeDrag: sources => defer('drag', sources) } : {}),
    };
  }, native);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('https://drag-recovery.test/');
  await idle(page);
  return page;
}
async function idle(page) {
  await page.waitForFunction(() => document.querySelectorAll('.file-panel[aria-busy="false"]').length === 8);
}
const count = (page, type) => page.evaluate(type => window.dragFixture.calls.filter(call => call.type === type).length, type);
async function start(page, index = 0, key = 'latest') {
  await page.locator(`#panel-design-${index} tr[data-file]`).first().evaluate((row, key) => {
    const dataTransfer = window.dragFixture.data[key] = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
  }, key);
}
async function settle(page, type, result = ok(null), rejected = false) {
  await page.evaluate(({ type, result, rejected }) => window.dragFixture.settle(type, result, rejected), { type, result, rejected });
  await idle(page);
}
async function escape(page) {
  await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
}
async function dragend(page, key = 'latest') {
  await page.evaluate(key => document.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: window.dragFixture.data[key] })), key);
}
async function drop(page, native = true) {
  return page.evaluate(native => {
    const dataTransfer = native ? new DataTransfer() : window.dragFixture.data.latest;
    if (native) dataTransfer.items.add(new File(['fixture'], 'alpha.txt'));
    const target = document.querySelector('#panel-design-1 .file-scroll');
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
    const feedback = document.querySelector('#drag-feedback').textContent;
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    return feedback;
  }, native);
}
async function scenario(name, run, native = true) {
  const page = await fixture(native);
  try { await run(page); checks.push(name); }
  catch (error) { failures.push({ name, message: error.message }); }
  finally { await page.context().close(); }
}

(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  await scenario('Helper exit/busy/cancel/error/rejection release the reservation and permit one manual retry', async page => {
    let attempts = 0;
    for (const code of ['SHELL_HELPER_EXITED', 'SHELL_BUSY', 'SHELL_TIMEOUT', 'SHELL_NATIVE_ERROR', 'SHELL_RECOVERY_FAILED', 'SHELL_CANCELLED']) {
      for (const rejected of [false, true]) {
        await start(page); assert.equal(await count(page, 'drag'), ++attempts);
        await start(page); await dragend(page);
        assert.equal(await count(page, 'drag'), attempts, 'Pending native drag must suppress duplicate gestures');
        await settle(page, 'drag', failure(code), rejected);
        if (code !== 'SHELL_CANCELLED') assert.match(await page.locator('#toast').textContent(), new RegExp(code));
        assert.equal(await count(page, 'cancel'), 0, 'Helper errors must not cancel or replay uncertain work');
        assert.equal(await count(page, 'transfer'), 0);
        assert.equal(await count(page, 'drag'), attempts);
      }
    }
    await start(page); assert.equal(await count(page, 'drag'), ++attempts);
    await settle(page, 'drag', ok({ action: 'drop', sourceRetained: true }));
    assert.match(await page.locator('#toast').textContent(), /원본을 보존/);
  });
  await scenario('Both cancellation orderings and failed cancellation preserve ownership; late dragend cannot cancel the next drag', async page => {
    await start(page, 0, 'old');
    await page.locator('#panel-design-0 .path-input').focus();
    await escape(page); await escape(page);
    assert.equal(await count(page, 'cancel'), 1);
    await settle(page, 'cancel'); await start(page);
    assert.equal(await count(page, 'drag'), 1, 'Early cancel acknowledgement cannot release the drag');
    await settle(page, 'drag', failure('SHELL_CANCELLED'));
    await start(page); await dragend(page, 'old'); await start(page);
    assert.equal(await count(page, 'drag'), 2, 'Stale dragend must preserve the new native reservation');
    for (const rejected of [false, true]) {
      await escape(page); await settle(page, 'cancel', failure('SHELL_NATIVE_ERROR'), rejected);
      await start(page); assert.equal(await count(page, 'drag'), 2);
    }
    await escape(page); await settle(page, 'drag', failure('SHELL_CANCELLED'));
    await start(page); assert.equal(await count(page, 'drag'), 2, 'Late cancel must finish before the next gesture');
    await settle(page, 'cancel'); await start(page);
    assert.equal(await count(page, 'drag'), 3);
    await settle(page, 'drag', ok({ action: 'drop' }));
    assert.equal(await count(page, 'cancel'), 4);
  });
  await scenario('Unacknowledged cleanup holds the UI reservation; failed exit confirmation is surfaced without automatic retry', async page => {
    await start(page);
    await escape(page);
    await settle(page, 'drag', failure('SHELL_CANCELLED'));
    const lists = await count(page, 'list'), clipboard = await count(page, 'clipboard');
    await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
    await dragend(page); await escape(page); await start(page);
    assert.equal(await count(page, 'cancel'), 1, 'No overlapping cancel while cleanup has not acknowledged exit');
    assert.equal(await count(page, 'drag'), 1, 'Original drag settling cannot clear the outstanding cleanup reservation');
    assert.equal(await count(page, 'list'), lists);
    assert.equal(await count(page, 'clipboard'), clipboard);
    await settle(page, 'cancel', failure('SHELL_RECOVERY_FAILED'));
    assert.match(await page.locator('#toast').textContent(), /SHELL_RECOVERY_FAILED/);
    assert.equal(await count(page, 'drag'), 1, 'Failed cleanup must not automatically create another native drag');
    assert.equal(await count(page, 'transfer'), 0);
    await start(page); assert.equal(await count(page, 'drag'), 2);
    await settle(page, 'drag', failure('SHELL_RECOVERY_FAILED'));
    assert.match(await page.locator('#toast').textContent(), /SHELL_RECOVERY_FAILED/);
  });
  await scenario('External Explorer/browser handoff tolerates focus and stale dragend; success refreshes once without cancel or file replay', async page => {
    for (const action of ['drop', 'cancel']) {
      const drags = await count(page, 'drag');
      await start(page);
      const lists = await count(page, 'list'), clipboard = await count(page, 'clipboard');
      await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); });
      await dragend(page); await start(page);
      assert.equal(await count(page, 'drag'), drags + 1);
      assert.equal(await count(page, 'list'), lists, 'Do not reload the source while the external native drag is live');
      assert.equal(await count(page, 'clipboard'), clipboard);
      await settle(page, 'drag', ok({ action }));
      assert.equal(await count(page, 'list'), lists + 4, 'One terminal response refreshes the four visible panes');
      assert.equal(await count(page, 'cancel'), 0, 'Focus/dragend/success must not call cancelShell');
      assert.equal(await count(page, 'transfer'), 0, 'The external native result must never replay a file operation');
      assert.equal(await count(page, 'drag'), drags + 1);
    }
  });
  await scenario('In-app drop completes once while native IPC is pending; dragend and duplicate gestures do not cancel it', async page => {
    await start(page);
    assert.match(await drop(page), /이동/);
    assert.equal(await count(page, 'transfer'), 1);
    await dragend(page); await start(page);
    assert.equal(await count(page, 'drag'), 1);
    await settle(page, 'transfer', ok({ operation: 'move', completed: [], failed: [], skipped: [] }));
    await start(page); assert.equal(await count(page, 'drag'), 1);
    await settle(page, 'drag', ok({ action: 'drop' }));
    await start(page); assert.equal(await count(page, 'drag'), 2);
    await settle(page, 'drag', ok({ action: 'cancel' }));
    assert.equal(await count(page, 'cancel'), 0);
    assert.equal(await count(page, 'transfer'), 1);
  });
  await scenario('Focus return during native drag preserves live drop targets and avoids shell clipboard contention', async page => {
    await start(page);
    const lists = await count(page, 'list'), clipboard = await count(page, 'clipboard');
    await page.evaluate(() => {
      window.dragFixture.holdLists = true;
      window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus'));
    });
    const feedback = await drop(page);
    assert.match(feedback, /이동/, 'Focus refresh must not turn the live in-app drop target into a busy pane');
    assert.equal(await count(page, 'list'), lists);
    assert.equal(await count(page, 'clipboard'), clipboard);
    assert.equal(await count(page, 'transfer'), 1);
    await page.evaluate(() => { window.dragFixture.holdLists = false; });
    await settle(page, 'transfer', ok({ operation: 'move', completed: [], failed: [], skipped: [] }));
    await settle(page, 'drag', ok({ action: 'drop' }));
    assert.equal(await count(page, 'cancel'), 0);
    assert.ok(await count(page, 'list') > lists, 'Completion still refreshes directories');
  });
  await scenario('A modal blocks drag handoff; after closing it a new native drag succeeds', async page => {
    await page.locator('#update-button').evaluate(button => button.click());
    assert.equal(await page.locator('#update-dialog').evaluate(dialog => dialog.open), true);
    await start(page);
    assert.equal(await count(page, 'drag'), 0, 'A queued dragstart behind a modal must not start native shell work');
    await page.locator('#update-close').evaluate(button => button.click());
    await start(page); assert.equal(await count(page, 'drag'), 1);
    await settle(page, 'drag', ok({ action: 'drop' }));
    assert.equal(await count(page, 'cancel'), 0);
  });
  await scenario('Cancelled HTML drag releases updater gating without requiring a selection change', async page => {
    await start(page);
    await page.locator('#update-button').evaluate(button => button.click());
    assert.equal(await page.locator('#update-install').isDisabled(), true);
    await page.locator('#update-close').evaluate(button => button.click());
    await dragend(page);
    assert.equal(await page.locator('#update-install').isEnabled(), true, 'Clearing HTML drag state must repaint the updater gate');
    assert.equal(await count(page, 'install'), 0);
  }, false);
  await scenario('A new HTML drag removes stale source styling and feedback from the previous gesture', async page => {
    await start(page, 0, 'old');
    await page.evaluate(() => document.querySelector('#panel-design-1 .file-scroll').dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: window.dragFixture.data.old,
    })));
    await start(page, 1);
    assert.equal(await page.locator('#panel-design-0 .drag-source').count(), 0, 'Previous source must not remain marked after a new gesture');
    assert.equal(await page.locator('.drop-target').count(), 0);
    assert.equal(await page.locator('#drag-feedback').evaluate(element => element.matches(':popover-open')), false);
    await dragend(page);
  }, false);
  console.log(JSON.stringify({ passed: failures.length === 0 && errors.length === 0 && unexpectedRequests.length === 0, checks, failures, errors, unexpectedRequests,
    limits: 'Headless renderer with deferred bridge responses only; native lifecycle/exit cleanup and physical Windows OLE are verified separately.' }, null, 2));
  assert.deepEqual(errors, [], 'No renderer exceptions');
  assert.deepEqual(unexpectedRequests, [], 'No network requests outside locally fulfilled assets');
  if (failures.length) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
