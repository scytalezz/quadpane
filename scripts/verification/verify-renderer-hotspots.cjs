'use strict';
// Dependency-free headless probes of the actual renderer functions and search
// listener. DOM/IPC are isolated fixtures: no app, clipboard or user files.
// Run: node --test scripts/verification/verify-renderer-hotspots.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');

function fixture(count = 200) {
  const metrics = { queries: 0, rowWrites: 0, sorts: 0, selectionPasses: 0 };
  const nodes = new Map();
  function element() {
    const children = new Map(), attributes = new Map(), classes = new Set();
    let html = '';
    return {
      hidden: false, value: '', dataset: {}, rows: [], textContent: '', listeners: {},
      classList: { contains: key => classes.has(key), toggle(key, enabled) {
        if (enabled) classes.add(key); else classes.delete(key);
      } },
      setAttribute(key, value) { if (this.dataset.file) metrics.rowWrites++; attributes.set(key, value); },
      getAttribute: key => attributes.get(key) ?? null,
      removeAttribute: key => attributes.delete(key),
      querySelector(selector) { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); },
      querySelectorAll(selector) { return selector === '[data-file]' ? this.querySelector('.file-scroll').rows : []; },
      addEventListener(type, callback) { this.listeners[type] = callback; },
      matches() { return false; }, closest() { return null; }, focus() {}, scrollIntoView() {},
      get innerHTML() { return html; },
      set innerHTML(value) {
        html = value;
        this.rows = Array.from(value.matchAll(/<tr tabindex="0"[^>]*data-file="([^"]+)" aria-selected="([^"]+)" class="([^"]*)"/g), match => {
          const row = element(); row.dataset.file = match[1];
          row.setAttribute('aria-selected', match[2]); row.classList.toggle('selected', match[3].includes('selected'));
          return row;
        });
      },
    };
  }
  const document = {
    activeElement: element(),
    querySelector(selector) {
      if (selector === '#global-search') metrics.queries++;
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    querySelectorAll() { return []; },
    getElementById(id) { return this.querySelector(`#${id}`); },
  };
  const pending = [];
  const bridge = { listDirectory: location => new Promise(resolve => pending.push({ location, resolve })),
    bootstrap() {}, saveSession: async () => ({ ok: true }), savePreferences: async value => ({ ok: true, value }) };
  const context = vm.createContext({ window: { pane: bridge }, document, metrics, console, setTimeout, clearTimeout });
  const run = code => vm.runInContext(code, context);
  const initialization = source.indexOf("$('#search-icon').innerHTML");
  assert.ok(initialization > 0, 'renderer definition boundary must exist');
  run(source.slice(0, initialization));
  run(`
    const originalSort = Array.prototype.sort;
    Array.prototype.sort = function(...args) { metrics.sorts++; return originalSort.apply(this,args); };
    const originalUpdateSelection = updateSelection;
    updateSelection = function(...args) { metrics.selectionPasses++; return originalUpdateSelection(...args); };
    workspaces = { design: { layout:4, active:0, panes:Array.from({length:4},(_,index) => makePane('design',index,{path:'C:\\\\fixture'+index,sort:'name',direction:1})) } };
    ready = true;
    for (const pane of allPanes()) {
      pane.loaded = true;
      pane.entries = Array.from({length:${count}},(_,index) => ({id:pane.id+'-'+index,name:'file-'+index+'.txt',path:pane.path+'\\\\file-'+index+'.txt',type:'file',size:index,modified:'2026-01-01T00:00:00Z'}));
      renderFiles(pane);
    }
  `);
  const searchListener = source.split(/\r?\n/).find(line => line.startsWith("$('#global-search').addEventListener('input'"));
  assert.ok(searchListener, 'exercise the production search listener');
  run(searchListener);
  for (const key of Object.keys(metrics)) metrics[key] = 0;
  return { run, metrics, document, pending,
    settle(index, names = ['file-0.txt', 'file-1.txt']) {
      const request = pending[index];
      request.resolve({ ok: true, value: { path: request.location, name: request.location, parent: 'C:\\', breadcrumbs: [],
        entries: names.map(name => ({ name, path: `${request.location}\\${name}`, type: 'file', size: 1, modified: null })) } });
    } };
}

