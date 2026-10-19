'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { test } = require('node:test');

// Private test binaries; never launch or terminate the installed helper.
test('native shell lifecycle and drag contracts', { skip: process.platform !== 'win32', timeout: 45000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quadpane-shell-lifecycle-'));
  t.after(() => {
    const relative = path.relative(os.tmpdir(), path.resolve(directory));
    assert.ok(relative.startsWith('quadpane-shell-lifecycle-') && !relative.includes(path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const executable = path.join(directory, 'ShellLifecycleTest.exe');
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const build = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/main:ShellLifecycleTest',
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll', `/out:${executable}`,
    path.join(__dirname, 'native', 'ShellMenu.cs'), path.join(__dirname, 'native', 'ShellLifecycleTest.cs')],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(build.status, 0, `${build.error || ''}\n${build.stdout}\n${build.stderr}`);

  await t.test('an unhandled WinForms callback exits as failure instead of leaving the helper busy', async () => {
    const child = spawn(executable, ['thread-exception'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errors += data; });
    child.stdin.on('error', () => {});
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 1, output + errors);
    assert.match(output, /THREAD_EXCEPTION_THROWN/u);
    assert.doesNotMatch(output, /TEST_DEADLINE/u);
  });

  for (const mode of ['blocked-host', 'blocked-host-error']) await t.test(`${mode}: parent disconnect exits the actual host with its UI thread blocked`, async () => {
    const child = spawn(executable, [mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', sent = false, disconnected = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stderr.on('data', data => { errors += data; });
    child.stdin.on('error', () => {});
    child.stdout.on('data', data => {
      output += data;
      if (!sent && output.includes('READY')) { sent = true; child.stdin.write('{\n'); }
      if (!disconnected && output.includes('UI_BLOCKED')) { disconnected = true; child.stdin.end(); }
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.ok(disconnected, output + errors);
    assert.equal(code, 0, output + errors);
    assert.match(output, /EOF_OBSERVED/u);
    assert.doesNotMatch(output, /TEST_DEADLINE/u);
  });

  await t.test('a source first called with the button released cancels instead of dropping', () => {
    const result = spawnSync(executable, ['first-released'], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
  for (const mode of ['parent-death', 'buttons', 'drag', 'watchdog', 'races', 'queue', 'queue-error', 'queue-cancel', 'queue-cancel-error', 'progress', 'lost-release', 'blocked-shutdown']) {
    await t.test(mode, () => {
      const result = spawnSync(executable, [mode], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, mode === 'lost-release' ? 2 : 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
      assert.doesNotMatch(result.stdout, /TEST_DEADLINE/u);
      if (mode === 'blocked-shutdown') assert.match(result.stdout, /SHUTDOWN_BLOCKED/u);
    });
  }
});
