'use strict';
// Portable extraction + visible-pane readiness, with fresh isolated profiles.
// This is a repeatable warm-filesystem benchmark, not an OS cold-cache claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
const { chromium } = dependencies('playwright');
const executables = process.argv.slice(3).map(filename => path.resolve(filename));
assert.ok(executables.length, 'Provide portable EXE paths after the Playwright dependency root');
const root = path.resolve(__dirname, '../../.checks/startup-timing', `run-${Date.now()}`);
const fixture = path.join(root, 'files');
fs.mkdirSync(fixture, { recursive: true });
for (let index = 0; index < 100; index++) fs.writeFileSync(path.join(fixture, `file-${index}.txt`), 'fixture');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
let active;
const results = [];
(async () => {
  for (const [index, source] of executables.entries()) {
    const result = { executable: source, bytes: fs.statSync(source).size,
      sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex'), samples: [] };
    for (let run = 0; run < 3; run++) {
      const profile = path.join(root, `app-${index}-${run}`);
      const settings = path.join(profile, 'quadpane-data');
      fs.mkdirSync(settings, { recursive: true });
      const executable = path.join(profile, path.basename(source));
      fs.copyFileSync(source, executable);
      const panes = [0, 1, 2, 3].map(() => ({ path: fixture, sort: 'name', direction: 1 }));
      fs.writeFileSync(path.join(settings, 'session.json'), JSON.stringify({ version: 1, workspaceId: 'design',
        workspaces: { design: { layout: 4, active: 0, panes }, documents: { layout: 2, active: 0, panes } } }));
      const port = await reservePort();
      const env = { ...process.env };
      for (const key of ['ELECTRON_RUN_AS_NODE', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_APP_FILENAME']) delete env[key];
      const start = performance.now();
      const child = spawn(executable, ['--pane-smoke-test', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
        { cwd: profile, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      active = { child, exited: false, code: null, error: null, output: '' };
      const state = active;
      child.on('error', error => { state.error = error; });
      child.on('exit', code => { state.exited = true; state.code = code; });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { state.output = (state.output + chunk).slice(-4000); });
      const endpoint = `http://127.0.0.1:${port}`;
      let browser;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        if (state.error) throw state.error;
        assert.ok(!state.exited, `Launcher exited early: ${state.code}: ${state.output}`);
        try {
          const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(500) });
          if (response.ok) { browser = await chromium.connectOverCDP(endpoint); break; }
        } catch { /* Extraction/Chromium startup has not opened CDP yet. */ }
        await delay(75);
      }
      assert.ok(browser, `Startup timeout: ${state.output}`);
      const cdpMs = performance.now() - start;
      const context = browser.contexts()[0];
      let page;
      while (!page && Date.now() < deadline) {
        page = context.pages().find(candidate => candidate.url().includes('index.html'));
        if (!page) await delay(25);
      }
      assert.ok(page, 'App page missing');
      await page.waitForFunction(() => {
        const panels = [...document.querySelectorAll('.file-panel')].filter(panel => !panel.closest('[hidden]'));
        return panels.length === 4 && panels.every(panel => panel.getAttribute('aria-busy') === 'false' && panel.querySelectorAll('[data-file]').length === 100);
      }, null, { timeout: 20000 });
      const readyMs = performance.now() - start;
      const loadedPanes = await page.locator('.file-panel').evaluateAll(panels => panels.filter(panel => panel.querySelectorAll('[data-file]').length === 100).length);
      result.samples.push({ cdpMs, readyMs, loadedPanes });
      await page.close({ runBeforeUnload: true });
      const exitDeadline = Date.now() + 20000;
      while (!state.exited && Date.now() < exitDeadline) await delay(100);
      assert.ok(state.exited, 'Own portable launcher failed to exit');
      assert.equal(state.code, 0, state.output);
      await browser.close();
      active = null;
    }
    result.medianReadyMs = result.samples.map(sample => sample.readyMs).sort((a, b) => a - b)[1];
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
  }
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`Evidence: ${path.join(root, 'results.json')}`);
})().catch(async error => {
  if (active && !active.exited && active.child.pid) await new Promise(resolve => execFile('taskkill', ['/PID', String(active.child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()));
  console.error(error);
  process.exitCode = 1;
});
