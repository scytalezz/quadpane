const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
const { _electron } = dependencies('playwright');
const mouseMode=process.argv.includes('--mouse-drag');
const project = path.resolve(__dirname, '..', '..');
const executable = path.join(project, 'dist-portable', 'win-unpacked', 'Quadpane.exe');
const root = path.join(project, '.checks', 'explorer', `run-${Date.now()}`);
const source = path.join(root, '원본');
const target = path.join(root, '대상');
const nested = path.join(target, '안쪽 폴더');
const external = path.join(root, '외부 드롭');
const profile = path.join(root, 'profile');
for (const dir of [source, target, nested, external, path.join(profile, 'quadpane-data')]) fs.mkdirSync(dir, { recursive: true });
for (const [name, content] of [['alpha.txt','alpha bytes'], ['beta.txt','beta bytes'], ['drag-move.txt','move bytes'], ['drag-copy.txt','copy bytes'], ['folder-drop.txt','folder bytes'], ['rename-me.txt','rename bytes'], ['trash-me.txt','only this created fixture is trashed']]) fs.writeFileSync(path.join(source, name), content);
fs.writeFileSync(path.join(external, 'incoming.txt'), 'external file object');
const paneState = location => ({ path: location, sort: 'name', direction: 1 });
fs.writeFileSync(path.join(profile, 'quadpane-data', 'session.json'), JSON.stringify({ version: 1, workspaceId: 'design', workspaces: {
  design: { layout: 4, active: 0, panes: [source, target, source, external].map(paneState) },
  documents: { layout: 2, active: 0, panes: [target, source, external, nested].map(paneState) },
} }));
let application, page;
const errors = [], checks = [], geometries = [];
const panel = index => page.locator(`#panel-design-${index}`);
const row = (name, index = 0) => panel(index).locator('tr[data-file]').filter({ hasText: name });
const contextMenu = () => page.locator('#file-context-menu');
async function waitFor(check, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 80)); }
  throw new Error(`Timeout: ${label}`);
}
async function geometry(label) {
  const value = await page.evaluate(() => ({
    viewport: [innerWidth, innerHeight], document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    panels: [...document.querySelectorAll('.file-panel:not([hidden])')].map(element => { const rect = element.getBoundingClientRect(); return [rect.x,rect.y,rect.width,rect.height].map(number => Math.round(number * 100) / 100); }),
  }));
  value.window = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  geometries.push({ label, ...value }); return value;
}
async function rightClick(name, index = 0) { await row(name,index).click({ button: 'right' }); await contextMenu().waitFor(); }
async function menuAction(name) { await contextMenu().getByRole('menuitem', { name, exact: true }).click(); }
async function drag(name, destination, modifiers = []) {
  await page.waitForFunction(()=>document.querySelector('#activity-strip').getAttribute('aria-busy')==='false');
  if(mouseMode){
    await row(name).click();
    const start=row(name).locator('.file-name > span');
    await start.hover();
    for(const modifier of modifiers)await page.keyboard.down(modifier);
    await page.mouse.down();
    const box=await start.boundingBox();await page.mouse.move(box.x+box.width/2+8,box.y+box.height/2,{steps:2});
    await destination.hover();await destination.hover();await page.mouse.up();
    for(const modifier of [...modifiers].reverse())await page.keyboard.up(modifier);
    return;
  }
  // DOM mode isolates the renderer-to-filesystem flow from the mouse gesture.
  await row(name).evaluate((element, { target, modifiers }) => {
    const transfer=new DataTransfer();
    const init={bubbles:true,cancelable:true,dataTransfer:transfer,altKey:modifiers.includes('Alt'),ctrlKey:modifiers.includes('Control'),shiftKey:modifiers.includes('Shift')};
    element.dispatchEvent(new DragEvent('dragstart',init));
    if (!init.altKey) for(const type of ['dragenter','dragover','drop']) target.dispatchEvent(new DragEvent(type,init));
    element.dispatchEvent(new DragEvent('dragend',init));
  },{target:await destination.elementHandle(),modifiers});
}
(async () => {
  application = await _electron.launch({ executablePath: executable, args: ['--pane-smoke-test'], env: { ...process.env, PORTABLE_EXECUTABLE_DIR: profile }, timeout: 30000 });
  page = await application.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await row('alpha.txt').waitFor(); await row('안쪽 폴더',1).waitFor();
  // Observe the real IPC path without launching unrelated default apps or an OS drag loop.
  await application.evaluate(({ shell, BrowserWindow }) => {
    global.explorerShellCalls = [];
    shell.openPath = async pathname => { global.explorerShellCalls.push({ type: 'open', path: pathname }); return ''; };
    shell.showItemInFolder = pathname => global.explorerShellCalls.push({ type: 'reveal', path: pathname });
    BrowserWindow.getAllWindows()[0].webContents.startDrag = request => global.explorerShellCalls.push({ type: 'drag', paths: request.files });
  });
  const baseline = await geometry('idle');
  assert.equal(baseline.document[1], baseline.viewport[1]);
  await panel(1).locator('.file-scroll').click({ button: 'right', position: { x: 30, y: 120 } });
  await menuAction('탐색기에서 보기');
  await waitFor(async () => (await application.evaluate(() => global.explorerShellCalls)).some(call=>call.type==='reveal'&&call.path===target), 'background reveal IPC');
  await row('alpha.txt').click(); await row('beta.txt').click({ modifiers: ['Control'] });
  await rightClick('alpha.txt');
  assert.equal(await panel(0).locator('tr[aria-selected="true"]').count(), 2);
  await menuAction('복사');
  assert.deepEqual(await geometry('clipboard-ready'), baseline, 'Preparing copy must not move or resize panels/window');
  await panel(1).locator('.file-scroll').click({ button: 'right', position: { x: 30, y: 120 } });
  await menuAction('붙여넣기');
  assert.deepEqual(await geometry('copy-started'), baseline, 'Starting copy must not move or resize panels/window');
  await waitFor(() => fs.existsSync(path.join(target,'alpha.txt')) && fs.existsSync(path.join(target,'beta.txt')), 'context copy');
  await row('alpha.txt',1).waitFor();
  assert.equal(fs.readFileSync(path.join(target,'beta.txt'),'utf8'), 'beta bytes');
  assert.deepEqual(await geometry('copy-complete'), baseline, 'Completion must not move or resize panels/window');
  await page.locator('#operation-results-button').click();
  await page.locator('#transfer-result').waitFor();
  assert.deepEqual(await geometry('details-open'), baseline, 'Operation details must overlay without layout changes');
  await page.keyboard.press('Escape');
  checks.push('Right-click preserves multi-selection, real copy/paste works, window/panel geometry fixed through clipboard/busy/results');

  await row('alpha.txt').click(); await rightClick('alpha.txt'); await menuAction('이름 변경');
  await page.locator('#name-input').fill('beta.txt'); await page.locator('#name-confirm').click();
  await page.locator('#name-error').waitFor();
  assert.equal(fs.readFileSync(path.join(source,'alpha.txt'),'utf8'), 'alpha bytes');
  assert.equal(fs.readFileSync(path.join(source,'beta.txt'),'utf8'), 'beta bytes');
  await page.keyboard.press('Escape');
  await row('rename-me.txt').click(); await page.keyboard.press('F2');
  await page.locator('#name-input').fill('바꾼 이름.txt'); await page.locator('#name-confirm').click();
  await row('바꾼 이름.txt').waitFor();
  assert.ok(!fs.existsSync(path.join(source,'rename-me.txt')));
  assert.equal(fs.readFileSync(path.join(source,'바꾼 이름.txt'),'utf8'), 'rename bytes');
  await page.keyboard.press('Control+Shift+n');
  await page.locator('#name-input').fill('새 작업 폴더'); await page.locator('#name-confirm').click();
  await row('새 작업 폴더').waitFor(); assert.ok(fs.statSync(path.join(source,'새 작업 폴더')).isDirectory());
  assert.deepEqual(await geometry('rename-create-complete'), baseline);
  checks.push('F2 rename, rename collision preserves both originals, Ctrl+Shift+N creates actual folder without layout movement');

  await drag('alpha.txt', panel(1).locator('.file-scroll'), ['Alt']);
  await waitFor(async () => (await application.evaluate(() => global.explorerShellCalls)).some(call=>call.type==='drag'&&call.paths.includes(path.join(source,'alpha.txt'))), 'Alt native drag IPC');
  assert.equal(fs.readFileSync(path.join(source,'alpha.txt'),'utf8'), 'alpha bytes');
  checks.push(`Alt ${mouseMode?'mouse':'DOM'} drag reaches native startDrag with selected paths (OS drag call intercepted)`);

  await drag('drag-move.txt', panel(1).locator('.file-scroll'));
  await waitFor(() => fs.existsSync(path.join(target,'drag-move.txt')) && !fs.existsSync(path.join(source,'drag-move.txt')), 'same-drive drag move');
  await row('drag-move.txt',1).waitFor();
  await drag('drag-copy.txt', panel(1).locator('.file-scroll'), ['Control']);
  await waitFor(() => fs.existsSync(path.join(target,'drag-copy.txt')), 'Ctrl drag copy');
  assert.ok(fs.existsSync(path.join(source,'drag-copy.txt')));
  await row('drag-copy.txt',1).waitFor();
  await drag('folder-drop.txt', row('안쪽 폴더',1), ['Shift']);
  await waitFor(() => fs.existsSync(path.join(nested,'folder-drop.txt')) && !fs.existsSync(path.join(source,'folder-drop.txt')), 'drop into folder row');
  checks.push(`${mouseMode?'Mouse':'DOM'} drag/drop moves real files between same-drive panes, Ctrl forces copy, Shift moves into folder rows`);

  await page.evaluate(() => { const input=document.createElement('input'); input.type='file'; input.id='fixture-file-drop'; input.hidden=true; document.body.append(input); });
  await page.locator('#fixture-file-drop').setInputFiles(path.join(external,'incoming.txt'));
  const extracted = await page.evaluate(() => window.pane.droppedPaths([...document.querySelector('#fixture-file-drop').files]));
  assert.deepEqual(extracted,[path.join(external,'incoming.txt')]);
  await page.evaluate(() => {
    const transfer=new DataTransfer(); transfer.items.add(document.querySelector('#fixture-file-drop').files[0]);
    const destination=document.querySelector('#panel-design-1 .file-scroll');
    for (const type of ['dragenter','dragover','drop']) destination.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:transfer,ctrlKey:true}));
  });
  await waitFor(() => fs.existsSync(path.join(target,'incoming.txt')), 'native-backed external file drop');
  assert.equal(fs.readFileSync(path.join(target,'incoming.txt'),'utf8'),'external file object');
  assert.ok(fs.existsSync(path.join(external,'incoming.txt')));
  assert.deepEqual(await geometry('drag-complete'), baseline);
  checks.push('Real disk-backed File objects cross preload getPathForFile and copy via external drop path');

  await row('alpha.txt').dblclick();
  await waitFor(async () => (await application.evaluate(() => global.explorerShellCalls)).some(call=>call.type==='open'&&call.path.endsWith('alpha.txt')), 'default open IPC');
  await rightClick('alpha.txt'); await menuAction('탐색기에서 보기');
  await waitFor(async () => (await application.evaluate(() => global.explorerShellCalls)).some(call=>call.type==='reveal'), 'reveal IPC');
  await rightClick('alpha.txt'); await menuAction('파일 정보'); await page.locator('#info-dialog').waitFor(); await page.keyboard.press('Escape');
  checks.push('Double-click default-open and reveal reach Electron shell (test intercept), file info remains available');

  await row('trash-me.txt').click(); await page.keyboard.press('Delete');
  await page.locator('#trash-dialog').waitFor(); await page.locator('#trash-cancel').click();
  assert.ok(fs.existsSync(path.join(source,'trash-me.txt')));
  await rightClick('trash-me.txt'); await menuAction('삭제');
  await page.locator('#trash-confirm').click();
  await waitFor(() => !fs.existsSync(path.join(source,'trash-me.txt')), 'actual shell trash');
  await waitFor(async () => await row('trash-me.txt').count()===0,'trashed row refresh');
  assert.ok(fs.existsSync(path.join(source,'alpha.txt')));
  assert.deepEqual(await geometry('trash-complete'), baseline);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(root,'native-aria.txt'),await page.locator('body').ariaSnapshot());
  checks.push('Delete cancellation preserves file; confirmed real shell.trashItem removes only test fixture, no layout movement');
  await application.close(); application=undefined;
  const report={passed:true,root,mouseMode,checks,errors,geometries,asarSHA256:createHash('sha256').update(fs.readFileSync(path.join(project,'dist-portable/win-unpacked/resources/app.asar'))).digest('hex')};
  fs.writeFileSync(path.join(root,'result.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
})().catch(async error=>{
  fs.writeFileSync(path.join(root,'failure.json'),JSON.stringify({error:error.stack,checks,errors,geometries},null,2));
  console.error(error);
  if(page) fs.writeFileSync(path.join(root,'failure-aria.txt'),await page.locator('body').ariaSnapshot().catch(()=>''));
  await application?.close().catch(()=>{});
  fs.writeFileSync(path.join(root,'failure.json'),JSON.stringify({error:error.stack,checks,errors,geometries},null,2));
  process.exitCode=1;
});
