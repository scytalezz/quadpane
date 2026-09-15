'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const project = path.resolve(__dirname, '..');
const files = ['app.js', 'theme.js', 'server.mjs', 'scripts/check.cjs'];
for (const directory of ['desktop', 'scripts/verification']) {
  for (const name of fs.readdirSync(path.join(project, directory))) {
    if (name.endsWith('.cjs')) files.push(`${directory}/${name}`);
  }
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { cwd: project, stdio: 'inherit', windowsHide: true });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
