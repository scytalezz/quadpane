'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createPreferencesStore, validatePreferences, MAX_PREFERENCES_BYTES } = require('./preferences-store.cjs');
const base = path.join(__dirname, '..', '.checks', 'preferences-tests');
fs.mkdirSync(base, { recursive: true });

test('preferences normalize and deduplicate paths without requiring connected drives', () => {
  assert.deepEqual(validatePreferences({ favorites: [
    { path: 'z:/문서/../작업/', label: ' 작업 ' }, { path: 'Z:\\작업', label: '중복' },
  ], recentPaths: ['c:/Alpha', 'C:\\alpha', 'Z:\\연결 안 됨'] }), {
    favorites: [{ path: 'Z:\\작업', label: '작업' }], recentPaths: ['C:\\Alpha', 'Z:\\연결 안 됨'],
    showHidden: false, showExtensions: true,
  });
});

test('preferences reject malformed values and enforce caps', () => {
  for (const input of [null, [], {}, { favorites: [], recentPaths: [42] },
    { favorites: [{ path: 'C:\\work', label: '' }], recentPaths: [] },
    { favorites: [{ path: 'C:relative', label: 'bad' }], recentPaths: [] },
    { favorites: Array(101).fill({ path: 'C:\\work', label: 'x' }), recentPaths: [] },
    { favorites: [], recentPaths: Array(31).fill('C:\\work') }]) {
    assert.throws(() => validatePreferences(input), { code: 'INVALID_PREFERENCES' });
  }
});

test('atomic preferences survive restart, failed validation leaves last valid bytes, session remains untouched', () => {
  const directory = fs.mkdtempSync(path.join(base, 'persist-'));
  const store = createPreferencesStore(directory);
  assert.deepEqual(store.load(), { preferences: { favorites: [], recentPaths: [], showHidden: false, showExtensions: true } });
  const sessionPath = path.join(directory, 'session.json');
  fs.writeFileSync(sessionPath, 'previous session');
  const value = { favorites: [{ path: 'D:\\한글 & 작업', label: '한글 즐겨찾기' }], recentPaths: ['D:\\한글 & 작업'], showHidden: true, showExtensions: false };
  assert.deepEqual(store.save(value), value);
  assert.deepEqual(createPreferencesStore(directory).load(), { preferences: value });
  const before = fs.readFileSync(path.join(directory, 'preferences.json'));
  assert.throws(() => store.save({ favorites: [], recentPaths: ['https://bad'] }), { code: 'INVALID_PREFERENCES' });
  assert.deepEqual(fs.readFileSync(path.join(directory, 'preferences.json')), before);
  assert.equal(fs.readFileSync(sessionPath, 'utf8'), 'previous session');
  assert.deepEqual(fs.readdirSync(directory).sort(), ['preferences.json', 'session.json']);
});

test('corrupt or oversized preferences return warning without destroying stored evidence', () => {
  const directory = fs.mkdtempSync(path.join(base, 'corrupt-'));
  const filename = path.join(directory, 'preferences.json');
  fs.writeFileSync(filename, '{broken');
  assert.match(createPreferencesStore(directory).load().preferencesWarning, /읽을 수 없습니다/u);
  assert.equal(fs.readFileSync(filename, 'utf8'), '{broken');
  fs.writeFileSync(filename, Buffer.alloc(MAX_PREFERENCES_BYTES + 1));
  assert.ok(createPreferencesStore(directory).load().preferencesWarning);
});

test('legacy preferences gain display defaults without changing favorites, recents or stored bytes on load', () => {
  const directory = fs.mkdtempSync(path.join(base, 'legacy-'));
  const filename = path.join(directory, 'preferences.json');
  const legacy = { favorites: [{ path: 'Z:\\오프라인', label: '보관' }], recentPaths: ['\\\\server\\공유\\최근'] };
  const original = JSON.stringify(legacy, null, 2);
  fs.writeFileSync(filename, original);
  const migrated = { ...legacy, showHidden: false, showExtensions: true };
  const store = createPreferencesStore(directory);
  assert.deepEqual(store.load(), { preferences: migrated });
  assert.equal(fs.readFileSync(filename, 'utf8'), original);
  assert.deepEqual(store.save(legacy), migrated);
  assert.deepEqual(createPreferencesStore(directory).load(), { preferences: migrated });
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), migrated);
});

test('display settings require booleans and default only absent fields', () => {
  const basePreferences = { favorites: [], recentPaths: [] };
  for (const field of ['showHidden', 'showExtensions']) {
    for (const value of [undefined, null, 0, 1, '', 'false', 'true', [], {}, new Boolean(false)]) {
      assert.throws(() => validatePreferences({ ...basePreferences, [field]: value }), { code: 'INVALID_PREFERENCES' });
    }
  }
  assert.deepEqual(validatePreferences({ ...basePreferences, showHidden: true, ignored: 'strip me' }), {
    ...basePreferences, showHidden: true, showExtensions: true,
  });
  assert.deepEqual(validatePreferences({ ...basePreferences, showExtensions: false }), {
    ...basePreferences, showHidden: false, showExtensions: false,
  });
});

test('every display setting combination persists across restart and invalid saves retain previous preferences', () => {
  const directory = fs.mkdtempSync(path.join(base, 'display-'));
  const filename = path.join(directory, 'preferences.json');
  const store = createPreferencesStore(directory);
  for (const showHidden of [false, true]) {
    for (const showExtensions of [false, true]) {
      const preferences = {
        favorites: [{ path: 'D:\\work', label: '작업' }], recentPaths: ['D:\\work'], showHidden, showExtensions,
      };
      assert.deepEqual(store.save(preferences), preferences);
      assert.deepEqual(createPreferencesStore(directory).load(), { preferences });
      const before = fs.readFileSync(filename);
      assert.throws(() => store.save({ ...preferences, showHidden: 'true' }), { code: 'INVALID_PREFERENCES' });
      assert.throws(() => store.save({ ...preferences, showExtensions: null }), { code: 'INVALID_PREFERENCES' });
      assert.deepEqual(fs.readFileSync(filename), before);
    }
  }
  fs.writeFileSync(filename, JSON.stringify({ favorites: [], recentPaths: [], showHidden: 'false' }));
  const before = fs.readFileSync(filename);
  const loaded = store.load();
  assert.ok(loaded.preferencesWarning);
  assert.deepEqual(loaded.preferences, { favorites: [], recentPaths: [], showHidden: false, showExtensions: true });
  assert.deepEqual(fs.readFileSync(filename), before);
});

test('failed atomic replacement retains display settings and cleans up the temporary file', t => {
  const directory = fs.mkdtempSync(path.join(base, 'failed-write-'));
  const filename = path.join(directory, 'preferences.json');
  const store = createPreferencesStore(directory);
  const preferences = { favorites: [], recentPaths: [], showHidden: true, showExtensions: false };
  store.save(preferences);
  const before = fs.readFileSync(filename);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('Cannot replace'), { code: 'EACCES' }); });
  assert.throws(() => store.save({ ...preferences, showHidden: false }), { code: 'PREFERENCES_WRITE_FAILED' });
  assert.deepEqual(fs.readFileSync(filename), before);
  assert.deepEqual(createPreferencesStore(directory).load(), { preferences });
  assert.deepEqual(fs.readdirSync(directory), ['preferences.json']);
});
