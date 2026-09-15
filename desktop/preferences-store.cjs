'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { normalizePath } = require('./filesystem.cjs');
const MAX_PREFERENCES_BYTES = 512 * 1024;

function invalidPreferences() {
  return Object.assign(new Error('즐겨찾기 설정 형식이 올바르지 않습니다.'), { code: 'INVALID_PREFERENCES' });
}

function validatePreferences(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || !Array.isArray(input.favorites) || input.favorites.length > 100
    || !Array.isArray(input.recentPaths) || input.recentPaths.length > 30) throw invalidPreferences();
  const favorites = [];
  const recentPaths = [];
  const favoriteKeys = new Set();
  const recentKeys = new Set();
  try {
    for (const item of input.favorites) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.label !== 'string'
        || !item.label.trim() || item.label.length > 120 || /[\u0000-\u001f]/u.test(item.label)) throw invalidPreferences();
      const itemPath = normalizePath(item.path);
      if (!favoriteKeys.has(itemPath.toLowerCase())) {
        favoriteKeys.add(itemPath.toLowerCase());
        favorites.push({ path: itemPath, label: item.label.trim() });
      }
    }
    for (const item of input.recentPaths) {
      const itemPath = normalizePath(item);
      if (!recentKeys.has(itemPath.toLowerCase())) {
        recentKeys.add(itemPath.toLowerCase());
        recentPaths.push(itemPath);
      }
    }
  } catch { throw invalidPreferences(); }
  const value = { favorites, recentPaths };
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PREFERENCES_BYTES) throw invalidPreferences();
  return value;
}

function createPreferencesStore(directory) {
  const filename = path.join(directory, 'preferences.json');
  return {
    load() {
      try {
        if (fs.statSync(filename).size > MAX_PREFERENCES_BYTES) throw invalidPreferences();
        return { preferences: validatePreferences(JSON.parse(fs.readFileSync(filename, 'utf8'))) };
      } catch (error) {
        return {
          preferences: { favorites: [], recentPaths: [] },
          ...(error.code === 'ENOENT' ? {} : { preferencesWarning: '즐겨찾기 설정을 읽을 수 없습니다. 새 즐겨찾기를 저장하면 설정을 다시 만듭니다.' }),
        };
      }
    },
    save(input) {
      const preferences = validatePreferences(input);
      const temporary = path.join(directory, `.preferences-${randomUUID()}.tmp`);
      let descriptor;
      try {
        fs.mkdirSync(directory, { recursive: true });
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, JSON.stringify(preferences), 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, filename);
      } catch {
        if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
        try { fs.unlinkSync(temporary); } catch {}
        throw Object.assign(new Error('즐겨찾기와 최근 경로를 저장하지 못했습니다. 설정 폴더의 쓰기 권한과 남은 공간을 확인해 주세요.'), { code: 'PREFERENCES_WRITE_FAILED' });
      }
      return preferences;
    },
  };
}

module.exports = { createPreferencesStore, validatePreferences, MAX_PREFERENCES_BYTES };
