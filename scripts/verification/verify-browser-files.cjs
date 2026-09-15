const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const dependencies = process.argv[2] ? createRequire(path.join(path.resolve(process.argv[2]), 'package.json')) : require;
const { chromium } = dependencies('playwright');
const project = path.resolve(__dirname, '..', '..');
const root = path.join(project, '.checks', 'browser-files', `run-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });
const passed = [];
let browser;
const errors = [];
const url = 'http://127.0.0.1:4173/';
const panel = page => page.locator('#panel-design-0');
const address = (page, n = 1) => page.getByRole('textbox', { name: `${n}번 패널 폴더 경로`, exact: true });
const geometry = page => page.evaluate(() => ({
  viewport: [innerWidth, innerHeight], document: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
  panels: [...document.querySelectorAll('.file-panel:not([hidden])')].map(element => { const r=element.getBoundingClientRect();return [r.x,r.y,r.width,r.height]; }),
}));
async function fixtureBridge(context) {
  await context.addInitScript(() => {
    const fixturePath = 'C:\\UI fixture';
    const config = location => ({ path: location, sort: 'name', direction: 1 });
    const session = { version: 1, workspaceId: 'design', workspaces: {
      design: { layout: 4, active: 0, panes: [fixturePath, fixturePath, fixturePath, fixturePath].map(config) },
      documents: { layout: 2, active: 0, panes: [fixturePath, fixturePath, fixturePath, fixturePath].map(config) },
    } };
    const entry = (name, size, modified) => ({ path: `${fixturePath}\\${name}`, name, type: 'file', size, modified });
    const base = [
      { path: `${fixturePath}\\하위 폴더`, name: '하위 폴더', type: 'folder', size: null, modified: '2024-01-01T00:00:00Z' },
      entry("client's & report.txt", 1234, '2024-05-06T12:34:56Z'),
      entry('report.constructor', 4, '2023-02-01T00:00:00Z'),
      entry('report.__proto__', 23, '2025-04-03T00:00:00Z'),
      entry('quarterly-results-with-a-very-long-name.xlsx', 23456, '2024-07-01T00:00:00Z'),
    ];
    window.testSaves = [];
    window.pane = {
      bootstrap: async () => ({ ok: true, value: { drives: [{ path: 'C:\\', label: 'C:' }], favorites: [{ id: 'home', label: '홈', path: fixturePath, icon: 'home' }], session, preferences: { favorites: [{ path: 'C:\\저장한 폴더', label: '저장한 폴더' }], recentPaths: ['C:\\최근 폴더'] } } }),
      listDirectory: async location => {
        await new Promise(resolve => setTimeout(resolve, location.includes('slow') ? 700 : 10));
        if (location.includes('missing')) return { ok: false, error: { code: 'ENOENT', message: '폴더를 찾을 수 없습니다.' } };
        return { ok: true, value: { path: location, name: location.split('\\').pop() || location, parent: 'C:\\', breadcrumbs: [], entries: location === fixturePath ? base : [entry(`${location.split('\\').pop()}.txt`, 55, '2024-05-06T12:34:56Z')] } };
      },
      saveSession: async saved => { window.testSaves.push(structuredClone(saved)); return { ok: true, value: null }; },
      savePreferences: async preferences => ({ ok: true, value: preferences }),
      transfer: async request => ({ ok: true, value: { operation: request.operation, completed: [], skipped: request.sources.map(source => ({ source, code: 'EXISTS', message: '같은 이름의 파일이 있습니다.' })), failed: [] } }),
      openPath: async () => ({ ok: true, value: null }),
      revealPath: async () => ({ ok: true, value: null }),
      renameItem: async () => ({ ok: false, error: { code: 'EEXIST', message: '같은 이름의 항목이 있습니다.' } }),
      createFolder: async () => ({ ok: false, error: { code: 'EEXIST', message: '같은 이름의 항목이 있습니다.' } }),
      trashItems: async () => ({ ok: true, value: { operation: 'trash', completed: [], skipped: [], failed: [] } }),
      droppedPaths: () => [],
    };
  });
}
(async () => {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const noBridge = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  let page = await noBridge.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByRole('heading', { name: 'PC 파일을 탐색하려면 포터블 앱에서 실행하세요', exact: true }).waitFor();
  assert.equal(await page.locator('[data-drive]').count(), 0);
  assert.equal(await page.locator('tr[data-file]').count(), 0);
  assert.equal(await page.getByRole('button', { name: '4분할', exact: true }).isDisabled(), true);
  await page.screenshot({ path: path.join(root, 'browser-no-bridge.png') });
  await noBridge.close();
  passed.push('Unmodified browser has no fake files/drives and clearly requires native app');

  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: 'light' });
  await fixtureBridge(context);
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await panel(page).getByText('report.__proto__', { exact: true }).waitFor();
  assert.equal(await page.locator('.file-panel:visible').count(), 4);
  assert.equal(await panel(page).locator('tr[data-file]').count(), 5);
  await page.screenshot({ path: path.join(root, 'light-desktop.png') });
  await page.getByRole('button', { name: '다크 모드', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.reload();
  await panel(page).getByText('report.__proto__', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await page.screenshot({ path: path.join(root, 'dark-desktop.png') });
  const readability = await panel(page).locator('tr[data-file]').first().evaluate(row => {
    const rgb = text => text.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = color => rgb(color).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const background = getComputedStyle(row.closest('.file-panel')).backgroundColor;
    const contrast = element => { const a = luminance(getComputedStyle(element).color); const b = luminance(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05); };
    return { rowHeight: row.getBoundingClientRect().height, filenameContrast: contrast(row.cells[0]), metadataContrast: contrast(row.cells[1]), icon: row.querySelector('svg').getBoundingClientRect().width, microGlyphCount: document.querySelectorAll('.file-svg text').length };
  });
  assert.ok(readability.rowHeight <= 28 && readability.rowHeight >= 26, `Row density: ${JSON.stringify(readability)}`);
  assert.ok(readability.filenameContrast >= 7 && readability.metadataContrast >= 7, `Contrast: ${JSON.stringify(readability)}`);
  assert.ok(readability.icon >= 17);
  assert.equal(readability.microGlyphCount, 0);
  await panel(page).locator('.path-dropdown-toggle').click();
  await page.locator('.address-menu:visible').waitFor();
  await page.screenshot({ path: path.join(root, 'dark-dropdown.png') });
  await page.keyboard.press('Escape');
  passed.push(`Compact ${readability.rowHeight}px rows, dark text contrast >=7:1 and readable icons without tiny text`);
  await panel(page).getByRole('button', { name: '수정한 날짜순 정렬', exact: true }).click();
  const namesByDate = await panel(page).locator('tr[data-file] .file-name > span').allTextContents();
  assert.deepEqual(namesByDate, ['하위 폴더', 'report.constructor', "client's & report.txt", 'quarterly-results-with-a-very-long-name.xlsx', 'report.__proto__']);
  await panel(page).getByRole('button', { name: '크기순 정렬', exact: true }).click();
  const namesBySize = await panel(page).locator('tr[data-file] .file-name > span').allTextContents();
  assert.deepEqual(namesBySize, ['하위 폴더', 'report.constructor', 'report.__proto__', "client's & report.txt", 'quarterly-results-with-a-very-long-name.xlsx']);
  for (const width of [1024, 760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, `Vertical overflow at ${width}`);
    assert.equal(await panel(page).locator('time').count(), 5);
    const visibleDateColumn = await panel(page).locator('th').nth(1).evaluate(element => getComputedStyle(element).display !== 'none');
    assert.equal(visibleDateColumn, true);
    await page.screenshot({ path: path.join(root, `dark-${width}.png`), fullPage: true });
  }
  passed.push('Dark/light persistence, modification date and numeric size sorting, responsive layouts with dates');
  await page.setViewportSize({ width: 1440, height: 960 });
  await address(page).fill('C:\\slow-one');
  await address(page).press('Enter');
  await address(page, 2).fill('아직 입력 중인 경로');
  await panel(page).getByText('slow-one.txt', { exact: true }).waitFor();
  assert.equal(await address(page, 2).inputValue(), '아직 입력 중인 경로');
  await address(page).fill('C:\\slow-old');
  await address(page).press('Enter');
  await address(page).fill('C:\\latest');
  await address(page).press('Enter');
  await panel(page).getByText('latest.txt', { exact: true }).waitFor();
  await page.waitForTimeout(850); // Deliberately wait for stale response in this race test.
  assert.equal(await address(page).inputValue(), 'C:\\latest');
  assert.equal(await panel(page).getByText('slow-old.txt', { exact: true }).count(), 0);
  await address(page).fill('C:\\missing');
  await address(page).press('Enter');
  await panel(page).getByText('폴더를 찾을 수 없습니다.', { exact: false }).waitFor();
  assert.equal(await address(page).inputValue(), 'C:\\latest');
  const saves = await page.evaluate(() => window.testSaves);
  assert.equal(saves.at(-1).workspaces.design.panes[0].path, 'C:\\latest');
  assert.ok(saves.every(saved => saved.workspaces.design.panes[0].path !== 'C:\\slow-old'));
  passed.push('Cross-pane address drafts survive async loads, stale responses ignored, failed navigation never saved');
  await address(page).fill('C:\\UI fixture'); await address(page).press('Enter');
  await panel(page).getByText("client's & report.txt", { exact: true }).waitFor();
  await page.setViewportSize({ width: 760, height: 540 });
  const fixed = await geometry(page);
  assert.deepEqual(fixed.document, fixed.viewport);
  await panel(page).locator('tr[data-file]').filter({ hasText: "client's & report.txt" }).click({button:'right'});
  await page.locator('#file-context-menu').waitFor();
  assert.deepEqual(await geometry(page), fixed, 'Context menu geometry');
  await page.screenshot({path:path.join(root,'dark-context-menu-760x540.png')});
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.pane.transfer = request => new Promise(resolve => { window.pendingTransferRequest = request; window.finishTestTransfer = resolve; }); });
  await panel(page).locator('tr[data-file]').filter({ hasText: "client's & report.txt" }).click();
  await page.locator('#copy-button').click();
  assert.deepEqual(await geometry(page), fixed, 'Clipboard ready geometry');
  await page.locator('#panel-design-1 .panel-tab-label').click();
  await page.locator('#paste-button').click();
  await page.waitForFunction(() => typeof window.finishTestTransfer === 'function');
  assert.deepEqual(await geometry(page), fixed, 'Busy transfer geometry');
  await page.screenshot({path:path.join(root,'dark-copy-pending-760x540.png')});
  await address(page, 2).fill('C:\\slow-race-destination'); await address(page, 2).press('Enter');
  await page.evaluate(() => window.finishTestTransfer({ ok: true, value: { operation: 'copy', completed: window.pendingTransferRequest.sources.map(source => ({ source, destination: `${window.pendingTransferRequest.destination}\\copied.txt` })), skipped: [], failed: [] } }));
  await page.locator('#panel-design-1').getByText('slow-race-destination.txt', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#panel-design-1').getAttribute('aria-busy') === 'false');
  assert.equal(await address(page, 2).inputValue(), 'C:\\slow-race-destination');
  assert.deepEqual(await geometry(page), fixed, 'Transfer completion geometry');
  await page.locator('#operation-results-button').click();
  await page.locator('#transfer-result').waitFor();
  assert.deepEqual(await geometry(page), fixed, 'Result popover geometry');
  await page.screenshot({path:path.join(root,'dark-copy-details-760x540.png')});
  await page.keyboard.press('Escape');
  passed.push('760x540 document and panel geometry identical before/after context menu, clipboard, pending transfer, completion and result popover');
  passed.push('Transfer completion refresh never cancels newer in-flight destination navigation');
  await page.evaluate(() => {
    window.partialRequests = [];
    window.pane.transfer = async request => {
      window.partialRequests.push(structuredClone(request));
      return { ok: true, value: { operation: request.operation, completed: [{ source: request.sources[0], destination: `${request.destination}\\moved.txt` }], skipped: request.sources.slice(1).map(source => ({ source, code: 'EEXIST', message: '대상에 같은 이름의 항목이 있어 건너뛰었습니다.' })), failed: [] } };
    };
  });
  await panel(page).locator('tr[data-file]').filter({ hasText: "client's & report.txt" }).click();
  await panel(page).locator('tr[data-file]').filter({ hasText: 'report.constructor' }).click({ modifiers: ['Control'] });
  await page.locator('#cut-button').click();
  await page.locator('#panel-design-1 .panel-tab-label').click();
  await page.locator('#paste-button').click();
  await page.waitForFunction(() => window.partialRequests.length === 1 && !document.querySelector('#paste-button').disabled);
  await page.locator('#paste-button').click();
  await page.waitForFunction(() => window.partialRequests.length === 2);
  const partialRequests = await page.evaluate(() => window.partialRequests);
  assert.equal(partialRequests[0].sources.length, 2);
  assert.deepEqual(partialRequests[1].sources, [partialRequests[0].sources[1]]);
  passed.push('Partial cut/paste retries retain only skipped items, never repeat already completed moves');
  await page.waitForFunction(() => document.querySelector('#activity-strip').getAttribute('aria-busy') === 'false');
  await page.setViewportSize({width:1440,height:960});
  await address(page,2).fill('C:\\Drag target');await address(page,2).press('Enter');
  await page.locator('#panel-design-1').getByText('Drag target.txt',{exact:true}).waitFor();
  await page.evaluate(() => {
    window.dragRequests=[];
    window.dragEvents=[];
    for(const type of ['dragstart','dragenter','dragover','drop','dragend']) document.addEventListener(type,event=>{
      window.dragEvents.push({type,target:event.target.tagName,className:event.target.className,file:event.target.closest('[data-file]')?.innerText,types:[...event.dataTransfer.types],prevented:event.defaultPrevented,x:event.clientX,y:event.clientY,ctrl:event.ctrlKey,shift:event.shiftKey});
    });
    window.pane.transfer=async request=>{window.dragRequests.push(structuredClone(request));return {ok:true,value:{operation:request.operation,completed:[],skipped:[],failed:[]}};};
  });
  const draggable=panel(page).locator('tr[data-file]').filter({hasText:"client's & report.txt"});
  const mouseDrag=async (destination,modifier,expected,start=draggable)=>{
    await draggable.click();
    const count=await page.evaluate(()=>window.dragRequests.length);
    if(modifier)await page.keyboard.down(modifier);
    await start.hover(); await page.mouse.down();
    await destination.hover(); await destination.hover(); await page.mouse.up();
    if(modifier)await page.keyboard.up(modifier);
    fs.writeFileSync(path.join(root,`mouse-drag-${count}.json`),JSON.stringify(await page.evaluate(()=>({requests:window.dragRequests,events:window.dragEvents})),null,2));
    await page.waitForFunction(count=>window.dragRequests.length===count+1,count);
    await page.waitForFunction(()=>document.querySelector('#activity-strip').getAttribute('aria-busy')==='false');
    assert.equal((await page.evaluate(()=>window.dragRequests.at(-1))).operation,expected);
  };
  await mouseDrag(page.locator('#panel-design-1 .file-scroll'),null,'move');
  await mouseDrag(page.locator('#panel-design-1 .file-scroll'),'Control','copy');
  await address(page,2).fill('C:\\UI fixture');await address(page,2).press('Enter');
  await page.locator('#panel-design-1').getByText('하위 폴더',{exact:true}).waitFor();
  const folderTarget=page.locator('#panel-design-1 tr[data-file]').filter({hasText:'하위 폴더'});
  for(const start of [draggable.locator('.file-name > span'),draggable.locator('time'),draggable.locator('td').nth(2)]) await mouseDrag(folderTarget,'Shift','move',start);
  assert.equal((await page.evaluate(()=>window.dragRequests.at(-1))).destination,'C:\\UI fixture\\하위 폴더');
  const selectable=panel(page).locator('tr[data-file]');
  await selectable.first().click();await selectable.last().click({modifiers:['Shift']});
  assert.equal(await panel(page).locator('tr[aria-selected="true"]').count(),5);
  passed.push('Actual mouse drag routes same-drive move, Ctrl copy and Shift folder drop from filename/date/size; Shift-click range selection preserved');
  assert.deepEqual(errors, []);
  await browser.close(); browser = undefined;
  const report = { passed: true, root, checks: passed, errors, note: 'UI bridge is injected only by this test. Native tests verify actual Windows filesystem separately.' };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(async error => {
  await browser?.close().catch(() => {});
  fs.writeFileSync(path.join(root, 'failure.json'), JSON.stringify({ error: error.stack, checks: passed, errors }, null, 2));
  console.error(error);
  process.exitCode = 1;
});
