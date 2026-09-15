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
  assert.deepEqual(store.load(), { preferences: { favorites: [], recentPaths: [] } });
  const sessionPath = path.join(directory, 'session.json');
  fs.writeFileSync(sessionPath, 'previous session');
  const value = { favorites: [{ path: 'D:\\한글 & 작업', label: '한글 즐겨찾기' }], recentPaths: ['D:\\한글 & 작업'] };
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
