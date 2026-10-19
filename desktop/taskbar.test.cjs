'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path').win32;
const { createTaskbarIntegration } = require('./taskbar.cjs');

const original = 'D:\\내 도구 모음\\Quadpane portable.exe';
const nextExecutable = 'D:\\내 도구 모음\\Quadpane next.exe';
const extracted = 'C:\\Temp\\nsis-extraction\\Quadpane.exe';
const source = 'C:\\Temp\\nsis-extraction\\resources\\app.asar\\desktop\\quadpane.ico';
const dataDirectory = 'D:\\내 도구 모음\\quadpane-data';
const pinnedDirectory = 'C:\\test-only-pins';
const appId = 'com.quadpane.app';
const key = value => path.normalize(value).toLowerCase();

function fixture(overrides = {}) {
  const files = new Map([original, extracted].map(file => [key(file), Buffer.from('exe')]));
  files.set(key(source), Buffer.from('icon bytes'));
  const links = new Map(), writes = [], reads = [], fileWrites = [];
  const fs = {
    statSync(file) {
      if (!files.has(key(file))) throw Object.assign(new Error('Missing'), { code: 'ENOENT' });
      return { isFile: () => Buffer.isBuffer(files.get(key(file))) };
    },
    readFileSync(file) {
      this.statSync(file);
      return files.get(key(file));
    },
    mkdirSync() {},
    writeFileSync(file, bytes) { fileWrites.push(file); files.set(key(file), Buffer.from(bytes)); },
    readdirSync(directory) {
      assert.equal(directory, pinnedDirectory, 'Never inspect real user pins');
      reads.push(directory);
      return [...links.keys()];
    },
  };
  const shell = {
    readShortcutLink(filename) {
      const details = links.get(path.basename(filename));
      if (details instanceof Error) throw details;
      return details;
    },
    writeShortcutLink(filename, operation, changes) {
      assert.equal(operation, 'update');
      const previous = links.get(path.basename(filename));
      assert.ok(previous, 'Never create a pin');
      writes.push({ filename, changes });
      links.set(path.basename(filename), { ...previous, ...changes });
      return true;
    },
  };
  const options = {
    isPackaged: true, platform: 'win32', applicationId: appId,
    env: { PORTABLE_EXECUTABLE_FILE: original, PORTABLE_EXECUTABLE_DIR: path.dirname(original) },
    portableDirectory: path.dirname(original), execPath: extracted,
    dataDirectory, iconSource: source, pinnedDirectory, fs, shell,
    ...overrides,
  };
  return { options, files, links, writes, reads, fileWrites, fs, shell,
    prepare: () => createTaskbarIntegration(options) };
}

test('portable metadata quotes spaces and Korean and survives deletion of the extraction', () => {
  const f = fixture();
  const taskbar = f.prepare();
  const icon = path.join(dataDirectory, 'taskbar', 'quadpane.ico');
  assert.equal(taskbar.executablePath, original);
  assert.equal(taskbar.windowIcon, icon);
  assert.deepEqual(taskbar.appDetails, {
    appId, appIconPath: icon, appIconIndex: 0,
    relaunchCommand: `"${original}"`, relaunchDisplayName: 'Quadpane',
  });
  f.files.delete(key(extracted)); f.files.delete(key(source));
  assert.ok(f.fs.statSync(taskbar.executablePath).isFile());
  assert.ok(f.fs.statSync(taskbar.appDetails.appIconPath).isFile());
  let details;
  assert.equal(taskbar.apply({ setAppDetails(value) { details = value; } }).applied, true);
  assert.equal(details, taskbar.appDetails);
});

test('icon writes only when contents change', () => {
  const f = fixture();
  f.prepare(); f.prepare();
  assert.equal(f.fileWrites.length, 1);
  f.files.set(key(source), Buffer.from('updated icon'));
  f.prepare();
  assert.equal(f.fileWrites.length, 2);
});

test('unpacked executable is used only when all portable environment is absent', () => {
  const f = fixture({ env: {}, portableDirectory: undefined, execPath: original });
  assert.equal(f.prepare().appDetails.relaunchCommand, `"${original}"`);
});

