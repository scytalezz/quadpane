'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const directory = path.join(__dirname, 'native');
const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
const result = spawnSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+',
  '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll',
  `/out:${path.join(directory, 'bin', 'Quadpane.Shell.exe')}`, path.join(directory, 'ShellMenu.cs')],
{ stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
