'use strict';
// Send Windows mouse-back app commands only to this test's hidden Electron window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
const { _electron } = dependencies('playwright');
const project = path.resolve(__dirname, '..', '..');
const root = path.join(project, '.checks', 'navigation', `run-${Date.now()}`);
const profile = path.join(root, 'profile');
const settings = path.join(profile, 'quadpane-data');
const folders = ['first', 'second', 'documents', 'fourth'].map(name => path.join(root, name));
for (const folder of folders) fs.mkdirSync(path.join(folder, 'child', 'deep'), { recursive: true });
fs.mkdirSync(settings, { recursive: true });
const pane = folder => ({ path: folder, sort: 'name', direction: 1 });
fs.writeFileSync(path.join(settings, 'session.json'), JSON.stringify({ version: 1, workspaceId: 'design', workspaces: {
  design: { layout: 4, active: 0, panes: folders.map(pane) },
  documents: { layout: 2, active: 0, panes: [...folders].reverse().map(pane) },
} }));
const sender = path.join(root, 'send-back.ps1');
fs.writeFileSync(sender, `param([long]$WindowHandle, [int]$Command)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NavigationTestInput {
  [DllImport("user32.dll", SetLastError=true)]
  static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  public static void Send(long handle, int command) {
    var hwnd = new IntPtr(handle);
    UIntPtr result;
    var data = new IntPtr(unchecked((int)((0x8000 | command) << 16)));
    if (SendMessageTimeout(hwnd, 0x0319, hwnd, data, 2, 2000, out result) == IntPtr.Zero)
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@
[NavigationTestInput]::Send($WindowHandle, $Command)
`);
let application, page, handle;
const errors = [], checks = [];
const panel = (index = 0, workspace = 'design') => page.locator(`#panel-${workspace}-${index}`);
const input = (index = 0, workspace = 'design') => panel(index, workspace).locator('.path-input');
async function loaded(index, folder, workspace = 'design') {
  await page.waitForFunction(({ id, folder }) => {
    const panel = document.getElementById(id);
    return panel?.getAttribute('aria-busy') === 'false' && panel.querySelector('.path-input').value === folder;
  }, { id: `panel-${workspace}-${index}`, folder }, { timeout: 5000 });
}
async function go(index, folder, workspace = 'design') {
  await input(index, workspace).fill(folder);
  await input(index, workspace).press('Enter');
  await loaded(index, folder, workspace);
}
async function command(number = 1) {
  assert.match(handle, /^\d+$/);
  assert.ok(number === 1 || number === 2);
  const invocation = `& {\n${fs.readFileSync(sender, 'utf8')}\n} ${handle} ${number}`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', invocation], { windowsHide: true, timeout: 10000 });
  // Main/renderer round trips drain delivered IPC before assertions for ignored commands.
  await application.evaluate(() => global.navigationCommands);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
(async () => {
  application = await _electron.launch({
    executablePath: path.join(project, 'dist-portable', 'win-unpacked', 'Quadpane.exe'),
    args: ['--pane-smoke-test'],
    env: { ...process.env, PORTABLE_EXECUTABLE_DIR: profile }, timeout: 30000,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  handle = await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    global.navigationCommands = [];
    window.on('app-command', (_event, command) => global.navigationCommands.push(command));
    return window.getNativeWindowHandle().readBigUInt64LE().toString();
  });
  for (let i = 0; i < folders.length; i++) await loaded(i, folders[i]);
  const originalURL = page.url();
  await go(0, path.join(folders[0], 'child'));
  await go(0, path.join(folders[0], 'child', 'deep'));
  await go(1, path.join(folders[1], 'child'));
  await panel(0).locator('.panel-tab-label').click();
  await panel(1).locator('.file-scroll').hover();
  await command();
  assert.equal((await application.evaluate(() => global.navigationCommands)).at(-1), 'browser-backward');
  await loaded(0, path.join(folders[0], 'child'));
  assert.equal(await input(1).inputValue(), path.join(folders[1], 'child'));
  checks.push('Windows mouse-back command navigates only the active pane even with pointer over another pane');
  await command(); await loaded(0, folders[0]);
  await command(); await loaded(0, folders[0]);
  assert.equal(await panel(0).locator('[data-action="back"]').isDisabled(), true);
  assert.equal(page.url(), originalURL);
  checks.push('One history entry per command; empty history keeps folder and app page unchanged');
  await panel(1).locator('.panel-tab-label').click();
  await command(2); await loaded(1, path.join(folders[1], 'child'));
  await page.locator('#help-button').click();
  await command(); await loaded(1, path.join(folders[1], 'child'));
  assert.equal(await page.locator('#info-dialog').evaluate(dialog => dialog.open), true);
  await page.keyboard.press('Escape');
  await command(); await loaded(1, folders[1]);
  checks.push('Forward command ignored; open modal blocks mouse back; next active pane has independent history');
  await go(1, path.join(folders[1], 'child'));
  await panel(1).locator('.panel-tab-label').click();
  await page.keyboard.press('Alt+ArrowLeft'); await loaded(1, folders[1]);
  await go(1, path.join(folders[1], 'child'));
  await panel(1).locator('[data-action="back"]').click(); await loaded(1, folders[1]);
  checks.push('Existing Alt+Left and toolbar back still use folder history');
  await page.locator('[data-workspace="documents"]').click();
  await go(0, path.join(folders[3], 'child'), 'documents');
  await page.locator('[data-layout="1"]').click();
  await command(); await loaded(0, folders[3], 'documents');
  assert.equal(await input(1).inputValue(), folders[1]);
  checks.push('Active workspace and single-pane layout route to the current pane');
  assert.deepEqual(errors, []);
  const result = { passed: true, checks, errors, limits: 'Win32 mouse-origin app command injected into the test window. Physical mouse hardware/driver remapping is not exercised.' };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ root, ...result }, null, 2));
})().catch(error => { fs.writeFileSync(path.join(root, 'failure.txt'), error.stack); console.error(error); process.exitCode = 1; })
  .finally(async () => { await application?.close(); });