test('repeated selections reuse ordering and read search once per filtering pass', () => {
  const f = fixture(1000);
  const start = performance.now();
  f.run(`for (let i=0;i<10;i++) selectFile(activePane(),activePane().entries[i].id);`);
  console.log('selection metrics:', JSON.stringify({ ...f.metrics, milliseconds: performance.now() - start }));
  assert.equal(f.metrics.sorts, 0, 'selection must reuse the already rendered sort');
  assert.ok(f.metrics.queries < 200, 'search DOM reads must not scale with entry count');
  assert.equal(f.metrics.rowWrites, 19, 'only the 19 changed row selections should write aria-selected');
});

test('four-pane search performs one selection pass and preserves independent file IDs', () => {
  const f = fixture(1000);
  const search = f.document.querySelector('#global-search'); search.value = 'file-1';
  search.listeners.input();
  console.log('search metrics:', JSON.stringify(f.metrics));
  assert.equal(f.metrics.selectionPasses, 1);
  assert.ok(f.metrics.queries < 30);
  assert.equal(f.run(`sortedFiles(activePane()).length`), 111);
  assert.equal(f.run(`new Set(allPanes().flatMap(pane => sortedFiles(pane).map(file => file.id))).size`), 444);
});

test('same-folder refresh preserves selection/anchor changed while IPC is pending', async () => {
  const f = fixture();
  f.run(`selectFile(activePane(),activePane().entries[0].id)`);
  const request = f.run(`navigate(activePane(),activePane().path,{refresh:true,preserveDraft:true})`);
  f.run(`selectFile(activePane(),activePane().entries[1].id)`);
  f.settle(0);
  await request;
  assert.equal(f.run(`selectedFiles()[0]?.name`), 'file-1.txt');
  assert.equal(f.run(`activePane().entries.find(file => file.id===activePane().selectionAnchor)?.name`), 'file-1.txt');
});

test('refresh does not resurrect a selection cleared while IPC is pending', async () => {
  const f = fixture();
  f.run(`selectFile(activePane(),activePane().entries[0].id)`);
  const request = f.run(`navigate(activePane(),activePane().path,{refresh:true})`);
  f.run(`activePane().selected.clear();activePane().selectionAnchor=null`);
  f.settle(0); await request;
  assert.equal(f.run(`selectedFiles().length`), 0);
  assert.equal(f.run(`activePane().selectionAnchor`), null);
});

test('sort/filter invalidation retains original Korean numeric ordering and identity', () => {
  const f = fixture();
  f.run(`activePane().entries = ['가10.txt','가2.txt','A.txt','a.txt','é.txt','.env','숨김.txt','folder'].map((name,index)=>({id:String(index),name,path:'C:\\\\'+name,type:index===7?'folder':'file',hidden:index===6,size:index%3,modified:index%2?'2026-01-01':null}));`);
  for (const sort of ['name', 'size', 'modified']) for (const direction of [1, -1]) {
    f.run(`activePane().sort='${sort}';activePane().direction=${direction}`);
    const actual = f.run(`JSON.stringify(sortedFiles(activePane()).map(file=>file.id))`);
    const expected = f.run(`JSON.stringify(activePane().entries.filter(file=>!file.hidden).sort((a,b)=>{
      if(a.type!==b.type)return a.type==='folder'?-1:1;
      const compared = activePane().sort==='size'?(a.size??-1)-(b.size??-1):activePane().sort==='modified'?(Date.parse(a.modified)||0)-(Date.parse(b.modified)||0):a.name.localeCompare(b.name,'ko',{numeric:true,sensitivity:'base'});
      return (compared||a.name.localeCompare(b.name,'ko',{numeric:true}))*activePane().direction;
    }).map(file=>file.id))`);
    assert.equal(actual, expected);
  }
  f.run(`displayPreferences.showHidden=true`);
  assert.equal(f.run(`sortedFiles(activePane()).length`), 8);
  f.document.querySelector('#global-search').value = '  가2  ';
  assert.equal(f.run(`sortedFiles(activePane())[0].name`), '가2.txt');
  f.document.querySelector('#global-search').value = '';
  f.run(`activePane().entries=[{id:'new',name:'new',type:'file'}]`);
  assert.equal(f.run(`sortedFiles(activePane())[0].id`), 'new');
});