for (const env of [
  { PORTABLE_EXECUTABLE_DIR: path.dirname(original) },
  { PORTABLE_EXECUTABLE_FILE: '' },
  { PORTABLE_EXECUTABLE_APP_FILENAME: 'Quadpane' },
  { PORTABLE_EXECUTABLE_FILE: 'relative.exe' },
  { PORTABLE_EXECUTABLE_FILE: '\\root-relative.exe' },
  { PORTABLE_EXECUTABLE_FILE: 'D:drive-relative.exe' },
  { PORTABLE_EXECUTABLE_FILE: `"${original}"` },
  { PORTABLE_EXECUTABLE_FILE: `${original}" --injected` },
  { PORTABLE_EXECUTABLE_FILE: `${original}\n` },
  { PORTABLE_EXECUTABLE_FILE: 'D:\\missing.exe' },
  { PORTABLE_EXECUTABLE_FILE: original, PORTABLE_EXECUTABLE_DIR: 'D:\\other-copy' },
]) {
  test(`invalid portable environment never falls back to extracted EXE: ${JSON.stringify(env)}`, () => {
    const f = fixture({ env, portableDirectory: env.PORTABLE_EXECUTABLE_DIR });
    assert.equal(f.prepare(), null);
    assert.equal(f.fileWrites.length, 0);
    assert.equal(f.reads.length, 0);
  });
}

test('portable original requires matching supplied directory and a regular executable file', () => {
  const f = fixture({ portableDirectory: 'D:\\other-copy' });
  assert.equal(f.prepare(), null);
  f.options.portableDirectory = path.dirname(original);
  f.files.set(key(original), null);
  assert.equal(f.prepare(), null);
  f.options.env.PORTABLE_EXECUTABLE_FILE = original.replace('.exe', '.txt');
  f.files.set(key(f.options.env.PORTABLE_EXECUTABLE_FILE), Buffer.from('text'));
  assert.equal(f.prepare(), null);
});

test('Windows directory comparisons accept casing and trailing separators', () => {
  const f = fixture({ portableDirectory: `${path.dirname(original).toUpperCase()}\\` });
  assert.ok(f.prepare());
});

for (const failure of ['readFileSync', 'mkdirSync', 'writeFileSync']) {
  test(`${failure} failure falls back to validated executable icon without aborting`, () => {
    const f = fixture();
    f.fs[failure] = () => { throw new Error('Access denied'); };
    const taskbar = f.prepare();
    assert.equal(taskbar.iconPath, original);
    assert.equal(taskbar.appDetails.appIconPath, original);
    assert.equal(taskbar.windowIcon, undefined, 'EXE is a shell icon source, not a BrowserWindow image');
  });
}

test('data directory inside current extraction cannot become a persistent icon location', () => {
  const f = fixture({ dataDirectory: path.join(path.dirname(extracted), 'quadpane-data') });
  assert.equal(f.prepare().appDetails.appIconPath, original);
  assert.equal(f.fileWrites.length, 0);
});

test('repairs confirmed broken/temp pins with a minimal update, preserving custom args and flags', () => {
  const f = fixture();
  const custom = { args: '--profile "D:\\내 설정\\one" --custom', flags: 8192,
    description: 'Keep description', toastActivatorClsid: 'keep-clsid' };
  f.links.set('Empty.lnk', { ...custom, appUserModelId: appId, target: '', cwd: 'C:\\Temp\\gone' });
  f.links.set('Gone.lnk', { ...custom, appUserModelId: appId, target: 'C:\\Temp\\gone\\Quadpane.exe' });
  f.links.set('Current.lnk', { ...custom, appUserModelId: appId, target: extracted, cwd: path.dirname(extracted) });
  const taskbar = f.prepare();
  assert.equal(taskbar.apply({ setAppDetails() {} }).repaired, 3);
  for (const link of f.links.values()) {
    assert.equal(link.target, original);
    assert.equal(link.cwd, path.dirname(original));
    assert.equal(link.icon, taskbar.iconPath);
    assert.equal(link.iconIndex, 0);
    for (const [name, value] of Object.entries(custom)) assert.equal(link[name], value);
  }
  for (const { changes } of f.writes) {
    assert.deepEqual(Object.keys(changes).sort(), ['cwd', 'icon', 'iconIndex', 'target']);
  }
});

