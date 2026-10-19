'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const REPOSITORY = 'https://github.com/scytalezz/quadpane';
const LATEST_URL = 'https://api.github.com/repos/scytalezz/quadpane/releases/latest';
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_CHECKSUM_BYTES = 64 * 1024;
const CHECK_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const CDN_HOSTS = new Set([
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
]);

function failure(code, message) {
  return Object.assign(new Error(message), { code, updateError: true });
}

function invalidRelease() {
  return failure('INVALID_RELEASE', '업데이트 정보가 올바르지 않습니다. GitHub 릴리스를 확인해 주세요.');
}

function versionParts(version) {
  if (typeof version !== 'string' || version.length > 29
    || !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(version)) {
    throw invalidRelease();
  }
  return version.split('.').map(Number);
}

function newerVersion(candidate, current) {
  const a = versionParts(candidate);
  const b = versionParts(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function releaseMetadata(release, currentVersion) {
  if (!release || typeof release !== 'object' || Array.isArray(release)
    || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') throw invalidRelease();
  if (release.draft || release.prerelease) return null;
  if (typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) throw invalidRelease();
  const version = release.tag_name.slice(1);
  versionParts(version);
  const releaseUrl = `${REPOSITORY}/releases/tag/v${version}`;
  if (release.html_url !== releaseUrl) throw invalidRelease();
  if (!newerVersion(version, currentVersion)) return null;
  if (!Array.isArray(release.assets) || release.assets.length > 100) throw invalidRelease();
  const filename = `quadpane-${version}-portable-x64.exe`;
  const names = new Set();
  for (const asset of release.assets) {
    if (!asset || typeof asset.name !== 'string' || asset.name.length > 255 || names.has(asset.name)) {
      throw invalidRelease();
    }
    names.add(asset.name);
  }
  function select(name, limit) {
    const asset = release.assets.find((entry) => entry.name === name);
    const url = `${REPOSITORY}/releases/download/v${version}/${name}`;
    if (!asset || asset.browser_download_url !== url || !Number.isSafeInteger(asset.size)
      || asset.size < 1 || asset.size > limit) throw invalidRelease();
    return { url, size: asset.size };
  }
  return {
    version, releaseUrl, filename,
    executable: select(filename, MAX_DOWNLOAD_BYTES),
    checksum: select('SHA256SUMS.txt', MAX_CHECKSUM_BYTES),
  };
}

function validateDownloadUrl(value, original) {
  let url;
  try { url = new URL(value); } catch { throw invalidRelease(); }
  // Check the raw authority too: URL.port normalizes an explicit :443 away.
  const authority = /^https:\/\/([^/?#]+)/.exec(value)?.[1];
  if (value.length > 8192 || url.protocol !== 'https:' || authority !== url.hostname
    || url.username || url.password || url.port || url.hash || /[\s\\]/u.test(value)
    || (value !== original && !CDN_HOSTS.has(url.hostname))) throw invalidRelease();
  return url.href;
}

function abortable(promise, signal) {
  // The operation may already have produced a rejected read before cancellation
  // is observed (for example while the preceding chunk was written to disk).
  const observed = Promise.resolve(promise);
  if (signal.aborted) {
    observed.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    observed.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

function cancelBody(response) {
  try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
}

async function request(fetchFn, original, signal, api = false) {
  let url = original;
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    if (!api) validateDownloadUrl(url, original);
    const response = await abortable(fetchFn(url, {
      method: 'GET', redirect: 'manual', signal, credentials: 'omit',
      headers: api ? {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Quadpane-Updater',
      } : { Accept: 'application/octet-stream', 'User-Agent': 'Quadpane-Updater' },
    }), signal);
    // A fetch adapter must honor manual redirects, including the first hop.
    if (response.redirected || (response.url && response.url !== url)) {
      cancelBody(response);
      throw invalidRelease();
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      cancelBody(response);
      if (api || redirects === 5 || typeof location !== 'string') throw invalidRelease();
      validateDownloadUrl(location, original);
      url = location;
      continue;
    }
    if (api && response.status === 404) { cancelBody(response); return null; }
    if (response.status !== 200) {
      cancelBody(response);
      throw failure('HTTP_ERROR', '업데이트 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
    return response;
  }
  throw invalidRelease();
}

async function consume(response, limit, signal, onChunk, expectedSize) {
  const header = response.headers.get('content-length');
  if (header !== null && (!/^[0-9]{1,10}$/.test(header) || Number(header) > limit
    || (expectedSize !== undefined && Number(header) !== expectedSize))) {
    cancelBody(response);
    throw failure('SIZE_MISMATCH', '업데이트 파일 크기가 올바르지 않습니다. 다시 다운로드해 주세요.');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw invalidRelease();
  const reader = response.body.getReader();
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > limit || (expectedSize !== undefined && total > expectedSize)) {
        throw failure('SIZE_MISMATCH', '업데이트 파일 크기가 올바르지 않습니다. 다시 다운로드해 주세요.');
      }
      await onChunk(value, total);
    }
    if (expectedSize !== undefined && total !== expectedSize) {
      throw failure('SIZE_MISMATCH', '다운로드가 불완전합니다. 다시 다운로드해 주세요.');
    }
    complete = true;
  } finally {
    if (!complete) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} }
    try { reader.releaseLock(); } catch {}
  }
}

async function readText(response, limit, signal, expectedSize) {
  const chunks = [];
  await consume(response, limit, signal, (chunk) => { chunks.push(Buffer.from(chunk)); }, expectedSize);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw invalidRelease(); }
}

function checksumFor(text, filename) {
  let selected;
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([a-fA-F0-9]{64}) [ *]([^\r\n]+)$/.exec(line);
    if (!match || names.has(match[2])) throw invalidRelease();
    names.add(match[2]);
    if (match[2] === filename) selected = match[1].toLowerCase();
  }
  if (!selected) throw invalidRelease();
  return selected;
}

async function verifyFile(filename, metadata, checksum, signal) {
  // Refuse symlinks and directories, even if their target happens to hash correctly.
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.size !== metadata.executable.size) return false;
  const file = await fs.open(filename, 'r');
  try {
    const opened = await file.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile()) return false;
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > metadata.executable.size || total > MAX_DOWNLOAD_BYTES) return false;
      hash.update(buffer.subarray(0, bytesRead));
    }
    signal.throwIfAborted();
    const after = await fs.lstat(filename);
    return after.isFile() && after.ino === opened.ino && after.dev === opened.dev
      && after.size === total && total === metadata.executable.size && hash.digest('hex') === checksum;
  } finally { await file.close(); }
}

