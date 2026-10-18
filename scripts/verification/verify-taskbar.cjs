'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const project = path.resolve(__dirname, '../..');
if (!process.versions.electron) {
  const runRoot = path.join(project, '.checks', 'taskbar', `run-${Date.now()}`);
  fs.mkdirSync(runRoot, { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(require('electron'), [__filename, runRoot], { env, windowsHide: true, encoding: 'utf8', timeout: 30000 });
  const resultPath = path.join(runRoot, 'result.json');
  const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null;
  if (child.error || child.status !== 0 || !result?.passed) {
    console.error(result || { error: child.error?.message, status: child.status, stderr: child.stderr });
    process.exitCode = 1;
  } else console.log(JSON.stringify(result, null, 2));
} else {
  const { app, BrowserWindow, shell, nativeImage } = require('electron');
  const { createTaskbarIntegration } = require('../../desktop/taskbar.cjs');
  const runRoot = path.resolve(process.argv[2]);
  const profile = path.join(runRoot, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);

  app.whenReady().then(() => {
    const checks = [];
    const pinnedDirectory = path.join(runRoot, 'isolated-pins');
    const portableDirectory = path.join(runRoot, '한글 도구 모음');
    const extractionDirectory = path.join(runRoot, 'temporary-extraction');
    for (const directory of [pinnedDirectory, portableDirectory, extractionDirectory]) fs.mkdirSync(directory);
    const original = path.join(portableDirectory, 'Quadpane portable.exe');
    const extracted = path.join(extractionDirectory, 'Quadpane.exe');
    // Only existence is needed here; actual EXE launches are covered by verify-launcher.
    for (const executable of [original, extracted]) fs.writeFileSync(executable, 'test target');
    const sourceIcon = path.join(extractionDirectory, 'quadpane.ico');
    fs.copyFileSync(path.join(project, 'desktop', 'quadpane.ico'), sourceIcon);
    const appId = 'com.quadpane.app';
    const addLink = (name, options) => {
      const file = path.join(pinnedDirectory, `${name}.lnk`);
      assert.equal(shell.writeShortcutLink(file, 'create', options), true);
      return file;
    };
    const customArgs = '--custom "한글 값"';
    const stale = addLink('Stale', { target: path.join(runRoot, 'gone', 'Quadpane.exe'), cwd: path.join(runRoot, 'gone'), appUserModelId: appId, args: customArgs, description: 'Keep description' });
    const current = addLink('Current extraction', { target: extracted, cwd: extractionDirectory, appUserModelId: appId });
    const unrelated = addLink('Unrelated', { target: path.join(runRoot, 'missing-other.exe'), appUserModelId: 'another.app' });
    const anotherCopy = addLink('Other valid copy', { target: process.execPath, appUserModelId: appId, args: '--custom' });
    const unchanged = [unrelated, anotherCopy].map(file => [file, fs.readFileSync(file)]);
    const taskbar = createTaskbarIntegration({
      isPackaged: true, platform: process.platform, applicationId: appId,
      env: { PORTABLE_EXECUTABLE_FILE: original, PORTABLE_EXECUTABLE_DIR: portableDirectory },
      portableDirectory, execPath: extracted, dataDirectory: path.join(portableDirectory, 'quadpane-data'),
      iconSource: sourceIcon, pinnedDirectory, shell,
    });
    assert.ok(taskbar);
    const window = new BrowserWindow({ show: false, icon: taskbar.windowIcon });
    const result = taskbar.apply(window);
    assert.deepEqual(result, { applied: true, repaired: 2 });
    checks.push('real BrowserWindow accepts persistent taskbar metadata before showing');
    for (const file of [stale, current]) {
      const link = shell.readShortcutLink(file);
      assert.equal(link.target, original);
      assert.equal(link.icon, taskbar.iconPath);
      assert.equal(link.iconIndex, 0);
      assert.equal(link.appUserModelId, appId);
      assert.equal(link.cwd, portableDirectory);
    }
    assert.equal(shell.readShortcutLink(stale).args, customArgs);
    assert.equal(shell.readShortcutLink(stale).description, 'Keep description');
    checks.push('real Windows shortcut repair preserves identity, custom arguments and description');
    for (const [file, bytes] of unchanged) assert.deepEqual(fs.readFileSync(file), bytes);
    checks.push('unrelated shortcut and valid other-copy shortcut remain byte-for-byte unchanged');
    assert.equal(taskbar.appDetails.relaunchCommand, `"${original}"`);
    assert.equal(nativeImage.createFromPath(taskbar.iconPath).isEmpty(), false);
    const iconHash = createHash('sha256').update(fs.readFileSync(taskbar.iconPath)).digest('hex');
    window.destroy();
    fs.unlinkSync(extracted);
    fs.unlinkSync(sourceIcon);
    assert.ok(fs.existsSync(original));
    assert.equal(nativeImage.createFromPath(shell.readShortcutLink(stale).icon).isEmpty(), false);
    checks.push('shortcut target and readable icon survive window close and extraction-file removal');
    fs.writeFileSync(path.join(runRoot, 'result.json'), JSON.stringify({ passed: true, runRoot, checks, result, appDetails: taskbar.appDetails, repairedShortcut: shell.readShortcutLink(stale), iconHash }, null, 2));
    app.quit();
  }).catch(error => {
    fs.writeFileSync(path.join(runRoot, 'result.json'), JSON.stringify({ passed: false, error: error.stack }, null, 2));
    app.exit(1);
  });
}