test('unrelated, valid other-copy, unreadable and unidentifiable pins remain untouched', () => {
  const f = fixture();
  const other = 'E:\\Another portable copy\\Quadpane.exe';
  f.files.set(key(other), Buffer.from('other exe'));
  f.links.set('Quadpane.lnk', new Error('Empty target makes Electron read fail'));
  f.links.set('Unrelated.lnk', { appUserModelId: 'other.app', target: '' });
  f.links.set('Name only Quadpane.lnk', { target: '' });
  f.links.set('Another.lnk', { appUserModelId: appId, target: other, icon: 'custom.ico', args: '--custom' });
  f.links.set('Valid.lnk', { appUserModelId: appId, target: original });
  f.links.set('Unknown target.lnk', { appUserModelId: appId });
  f.links.set('Not a link.txt', { appUserModelId: appId, target: '' });
  const before = [...f.links];
  f.prepare().apply({ setAppDetails() {} });
  assert.equal(f.writes.length, 0);
  assert.deepEqual([...f.links], before);
});

test('a valid custom working directory survives a broken target repair', () => {
  const f = fixture();
  const cwd = 'D:\\custom work';
  f.files.set(key(cwd), null);
  f.links.set('Custom.lnk', { appUserModelId: appId, target: '', cwd });
  f.prepare().apply({ setAppDetails() {} });
  assert.equal(f.links.get('Custom.lnk').cwd, cwd);
  assert.equal(Object.hasOwn(f.writes[0].changes, 'cwd'), false);
});

for (const failure of ['throw', 'false']) {
  test(`failed pin update (${failure}) is nonfatal`, () => {
    const f = fixture();
    f.links.set('Broken.lnk', { appUserModelId: appId, target: '' });
    f.shell.writeShortcutLink = () => { if (failure === 'throw') throw new Error('Denied'); return false; };
    assert.deepEqual(f.prepare().apply({ setAppDetails() {} }), { applied: true, repaired: 0 });
  });
}

test('unavailable pins and failing window metadata are nonfatal', () => {
  const f = fixture();
  f.fs.readdirSync = () => { throw new Error('Denied'); };
  assert.deepEqual(f.prepare().apply({ setAppDetails() { throw new Error('Unavailable'); } }), { applied: false, repaired: 0 });
});

test('smoke test sets window metadata without even inspecting user pins', () => {
  const f = fixture({ smokeTest: true });
  f.links.set('Broken.lnk', { appUserModelId: appId, target: '' });
  assert.deepEqual(f.prepare().apply({ setAppDetails() {} }), { applied: true, repaired: 0 });
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
});

for (const overrides of [{ isPackaged: false }, { platform: 'linux' }, { platform: 'darwin' }]) {
  test(`development and non-Windows are skipped: ${JSON.stringify(overrides)}`, () => {
    const f = fixture(overrides);
    assert.equal(f.prepare(), null);
    assert.equal(f.fileWrites.length, 0);
    assert.equal(f.reads.length, 0);
  });
}

test('retargets only this original launcher, preserving custom shortcut properties and the old EXE', () => {
  const f = fixture();
  f.files.set(key(nextExecutable), Buffer.from('next exe'));
  const cwd = 'D:\\custom work';
  f.files.set(key(cwd), null);
  const custom = { args: '--profile "D:\\내 설정\\one" --custom', flags: 8192, cwd,
    description: 'Keep description', toastActivatorClsid: 'keep-clsid' };
  const targets = [original, original.toUpperCase().replaceAll('\\', '/'),
    path.join(path.dirname(original), 'unused', '..', path.basename(original))];
  targets.forEach((target, index) => f.links.set(`Current ${index}.LNK`, {
    ...custom, appUserModelId: appId, target, icon: extracted, iconIndex: 7,
  }));
  const taskbar = f.prepare();
  assert.equal(taskbar.retargetPins(nextExecutable), targets.length);
  assert.deepEqual(f.reads, [pinnedDirectory]);
  for (const link of f.links.values()) {
    assert.deepEqual(link, { ...custom, appUserModelId: appId, target: nextExecutable,
      icon: taskbar.iconPath, iconIndex: 0 });
  }
  for (const { changes } of f.writes) {
    assert.deepEqual(Object.keys(changes).sort(), ['icon', 'iconIndex', 'target']);
  }
  assert.equal(taskbar.executablePath, original);
  assert.equal(taskbar.appDetails.relaunchCommand, `"${original}"`);
  assert.ok(f.fs.statSync(original).isFile(), 'Old portable EXE is retained');
  assert.equal(taskbar.retargetPins(nextExecutable), 0, 'Already migrated pins are left alone');
  assert.equal(f.writes.length, targets.length);
});

