'use strict';
const nodeFs = require('node:fs');
const path = require('node:path').win32;

// Windows root-relative paths (\foo.exe) depend on the current drive. Quoted
// paths are command lines, not executable paths, and must never reach relaunch.
function absolutePath(value) {
  return typeof value === 'string' && !/["\x00-\x1f]/.test(value)
    && /^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/i.test(path.normalize(value));
}

function samePath(left, right) {
  return path.normalize(left).replace(/\\+$/, '').toLowerCase()
    === path.normalize(right).replace(/\\+$/, '').toLowerCase();
}

function inside(directory, filename) {
  const relative = path.relative(directory, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\'));
}

function missing(fs, filename) {
  try { fs.statSync(filename); return false; }
  catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR'; }
}

/**
 * Prepare before constructing/showing BrowserWindow. All filesystem and shell
 * dependencies can be injected; no Electron import or work occurs at require.
 * Returns null for development, non-Windows, or untrustworthy launcher paths.
 * apply(window) is nonfatal and returns { applied, repaired }. Smoke runs never
 * inspect or change pins. An EXE fallback is shell metadata, not a window image.
 * retargetPins(nextExecutable) returns a migration count; call only after update
 * verification and successful relaunch scheduling, before quitting.
 */
function createTaskbarIntegration({
  isPackaged = false, platform = process.platform, env = process.env,
  execPath = process.execPath, portableDirectory = env.PORTABLE_EXECUTABLE_DIR,
  dataDirectory, iconSource, applicationId = 'com.quadpane.app', shell,
  smokeTest = false, pinnedDirectory, fs = nodeFs,
} = {}) {
  if (!isPackaged || platform !== 'win32') return null;
  const portable = portableDirectory !== undefined || [
    'PORTABLE_EXECUTABLE_FILE', 'PORTABLE_EXECUTABLE_DIR', 'PORTABLE_EXECUTABLE_APP_FILENAME',
  ].some(name => Object.hasOwn(env, name));
  const executablePath = portable ? env.PORTABLE_EXECUTABLE_FILE : execPath;
  if (!absolutePath(executablePath) || path.extname(executablePath).toLowerCase() !== '.exe') return null;
  // A partial/invalid portable environment must not fall back to the disposable
  // extracted process.execPath. Check both supplied and environment directories.
  for (const directory of [portableDirectory, env.PORTABLE_EXECUTABLE_DIR]) {
    if (directory !== undefined && (!absolutePath(directory) || !samePath(path.dirname(executablePath), directory))) return null;
  }
  try { if (!fs.statSync(executablePath).isFile()) return null; }
  catch { return null; }

  const extractionDirectory = portable && absolutePath(execPath) && !samePath(execPath, executablePath)
    ? path.dirname(execPath) : undefined;
  let iconPath = executablePath;
  let windowIcon;
  if (absolutePath(dataDirectory) && (!extractionDirectory || !inside(extractionDirectory, dataDirectory))) {
    const persistentIcon = path.join(dataDirectory, 'taskbar', 'quadpane.ico');
    try {
      const bytes = fs.readFileSync(iconSource);
      let existing;
      try { existing = fs.readFileSync(persistentIcon); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!existing || !bytes.equals(existing)) {
        fs.mkdirSync(path.dirname(persistentIcon), { recursive: true });
        fs.writeFileSync(persistentIcon, bytes);
      }
      iconPath = persistentIcon;
      windowIcon = persistentIcon;
    } catch { /* The validated original EXE also contains a persistent icon. */ }
  }
  const appDetails = {
    appId: applicationId, appIconPath: iconPath, appIconIndex: 0,
    relaunchCommand: `"${executablePath}"`, relaunchDisplayName: 'Quadpane',
  };

  function pinDirectory() {
    return pinnedDirectory ?? (absolutePath(env.APPDATA)
      ? path.join(env.APPDATA, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar') : undefined);
  }

  function repairPins() {
    if (smokeTest || !shell?.readShortcutLink || !shell?.writeShortcutLink) return 0;
    const directory = pinDirectory();
    if (!absolutePath(directory)) return 0;
    let entries;
    try { entries = fs.readdirSync(directory); }
    catch { return 0; }
    let repaired = 0;
    for (const name of entries) {
      if (path.extname(name).toLowerCase() !== '.lnk') continue;
      try {
        const filename = path.join(directory, name);
        const link = shell.readShortcutLink(filename);
        // Never infer ownership from a filename. Electron can throw while
        // resolving a damaged link; that link must remain untouched.
        if (link.appUserModelId !== applicationId || typeof link.target !== 'string') continue;
        const currentExtraction = extractionDirectory && absolutePath(link.target) && samePath(link.target, execPath);
        if (link.target !== '' && !currentExtraction
          && !(absolutePath(link.target) && missing(fs, link.target))) continue;
        const changes = { target: executablePath, icon: iconPath, iconIndex: 0 };
        if (!link.cwd || (absolutePath(link.cwd) && (missing(fs, link.cwd)
          || (extractionDirectory && samePath(link.cwd, extractionDirectory))))) {
          changes.cwd = path.dirname(executablePath);
        }
        // Update only these fields: args, flags, app ID, descriptions and other
        // shortcut properties remain intact. Never create/replace a pin.
        if (shell.writeShortcutLink(filename, 'update', changes)) repaired++;
      } catch { /* Pin repair must never prevent the application opening. */ }
    }
    return repaired;
  }

  function retargetPins(nextExecutable) {
    if (smokeTest || !shell?.readShortcutLink || !shell?.writeShortcutLink) return 0;
    if (!absolutePath(nextExecutable) || path.extname(nextExecutable).toLowerCase() !== '.exe'
      || samePath(nextExecutable, executablePath)
      || !samePath(path.dirname(nextExecutable), path.dirname(executablePath))) return 0;
    try { if (!fs.statSync(nextExecutable).isFile()) return 0; }
    catch { return 0; }

    const directory = pinDirectory();
    if (!absolutePath(directory)) return 0;
    let entries;
    try { entries = fs.readdirSync(directory); }
    catch { return 0; }
    let migrated = 0;
    for (const name of entries) {
      if (path.extname(name).toLowerCase() !== '.lnk') continue;
      try {
        const filename = path.join(directory, name);
        const link = shell.readShortcutLink(filename);
        // An explicit update migrates only pins targeting this original launcher.
        // Broken/extracted targets belong exclusively to startup repair.
        if (link.appUserModelId !== applicationId || !absolutePath(link.target)
          || !samePath(link.target, executablePath)) continue;
        const changes = { target: nextExecutable, icon: windowIcon || nextExecutable, iconIndex: 0 };
        if (!link.cwd || (absolutePath(link.cwd) && (samePath(link.cwd, path.dirname(executablePath))
          || (extractionDirectory && samePath(link.cwd, extractionDirectory)) || missing(fs, link.cwd)))) {
          changes.cwd = path.dirname(nextExecutable);
        }
        // Keep custom properties and the old EXE; never create or replace pins.
        if (shell.writeShortcutLink(filename, 'update', changes)) migrated++;
      } catch { /* Pin migration must never prevent the scheduled restart. */ }
    }
    return migrated;
  }

  return {
    executablePath, iconPath, windowIcon, appDetails, retargetPins,
    apply(window) {
      let applied = false;
      try { window.setAppDetails(appDetails); applied = true; }
      catch { /* Older/unavailable shell metadata must not block startup. */ }
      return { applied, repaired: repairPins() };
    },
  };
}

module.exports = { createTaskbarIntegration };
