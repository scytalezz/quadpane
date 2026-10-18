'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const directory = path.join(__dirname, 'native');
const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
const helpers = [
  { name: 'Quadpane.Shell.exe', source: 'ShellMenu.cs', target: 'exe',
    references: ['System.Windows.Forms.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll'] },
  { name: 'Quadpane.Directory.exe', source: 'DirectoryReader.cs', target: 'winexe',
    references: ['System.Web.Extensions.dll'] },
];
for (const helper of helpers) {
  const result = spawnSync(compiler, ['/nologo', `/target:${helper.target}`, '/platform:x64', '/optimize+',
    ...helper.references.map(reference => `/r:${reference}`),
    `/out:${path.join(directory, 'bin', helper.name)}`, path.join(directory, helper.source)],
  { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error(`Failed to build ${helper.name}: ${result.error?.message ||
      (result.signal ? `terminated by ${result.signal}` : `compiler exited with code ${result.status}`)}`);
    process.exit(result.status || 1);
  }
}