test('migration leaves unrelated, other-copy, broken, extracted and unidentifiable pins untouched', () => {
  const f = fixture();
  f.files.set(key(nextExecutable), Buffer.from('next exe'));
  const other = 'E:\\Another portable copy\\Quadpane.exe';
  f.files.set(key(other), Buffer.from('other exe'));
  const unchanged = new Map([
    ['Unrelated.lnk', { appUserModelId: 'other.app', target: original }],
    ['Different ID case.lnk', { appUserModelId: appId.toUpperCase(), target: original }],
    ['Name only Quadpane.lnk', { target: original }],
    ['Other copy.lnk', { appUserModelId: appId, target: other }],
    ['Next.lnk', { appUserModelId: appId, target: nextExecutable }],
    ['Missing copy.lnk', { appUserModelId: appId, target: 'D:\\missing\\Quadpane.exe' }],
    ['Empty.lnk', { appUserModelId: appId, target: '' }],
    ['Extraction.lnk', { appUserModelId: appId, target: extracted }],
    ['Unknown target.lnk', { appUserModelId: appId }],
    ['Relative.lnk', { appUserModelId: appId, target: path.basename(original) }],
    ['Quoted.lnk', { appUserModelId: appId, target: `"${original}"` }],
    ['Unreadable.lnk', new Error('Unreadable')],
    ['Not a link.txt', { appUserModelId: appId, target: original }],
  ]);
  for (const [name, link] of unchanged) f.links.set(name, link);
  assert.equal(f.prepare().retargetPins(nextExecutable), 0);
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.links, unchanged);
});

for (const candidate of [
  undefined, null, 42, {}, '', 'relative.exe', '\\root-relative.exe', 'D:drive-relative.exe',
  `"${nextExecutable}"`, `${nextExecutable}" --injected`, `${nextExecutable}\n`,
  nextExecutable.replace('.exe', '.txt'), nextExecutable.replace('.exe', '.exe --flag'),
  original, original.toUpperCase().replaceAll('\\', '/'),
  `${path.dirname(original)}\\sub\\..\\${path.basename(original)}`,
  'E:\\other\\next.exe', path.join(path.dirname(original), 'sub', 'next.exe'),
  path.join(path.dirname(original), '..', 'next.exe'),
]) {
  test(`migration rejects invalid or non-sibling destination before inspecting pins: ${JSON.stringify(candidate)}`, () => {
    const f = fixture();
    if (typeof candidate === 'string') f.files.set(key(candidate), Buffer.from('file'));
    f.links.set('Current.lnk', { appUserModelId: appId, target: original });
    const taskbar = f.prepare();
    assert.equal(taskbar.retargetPins(candidate), 0);
    assert.equal(f.reads.length, 0);
    assert.equal(f.writes.length, 0);
  });
}

for (const failure of ['missing', 'directory', 'denied']) {
  test(`migration rejects ${failure} destination before inspecting pins`, () => {
    const f = fixture();
    const taskbar = f.prepare();
    if (failure === 'directory') f.files.set(key(nextExecutable), null);
    if (failure === 'denied') f.fs.statSync = () => { throw new Error('Access denied'); };
    assert.equal(taskbar.retargetPins(nextExecutable), 0);
    assert.equal(f.reads.length, 0);
    assert.equal(f.writes.length, 0);
  });
}

test('migration accepts a normalized sibling EXE with different path and extension casing', () => {
  const f = fixture();
  f.files.set(key(nextExecutable), Buffer.from('next exe'));
  f.links.set('Current.lnk', { appUserModelId: appId, target: original });
  const candidate = `${path.dirname(original)}\\unused\\..\\${path.basename(nextExecutable)}`.toUpperCase();
  assert.equal(f.prepare().retargetPins(candidate), 1);
  assert.equal(f.links.get('Current.lnk').target, candidate);
});