async function copyVerifiedFile(stagePath, finalPath, metadata, checksum, signal) {
  let source;
  let destination;
  let owned;
  let complete = false;
  try {
    signal.throwIfAborted();
    source = await fs.open(stagePath, 'r');
    // exFAT/FAT cannot hard-link. Exclusive creation still protects existing files.
    destination = await fs.open(finalPath, 'wx', 0o600);
    owned = await destination.stat();
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > metadata.executable.size) throw invalidRelease();
      await destination.writeFile(buffer.subarray(0, bytesRead));
    }
    if (total !== metadata.executable.size) throw invalidRelease();
    await destination.sync();
    await destination.close();
    destination = null;
    if (!await verifyFile(finalPath, metadata, checksum, signal)) {
      throw failure('CHECKSUM_MISMATCH', '업데이트 파일 검증에 실패했습니다. 다시 다운로드해 주세요.');
    }
    signal.throwIfAborted();
    complete = true;
  } finally {
    try { if (source) await source.close(); }
    finally {
      try { if (destination) await destination.close(); }
      finally {
        // Only our successfully created file may be removed, never an EEXIST winner.
        if (owned && !complete) {
          try {
            const current = await fs.lstat(finalPath);
            if (current.isFile() && current.ino === owned.ino && current.dev === owned.dev) await fs.unlink(finalPath);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    }
  }
}

function createUpdateService({ currentVersion, portableDirectory, enabled, fetch: fetchFn, onChange } = {}) {
  versionParts(currentVersion);
  // The main process supplies enabled only for packaged Win x64 portable builds.
  const supported = enabled === true && typeof portableDirectory === 'string' && path.isAbsolute(portableDirectory)
    && typeof fetchFn === 'function';
  let state = {
    currentVersion, status: supported ? 'idle' : 'unsupported', latestVersion: null, progress: null,
    message: supported ? '업데이트를 확인할 수 있습니다.' : 'Windows x64 포터블 버전에서 업데이트할 수 있습니다.',
    releaseUrl: null,
  };
  let metadata = null;
  let ready = null;
  let closed = false;
  let checkFlight = null;
  let downloadFlight = null;
  let verifyFlight = null;
  const controllers = new Set();
  const getState = () => ({ ...state });
  function publish(patch) {
    if (closed) return;
    state = { ...state, ...patch };
    try { onChange?.(getState()); } catch { /* A UI subscriber cannot break a download. */ }
  }
  function report(error) {
    let message = error?.updateError ? error.message : '업데이트를 확인하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.';
    if (['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EXDEV', 'ENOTSUP'].includes(error?.code)) {
      message = '업데이트를 저장하지 못했습니다. 포터블 폴더 권한과 남은 공간을 확인해 주세요.';
    }
    publish({ status: 'error', progress: null, message });
    return getState();
  }
  async function operation(timeout, work) {
    const controller = new AbortController();
    controllers.add(controller);
    if (closed) controller.abort(failure('CLOSED', '업데이트 작업이 종료되었습니다.'));
    const timer = setTimeout(() => controller.abort(failure('TIMEOUT', '업데이트 응답 시간이 초과되었습니다. 다시 시도해 주세요.')), timeout);
    timer.unref?.();
    try { controller.signal.throwIfAborted(); return await work(controller.signal); }
    finally { clearTimeout(timer); controllers.delete(controller); }
  }

  function check() {
    if (downloadFlight) return downloadFlight;
    if (checkFlight) return checkFlight;
    if (closed || !supported || state.status === 'ready') return Promise.resolve(getState());
    checkFlight = Promise.resolve().then(() => operation(CHECK_TIMEOUT_MS, async (signal) => {
      metadata = null;
      publish({ status: 'checking', progress: null, latestVersion: null, releaseUrl: null, message: '업데이트를 확인하고 있습니다.' });
      const response = await request(fetchFn, LATEST_URL, signal, true);
      let release = null;
      if (response) {
        const text = await readText(response, MAX_JSON_BYTES, signal);
        try { release = JSON.parse(text); } catch { throw invalidRelease(); }
      }
      signal.throwIfAborted();
      metadata = response ? releaseMetadata(release, currentVersion) : null;
      publish(metadata ? {
        status: 'available', latestVersion: metadata.version, releaseUrl: metadata.releaseUrl,
        message: `새 버전 ${metadata.version}을 다운로드할 수 있습니다.`,
      } : { status: 'current', message: '사용 가능한 새 정식 버전이 없습니다.' });
      return getState();
    })).catch(report).finally(() => { checkFlight = null; });
    return checkFlight;
  }

  function download() {
    if (downloadFlight) return downloadFlight;
    if (closed || !supported || state.status === 'ready') return Promise.resolve(getState());
    const pendingCheck = checkFlight;
    downloadFlight = Promise.resolve().then(async () => {
      if (pendingCheck) await pendingCheck;
      return operation(DOWNLOAD_TIMEOUT_MS, async (signal) => {
        if (!metadata) throw failure('CHECK_REQUIRED', '먼저 업데이트를 확인해 주세요.');
        const selected = metadata;
        const finalPath = path.join(portableDirectory, selected.filename);
        publish({ status: 'downloading', progress: 0, message: '업데이트를 다운로드하고 있습니다.' });
        const sumsResponse = await request(fetchFn, selected.checksum.url, signal);
        const sums = await readText(sumsResponse, MAX_CHECKSUM_BYTES, signal, selected.checksum.size);
        const checksum = checksumFor(sums, selected.filename);
        async function existingMatches() {
          try {
            if (await verifyFile(finalPath, selected, checksum, signal)) return true;
          } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
          throw failure('FILE_CONFLICT', '같은 이름의 다른 파일이 있습니다. 해당 파일을 옮긴 뒤 다시 시도해 주세요.');
        }
        if (!await existingMatches()) {
          signal.throwIfAborted();
          const stageDirectory = await fs.mkdtemp(path.join(portableDirectory, '.quadpane-update-'));
          const stagePath = path.join(stageDirectory, selected.filename);
          let file;
          try {
            file = await fs.open(stagePath, 'wx', 0o600);
            const response = await request(fetchFn, selected.executable.url, signal);
            const hash = createHash('sha256');
            await consume(response, MAX_DOWNLOAD_BYTES, signal, async (chunk, total) => {
              await file.writeFile(chunk);
              hash.update(chunk);
              const progress = Math.floor(total * 100 / selected.executable.size);
              if (progress !== state.progress) publish({ progress });
            }, selected.executable.size);
            if (hash.digest('hex') !== checksum) {
              throw failure('CHECKSUM_MISMATCH', '업데이트 파일 검증에 실패했습니다. 다시 다운로드해 주세요.');
            }
            await file.sync();
            await file.close();
            file = null;
            signal.throwIfAborted();
            try {
              try { await fs.link(stagePath, finalPath); }
              catch (error) {
                if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) throw error;
                await copyVerifiedFile(stagePath, finalPath, selected, checksum, signal);
              }
            }
            catch (error) {
              if (error.code !== 'EEXIST') throw error;
              if (!await existingMatches()) throw failure('FILE_CONFLICT', '업데이트 파일이 변경되었습니다. 다시 시도해 주세요.');
            }
          } finally {
            try { if (file) await file.close(); }
            finally {
              try { await fs.unlink(stagePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
              await fs.rmdir(stageDirectory);
            }
          }
        }
        signal.throwIfAborted();
        ready = { path: finalPath, metadata: selected, checksum };
        publish({ status: 'ready', progress: 100, message: '업데이트가 준비되었습니다. 적용하려면 다시 시작해 주세요.' });
        return getState();
      });
    }).catch(report).finally(() => { downloadFlight = null; });
    return downloadFlight;
  }

  function verifyReady() {
    if (verifyFlight) return verifyFlight;
    verifyFlight = Promise.resolve().then(async () => {
      if (downloadFlight) await downloadFlight;
      return operation(DOWNLOAD_TIMEOUT_MS, async (signal) => {
        if (!ready || state.status !== 'ready') throw failure('NOT_READY', '먼저 업데이트를 다운로드해 주세요.');
        let valid = false;
        try { valid = await verifyFile(ready.path, ready.metadata, ready.checksum, signal); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!valid) throw failure('FILE_CHANGED', '업데이트 파일이 변경되었습니다. 파일을 옮긴 뒤 다시 다운로드해 주세요.');
        signal.throwIfAborted();
        return ready.path;
      });
    }).catch((error) => {
      ready = null;
      report(error);
      throw error?.updateError ? error : failure('VERIFY_FAILED', '업데이트 파일을 확인하지 못했습니다. 다시 다운로드해 주세요.');
    }).finally(() => { verifyFlight = null; });
    return verifyFlight;
  }

  function close() {
    closed = true;
    for (const controller of controllers) controller.abort(failure('CLOSED', '업데이트 작업이 종료되었습니다.'));
    return Promise.allSettled([checkFlight, downloadFlight, verifyFlight]).then(() => undefined);
  }

  return { getState, check, download, verifyReady, close };
}

module.exports = { createUpdateService, MAX_DOWNLOAD_BYTES, CHECK_TIMEOUT_MS };
