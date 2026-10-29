'use strict';
// Compare packaged apps against identical local fixtures. These timings exclude
// portable extraction and real taskbar repair; windows and profiles are isolated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
const { _electron } = dependencies('playwright');
const project = path.resolve(__dirname, '../..');
const executables = process.argv.slice(3).map(filename => path.resolve(filename));
assert.ok(executables.length, 'Pass one or more unpacked EXE paths after the Playwright dependencies path');
const root = path.join(project, '.checks', 'navigation-timing', `run-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });
const folders = [10, 1000].map(count => {
  const folder = path.join(root, `files-${count}`);
  fs.mkdirSync(folder);
  for (let index = 0; index < count; index++) fs.writeFileSync(path.join(folder, `file-${index}.txt`), 'fixture');
  return folder;
});
const results = [];
let app;
(async () => {
  for (const [index, executable] of executables.entries()) {
    const profile = path.join(root, `app-${index}`);
    const settings = path.join(profile, 'quadpane-data');
    fs.mkdirSync(settings, { recursive: true });
    const panes = [0, 1, 2, 3].map(() => ({ path: folders[0], sort: 'name', direction: 1 }));
    fs.writeFileSync(path.join(settings, 'session.json'), JSON.stringify({ version: 1, workspaceId: 'design', workspaces: { design: { layout: 4, active: 0, panes }, documents: { layout: 2, active: 0, panes } } }));
    const env = { ...process.env, PORTABLE_EXECUTABLE_DIR: profile };
    for (const key of ['ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_APP_FILENAME']) delete env[key];
    const launch = performance.now();
    app = await _electron.launch({ executablePath: executable, args: ['--pane-smoke-test'], env, timeout: 30000 });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
    await page.waitForFunction(() => document.querySelectorAll('.file-panel').length === 8 && [...document.querySelectorAll('.file-panel')].filter(panel => !panel.hidden).every(panel => panel.getAttribute('aria-busy') === 'false' && panel.querySelectorAll('[data-file]').length === 10));
    const result = { executable, readyMs: performance.now() - launch, samples: [] };
    for (const target of [folders[1], folders[0], folders[1], folders[0]]) {
      const sample = await page.evaluate(async target => {
        const panel = document.querySelector('#panel-design-0');
        const input = panel.querySelector('.path-input');
        input.value = target;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        let tableReplacements = 0;
        const tableObserver = new MutationObserver(records => { tableReplacements += records.filter(record => record.type === 'childList').length; });
        tableObserver.observe(panel.querySelector('.file-scroll'), { childList: true });
        const start = performance.now();
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { observer.disconnect(); reject(new Error('Navigation timeout')); }, 30000);
          const observer = new MutationObserver(() => {
            if (panel.getAttribute('aria-busy') === 'false') { clearTimeout(timeout); observer.disconnect(); resolve(); }
          });
          observer.observe(panel, { attributes: true, attributeFilter: ['aria-busy'] });
          input.form.requestSubmit();
        });
        const navigationMs = performance.now() - start;
        tableObserver.disconnect();
        // Measure navigation before the separate backend call, so pre-reading
        // the target cannot warm an implementation's completed-result cache.
        const backendStart = performance.now();
        const response = await window.pane.listDirectory(target);
        if (!response.ok) throw new Error(JSON.stringify(response.error));
        const backendMs = performance.now() - backendStart;
        return { count: response.value.entries.length, backendMs, navigationMs, tableReplacements, rendered: panel.querySelectorAll('[data-file]').length,
          error: panel.querySelector('.panel-error')?.textContent, openDialogs: document.querySelectorAll('dialog[open]').length };
      }, target);
      assert.equal(sample.rendered, sample.count);
      assert.ok(!sample.error, sample.error);
      assert.equal(sample.openDialogs, 0, 'Folder navigation must not open app dialogs');
      result.samples.push(sample);
    }
    await app.close(); app = null;
    result.asarSha256 = createHash('sha256').update(fs.readFileSync(path.join(path.dirname(executable), 'resources', 'app.asar'))).digest('hex');
    results.push(result);
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ root, results }, null, 2));
  }
  console.log(JSON.stringify({ root, results }, null, 2));
})().catch(async error => {
  fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify({ error: error.stack, results }, null, 2));
  if (app) await app.close().catch(() => {});
  console.error(error); process.exitCode = 1;
});