test('migration updates only empty, missing, old default or current extraction working directories', () => {
  const f = fixture();
  f.files.set(key(nextExecutable), Buffer.from('next exe'));
  f.files.set(key(path.dirname(original)), null);
  f.files.set(key(path.dirname(extracted)), null);
  const custom = 'D:\\custom work';
  f.files.set(key(custom), null);
  const inaccessible = 'D:\\inaccessible work';
  const stat = f.fs.statSync;
  f.fs.statSync = file => {
    if (key(file) === key(inaccessible)) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return stat(file);
  };
  const replace = [undefined, '', 'D:\\missing work', `${path.dirname(original).toUpperCase()}\\`,
    `${path.dirname(extracted).toUpperCase()}\\`];
  const preserve = [custom, inaccessible, 'relative-custom-work'];
  [...replace, ...preserve].forEach((cwd, index) => f.links.set(`${index}.lnk`, {
    appUserModelId: appId, target: original, ...(cwd === undefined ? {} : { cwd }),
  }));
  assert.equal(f.prepare().retargetPins(nextExecutable), replace.length + preserve.length);
  replace.forEach((_, index) => assert.equal(f.links.get(`${index}.lnk`).cwd, path.dirname(nextExecutable)));
  preserve.forEach((cwd, index) => {
    assert.equal(f.links.get(`${replace.length + index}.lnk`).cwd, cwd);
    assert.equal(Object.hasOwn(f.writes[replace.length + index].changes, 'cwd'), false);
  });
});

test('migration uses the verified next EXE as persistent icon fallback', () => {
  const f = fixture();
  f.files.delete(key(source));
  f.files.set(key(nextExecutable), Buffer.from('next exe'));
  f.links.set('Current.lnk', { appUserModelId: appId, target: original });
  const taskbar = f.prepare();
  assert.equal(taskbar.windowIcon, undefined);
  assert.equal(taskbar.retargetPins(nextExecutable), 1);
  assert.equal(f.links.get('Current.lnk').icon, nextExecutable);
  assert.equal(f.links.get('Current.lnk').iconIndex, 0);
  assert.ok(f.fs.statSync(original).isFile());
});

test('migration smoke mode does not validate destination or inspect pins', () => {
  const f = fixture({ smokeTest: true });
  const taskbar = f.prepare();
  f.fs.statSync = () => assert.fail('Smoke migration must not inspect the destination');
  assert.equal(taskbar.retargetPins(nextExecutable), 0);
  assert.equal(f.reads.length, 0);
  assert.equal(f.writes.length, 0);
});

for (const shell of [undefined, {}, { readShortcutLink() {} }, { writeShortcutLink() {} }]) {
  test('migration skips unavailable shell shortcut support', () => {
    const f = fixture({ shell });
    f.files.set(key(nextExecutable), Buffer.from('next exe'));
    assert.equal(f.prepare().retargetPins(nextExecutable), 0);
    assert.equal(f.reads.length, 0);
    assert.equal(f.writes.length, 0);
  });
}

test('migration skips unavailable pin folders and creates no pins in an empty folder', () => {
  const f = fixture();
  f.files.set(key(nextExecutable), Buffer.from('next exe'));
  const taskbar = f.prepare();
  assert.equal(taskbar.retargetPins(nextExecutable), 0);
  f.fs.readdirSync = () => { throw new Error('Denied'); };
  assert.equal(taskbar.retargetPins(nextExecutable), 0);
  assert.equal(f.writes.length, 0);
  f.options.pinnedDirectory = 'relative-pins';
  f.fs.readdirSync = () => assert.fail('Invalid pin folder must not be inspected');
  assert.equal(f.prepare().retargetPins(nextExecutable), 0);
});

test('migration continues after unreadable pins, thrown writes and unsuccessful writes', () => {
  const f = fixture();
  f.files.set(key(nextExecutable), Buffer.from('next exe'));
  f.links.set('Unreadable.lnk', new Error('Unreadable'));
  for (const name of ['Throw.lnk', 'False.lnk', 'Good.lnk']) {
    f.links.set(name, { appUserModelId: appId, target: original });
  }
  const write = f.shell.writeShortcutLink;
  f.shell.writeShortcutLink = (filename, operation, changes) => {
    if (path.basename(filename) === 'Throw.lnk') throw new Error('Denied');
    if (path.basename(filename) === 'False.lnk') return false;
    return write(filename, operation, changes);
  };
  assert.equal(f.prepare().retargetPins(nextExecutable), 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.links.get('Throw.lnk').target, original);
  assert.equal(f.links.get('False.lnk').target, original);
  assert.equal(f.links.get('Good.lnk').target, nextExecutable);
});