test('range/toggle selection follows current order and does not replace DOM rows', () => {
  const f = fixture(20);
  const rows = f.document.getElementById('panel-design-0').querySelector('.file-scroll').rows;
  f.run(`selectFile(activePane(),sortedFiles(activePane())[2].id);selectFile(activePane(),sortedFiles(activePane())[5].id,{range:true})`);
  assert.equal(f.run(`selectedFiles().length`), 4);
  f.run(`selectFile(activePane(),sortedFiles(activePane())[3].id,{toggle:true})`);
  assert.equal(f.run(`selectedFiles().length`), 3);
  assert.equal(f.document.getElementById('panel-design-0').querySelector('.file-scroll').rows, rows);
  f.run(`activePane().direction=-1;renderFiles(activePane());selectFile(activePane(),sortedFiles(activePane())[0].id);selectFile(activePane(),sortedFiles(activePane())[2].id,{range:true})`);
  assert.equal(f.run(`JSON.stringify(selectedFiles().map(file=>file.name).sort())`), JSON.stringify(['file-17.txt','file-18.txt','file-19.txt']));
});

test('cut styling clears after clipboard reset without replacing selection rows', () => {
  const f = fixture(10);
  const rows = f.document.getElementById('panel-design-0').querySelector('.file-scroll').rows;
  f.run(`clipboard={operation:'move',sources:[activePane().entries[1].path]};updateSelection()`);
  assert.deepEqual(rows.filter(row => row.classList.contains('cut-pending')).map(row => row.dataset.file), ['design-0-1']);
  f.run(`clipboard={operation:'copy',sources:[activePane().entries[1].path]};updateSelection()`);
  assert.ok(rows.every(row => !row.classList.contains('cut-pending')));
  f.run(`clipboard=null;updateSelection()`);
  assert.equal(f.metrics.rowWrites, 0);
});

test('extension hiding preserves distinct paths; search prunes only visible-pane selections', () => {
  const f = fixture(10);
  f.run(`
    activePane().entries=['report.txt','report.csv'].map((name,index)=>({id:'report-'+index,name,path:activePane().path+'\\\\'+name,type:'file',size:1,modified:null}));
    displayPreferences.showExtensions=false;renderFiles(activePane());
    selectFile(activePane(),'report-0');selectFile(activePane(),'report-1',{toggle:true});
    workspaces.design.panes[1].selected.add('design-1-0');
    workspaces.design.layout=1;panelElement(workspaces.design.panes[1]).hidden=true;
  `);
  assert.equal(f.run(`JSON.stringify(selectedFiles().map(file=>file.name))`), JSON.stringify(['report.txt','report.csv']));
  assert.equal(f.run(`JSON.stringify(selectedFiles().map(displayFileName))`), JSON.stringify(['report','report']));
  const search = f.document.querySelector('#global-search'); search.value = '.csv';search.listeners.input();
  assert.equal(f.run(`selectedFiles()[0].name`), 'report.csv');
  assert.equal(f.run(`workspaces.design.panes[1].selected.size`), 1);
  assert.equal(f.run(`selectedFiles(workspaces.design.panes[1]).length`), 0);
  search.value = '';search.listeners.input();
  assert.equal(f.run(`selectedFiles().length`), 1);
});

test('latest navigation wins; stale success/error cannot overwrite files, history or draft', async () => {
  const f = fixture();
  const older = f.run(`navigate(activePane(),'C:\\\\older')`);
  const latest = f.run(`navigate(activePane(),'C:\\\\latest')`);
  f.run(`activePane().dirty=true;activePane().draftVersion++;activePane().draft='new draft';addressElement(activePane()).value='new draft'`);
  f.settle(1, ['latest.txt']); await latest;
  const snapshot = f.run(`JSON.stringify({path:activePane().path,entries:activePane().entries,history:activePane().history,draft:activePane().draft})`);
  f.settle(0, ['stale.txt']); await older;
  assert.equal(f.run(`JSON.stringify({path:activePane().path,entries:activePane().entries,history:activePane().history,draft:activePane().draft})`), snapshot);
  assert.equal(f.run(`addressElement(activePane()).value`), 'new draft');
  const failed = f.run(`navigate(activePane(),'C:\\\\failed')`);
  const final = f.run(`navigate(activePane(),'C:\\\\final')`);
  f.settle(3, ['final.txt']); await final;
  f.pending[2].resolve({ok:false,error:{message:'stale failure'}}); await failed;
  assert.equal(f.run(`activePane().error`), null);
  assert.equal(f.run(`activePane().entries[0].name`), 'final.txt');
  assert.equal(f.run(`selectedFiles().length`), 0);
});
