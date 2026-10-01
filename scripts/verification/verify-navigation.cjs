'use strict';
// Exercise both Chromium mouse input and Windows app-command fallback in a hidden test window.
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
const sender = path.join(root, 'send-navigation.ps1');
fs.writeFileSync(sender, `param([long]$WindowHandle, [int]$Command, [int]$X, [int]$Y)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NavigationTestInput {
  [DllImport("user32.dll", SetLastError=true)]
  static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
  delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder name, int size);
  public static void Send(long handle, int command, int x, int y) {
    var hwnd = new IntPtr(handle);
    IntPtr target = hwnd;
    EnumChildWindows(hwnd, (child, data) => {
      var name = new System.Text.StringBuilder(256);
      GetClassName(child, name, name.Capacity);
      if (name.ToString() == "Chrome_RenderWidgetHostHWND") { target = child; return false; }
      return true;
    }, IntPtr.Zero);
    UIntPtr result;
    var keys = new IntPtr((command << 16) | (command == 1 ? 0x20 : 0x40));
    var point = new IntPtr((y << 16) | x);
    if (SendMessageTimeout(target, 0x020B, keys, point, 2, 2000, out result) == IntPtr.Zero)
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    if (SendMessageTimeout(target, 0x020C, new IntPtr(command << 16), point, 2, 2000, out result) == IntPtr.Zero)
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    Console.WriteLine(target == hwnd ? "main-window" : "renderer-child");
  }
}
'@
[NavigationTestInput]::Send($WindowHandle, $Command, $X, $Y)
`);
let application, page, handle, cdp;
const errors = [], checks = [], inputTargets = new Set();
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
async function command(number = 1, target = panel(1), native = false) {
  assert.match(handle, /^\d+$/);
  assert.ok(number === 1 || number === 2);
  const rect = await target.locator('.file-scroll').boundingBox();
  const x = Math.round(rect.x + 16), y = Math.round(rect.y + 60);
  assert.ok([x,y].every(value => Number.isInteger(value) && value >= 0 && value < 32768));
  if (native) {
    const invocation = `& {\n${fs.readFileSync(sender, 'utf8')}\n} ${handle} ${number} ${x} ${y}`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', invocation], { windowsHide: true, timeout: 10000, encoding: 'utf8' });
    inputTargets.add(`Win32 ${output.trim()}`);
  } else {
    const button = number === 1 ? 'back' : 'forward';
    const before = await page.evaluate(() => ({ active: document.querySelector('.file-panel.active')?.id, path: document.querySelector('.file-panel.active .path-input')?.value }));
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: number === 1 ? 8 : 16, clickCount: 1 });
    const down = await page.evaluate(() => ({ active: document.querySelector('.file-panel.active')?.id, path: document.querySelector('.file-panel.active .path-input')?.value }));
    assert.deepEqual(down, before, 'Side-button down must not navigate or focus the hovered pane');
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
    inputTargets.add('Chromium back/forward mouse input');
  }
  // Main/renderer round trips drain delivered IPC before assertions for ignored commands.
  await application.evaluate(() => global.navigationCommands);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.evaluate(() => window.unhandledSideButtons), [], 'Side buttons must not reach DOM focus/browser defaults');
  assert.equal(await page.evaluate(() => history.state?.navigationProbe), 'current', 'Mouse input must not traverse browser history');
}
async function capture(name) {
  // Electron can capture a hidden window without activating it on the user's desktop.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const png = await application.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayHidden: true });
    return image.toPNG().toString('base64');
  });
  assert.ok(png.length > 0, 'Hidden window capture must contain an image');
  fs.writeFileSync(path.join(root, name), Buffer.from(png, 'base64'));
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
  cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    window.unhandledSideButtons = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick']) {
      document.addEventListener(type, event => { if (event.button === 3 || event.button === 4) window.unhandledSideButtons.push(type); }, true);
    }
    history.replaceState({ navigationProbe: 'before' }, '', location.href);
    history.pushState({ navigationProbe: 'current' }, '', location.href);
  });
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
  await loaded(0, path.join(folders[0], 'child'));
  assert.equal(await input(1).inputValue(), path.join(folders[1], 'child'));
  assert.equal(await panel(0).locator('[data-action="forward"]').isEnabled(), true);
  await command(2); await loaded(0, path.join(folders[0], 'child', 'deep'));
  assert.equal(await panel(0).locator('[data-action="forward"]').isDisabled(), true);
  await command(); await loaded(0, path.join(folders[0], 'child'));
  checks.push('Chromium Back/Forward input navigates on release and preserves the active pane even over another pane');
  await command(1, panel(1), true); await loaded(0, folders[0]);
  await command(2, panel(1), true); await loaded(0, path.join(folders[0], 'child'));
  assert.deepEqual(await application.evaluate(() => global.navigationCommands), ['browser-backward', 'browser-forward']);
  checks.push('Native Windows XBUTTON/app-command fallback still moves exactly one entry in each direction');
  await command(); await loaded(0, folders[0]);
  await command(); await loaded(0, folders[0]);
  assert.equal(await panel(0).locator('[data-action="back"]').isDisabled(), true);
  assert.equal(page.url(), originalURL);
  await command(2); await loaded(0, path.join(folders[0], 'child'));
  await command(2); await loaded(0, path.join(folders[0], 'child', 'deep'));
  await command(2); await loaded(0, path.join(folders[0], 'child', 'deep'));
  checks.push('Back/forward round trip consumes one entry; empty history keeps folder and app page unchanged');
  await command(); await loaded(0, path.join(folders[0], 'child'));
  await go(0, folders[2]);
  assert.equal(await panel(0).locator('[data-action="forward"]').isDisabled(), true);
  await command(2); await loaded(0, folders[2]);
  checks.push('Navigating a new branch clears only that pane\'s forward history');
  await panel(1).locator('.panel-tab-label').click();
  await command(); await loaded(1, folders[1]);
  await page.locator('#help-button').click();
  await command(2); await loaded(1, folders[1]);
  await command(); await loaded(1, folders[1]);
  assert.equal(await page.locator('#info-dialog').evaluate(dialog => dialog.open), true);
  await page.keyboard.press('Escape');
  await command(2); await loaded(1, path.join(folders[1], 'child'));
  checks.push('Open modal blocks both mouse buttons; another active pane has independent history');
  await panel(1).locator('.panel-tab-label').click();
  await page.keyboard.press('Alt+ArrowLeft'); await loaded(1, folders[1]);
  await page.keyboard.press('Alt+ArrowRight'); await loaded(1, path.join(folders[1], 'child'));
  await panel(1).locator('[data-action="back"]').click(); await loaded(1, folders[1]);
  await panel(1).locator('[data-action="forward"]').click(); await loaded(1, path.join(folders[1], 'child'));
  await command(); await loaded(1, folders[1]);
  await page.keyboard.press('F5'); await loaded(1, folders[1]);
  await command(2); await loaded(1, path.join(folders[1], 'child'));
  checks.push('Alt+Left/Right and toolbar back/forward agree; refresh preserves forward history');
  await command(); await loaded(1, folders[1]);
  fs.renameSync(path.join(folders[1], 'child'), path.join(folders[1], 'temporarily-renamed'));
  await command(2);
  await panel(1).locator('.panel-error').waitFor({ state: 'visible' });
  assert.equal(await input(1).inputValue(), folders[1]);
  assert.equal(await panel(1).locator('[data-action="forward"]').isEnabled(), true);
  fs.renameSync(path.join(folders[1], 'temporarily-renamed'), path.join(folders[1], 'child'));
  await panel(1).locator('[data-action="retry"]').click(); await loaded(1, path.join(folders[1], 'child'));
  assert.equal(await panel(1).locator('[data-action="forward"]').isDisabled(), true);
  checks.push('Failed forward keeps history; retry completes the original forward traversal');
  await page.locator('[data-workspace="documents"]').click();
  await go(0, path.join(folders[3], 'child'), 'documents');
  await page.locator('[data-layout="1"]').click();
  await command(1, panel(0, 'documents')); await loaded(0, folders[3], 'documents');
  await command(2, panel(0, 'documents')); await loaded(0, path.join(folders[3], 'child'), 'documents');
  assert.equal(await input(1).inputValue(), path.join(folders[1], 'child'));
  checks.push('Active workspace and single-pane layout route to the current pane');
  assert.deepEqual(errors, []);
  await capture('navigation.png');
  await page.locator('[data-workspace="design"]').click();
  await capture('navigation-four-panes.png');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 540));
  // Windows frame metrics and display scaling can make outerWidth differ from setSize.
  await page.waitForFunction(() => window.innerWidth <= 760);
  for (let i = 0; i < folders.length; i++) {
    const navigation = panel(i).locator('.panel-navigation');
    const bounds = await navigation.boundingBox();
    for (const action of ['back', 'forward', 'up']) {
      const button = await navigation.locator(`[data-action="${action}"]`).boundingBox();
      assert.ok(button && button.x >= bounds.x && button.x + button.width <= bounds.x + bounds.width, `${action} fits pane ${i}`);
    }
  }
  await capture('navigation-minimum.png');
  checks.push('Back/forward/up buttons fit all four panes at the minimum window size');
  const result = { passed: true, checks, errors, inputTargets: [...inputTargets], limits: 'Chromium mouse input and Win32 XBUTTON messages are injected into the test window. Physical mouse hardware/driver remapping is not exercised.' };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ root, ...result }, null, 2));
})().catch(error => { fs.writeFileSync(path.join(root, 'failure.txt'), error.stack); console.error(error); process.exitCode = 1; })
  .finally(async () => { await application?.close(); });
