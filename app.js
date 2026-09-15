const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  folder:'<path d="M3 6.5h6l2 2h10v11H3z"/><path d="M3 9V5h6l2 2h8v1.5"/>',
  back:'<path d="m13.5 6-6 6 6 6M8 12h12"/>',
  up:'<path d="m6 10 6-6 6 6M12 4v16"/>',
  refresh:'<path d="M20 11a8 8 0 1 0-2.3 6.7M20 4v7h-7"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>',
  sort:'<path d="M12 5v14m-4-4 4 4 4-4"/>',
  expand:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  restore:'<path d="M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5"/>',
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.2"/><rect x="14" y="3" width="7" height="7" rx="1.2"/><rect x="3" y="14" width="7" height="7" rx="1.2"/><rect x="14" y="14" width="7" height="7" rx="1.2"/>',
  documents:'<path d="M7 3h9l4 4v14H7zM16 3v5h4M4 7H2v15h13M10 12h7m-7 4h7"/>',
  home:'<path d="m3 11 9-8 9 8M5 10v11h14V10M10 21v-7h4v7"/>',
  desktop:'<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8m-4-4v4"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/>',
  image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-7 5 7"/>',
  drive:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 14h18m-4 3h1M7 17h4"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-11v1"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 1 1 5 2.2c-1.3.8-2 1.3-2 3M12 17v.5"/>',
  tip:'<path d="M9 18h6m-6 3h6M8.5 15.5a6 6 0 1 1 7 0L15 18H9z"/>',
  one:'<rect x="3" y="4" width="18" height="16" rx="1.5"/>',
  two:'<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M12 4v16"/>',
  four:'<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M12 4v16M3 12h18"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
  down:'<path d="m6 9 6 6 6-6"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="1.5"/><path d="M16 8V3H3v13h5"/>',
  cut:'<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8 8 12 12M8 16 20 4"/>',
  paste:'<path d="M9 5H5v16h14V5h-4"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M8 12h8m-8 4h6"/>',
  transfer:'<path d="M3 7h16m-4-4 4 4-4 4M21 17H5m4-4-4 4 4 4"/>',
  open:'<path d="M14 3h7v7m0-7L10 14M10 5H4v15h15v-6"/>',
  rename:'<path d="m4 16 11-11 4 4L8 20H4zM13 7l4 4M12 21h9"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  newfolder:'<path d="M3 6h6l2 2h10v12H3zM15 11v6m-3-3h6"/>',
};
function icon(name, className = '') {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${className}">${Object.hasOwn(paths,name) ? paths[name] : paths.folder}</svg>`;
}
function fileIcon(file) {
  if (file.type === 'folder') return icon('folder', 'folder-svg');
  const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
  const types = {pdf:'pdf',png:'image',jpg:'image',jpeg:'image',gif:'image',webp:'image',bmp:'image',ico:'image',svg:'image',heic:'image',doc:'doc',docx:'doc',txt:'doc',md:'doc',hwp:'doc',hwpx:'doc',rtf:'doc',xls:'sheet',xlsx:'sheet',csv:'sheet',zip:'zip','7z':'zip',rar:'zip',tar:'zip',gz:'zip',mp4:'video',mov:'video',mkv:'video',avi:'video',webm:'video',mp3:'audio',wav:'audio',flac:'audio',m4a:'audio',ogg:'audio',js:'code',ts:'code',jsx:'code',tsx:'code',json:'code',html:'code',css:'code',py:'code',rs:'code',c:'code',cpp:'code',sh:'code',ps1:'code',exe:'executable',msi:'executable',dll:'executable'};
  const kind = Object.hasOwn(types,ext) ? types[ext] : 'doc';
  const symbols = {
    doc:'<path d="M8 12h8m-8 4h6"/>',
    pdf:'<path d="M9 9c0 5-2 8-3 8 3-1 6-2 11-2-4-1-6-3-7-6Z"/>',
    image:'<circle cx="9" cy="11" r="1.2"/><path d="m7 18 4-4 2 2 2-3 2 5"/>',
    sheet:'<path d="M8 11h9v7H8zM8 14.5h9M12 11v7"/>',
    zip:'<path d="M10 3v2m2 0v2m-2 0v2m2 0v2m-2 0v2"/><rect x="9" y="14" width="4" height="4" rx="1"/>',
    code:'<path d="m10 11-3 3 3 3m4-6 3 3-3 3"/>',
    video:'<path d="m9 10 7 4-7 4z"/>',
    audio:'<path d="M12 16V9l5-1v7M12 11l5-1"/><ellipse cx="10" cy="17" rx="2" ry="1.5"/><ellipse cx="15" cy="16" rx="2" ry="1.5"/>',
    executable:'<rect x="8" y="11" width="9" height="7" rx="1"/><path d="M8 13h9m-7 2h1"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="file-svg file-icon-${kind}"><path d="M5 2.5h9l5 5V21H5z"/><path d="M14 2.5v5h5"/>${symbols[kind]}</svg>`;
}
const pad = (number) => String(number).padStart(2,'0');
function dateText(value, full = false) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '—';
  const day = `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
  return full ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : day;
}
function modifiedDate(value) {
  return dateText(value) === '—' ? '—' : `<time datetime="${escapeHtml(value)}" title="${escapeHtml(dateText(value,true))}">${dateText(value)}</time>`;
}
function sizeText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB','MB','GB','TB'];
  const index = Math.min(Math.floor(Math.log(value)/Math.log(1024))-1,units.length-1);
  return `${(value / 1024 ** (index+1)).toLocaleString('ko-KR',{maximumFractionDigits:1})} ${units[index]}`;
}
const bridge = window.pane;
const hasNativeBridge = Boolean(bridge && ['bootstrap','listDirectory','saveSession'].every((method) => typeof bridge[method] === 'function'));
const workspaceDefinitions = {
  design:{name:'내 작업 공간',description:'자주 쓰는 폴더를 나란히, 마지막 위치 그대로.',icon:'grid'},
  documents:{name:'문서 작업',description:'문서와 자료를 함께 보고, 열린 위치를 기억해요.',icon:'documents'}
};
let workspaces = {};
let workspaceId = 'design';
let favorites = [];
let userFavorites = [];
let recentPaths = [];
let drives = [];
let ready = false;
let bootstrapToken = 0;
let saveRevision = 0;
let startupWarning = '';
let saveError = '';
let preferenceError = '';
let preferenceRevision = 0;
let openAddressPane = null;
let clipboard = null;
let clipboardRevision = 0;
let transferPending = false;
let transferDraft = null;
let mutationLabel = '';
let contextMenuState = null;
let nameDraft = null;
let trashDraft = null;
let internalDrag = null;
let dropTarget = null;
let nativeDragOut = false;
let toastTimer;
const workspace = () => workspaces[workspaceId];
const activePane = () => workspace()?.panes[workspace().active];
const allPanes = () => Object.values(workspaces).flatMap((item) => item.panes);
const visiblePanes = () => workspace().layout === 1 ? [activePane()] : workspace().panes.slice(0,workspace().layout);
const selectedFiles = (pane = activePane()) => pane?.entries.filter((file) => pane.selected.has(file.id)) || [];
const selectedFile = () => selectedFiles().length === 1 ? selectedFiles()[0] : null;
const pathKey = (value) => String(value || '').replace(/\//g,'\\').replace(/\\+$/,'').toLocaleLowerCase('en-US');
const samePath = (left,right) => pathKey(left) === pathKey(right);
const combinedFavorites = () => [...favorites,...userFavorites.map((item) => ({...item,icon:'star'}))];
const paneFromElement = (element) => allPanes().find((pane) => pane.id === element?.closest('[data-pane]')?.dataset.pane);
const panelElement = (pane) => document.getElementById(`panel-${pane.id}`);
const addressElement = (pane) => $('.path-input',panelElement(pane));

function makePane(workspaceKey,index,saved) {
  return {id:`${workspaceKey}-${index}`,workspaceId:workspaceKey,index,path:saved.path,name:saved.path,parent:null,breadcrumbs:[],entries:[],history:[],selected:new Set(),selectionAnchor:null,sort:saved.sort,direction:saved.direction,loaded:false,loading:false,error:null,requestToken:0,pendingPath:null,draft:saved.path,draftVersion:0,dirty:false,addressOptions:[]};
}
function defaultSession() {
  const fallback = favorites.find((item) => item.id === 'home')?.path || drives[0]?.path || favorites[0]?.path || '';
  const favorite = (id) => favorites.find((item) => item.id === id)?.path || fallback;
  const panes = (ids) => ids.map((id) => ({path:favorite(id),sort:'name',direction:1}));
  return {version:1,workspaceId:'design',workspaces:{design:{layout:4,active:0,panes:panes(['home','downloads','documents','pictures'])},documents:{layout:2,active:0,panes:panes(['documents','downloads','home','pictures'])}}};
}
function isSessionValid(session) {
  return session?.version === 1 && Object.hasOwn(workspaceDefinitions,session.workspaceId) && Object.keys(workspaceDefinitions).every((id) => {
    const saved = session.workspaces?.[id];
    return saved && [1,2,4].includes(saved.layout) && Number.isInteger(saved.active) && saved.active >= 0 && saved.active < 4 && Array.isArray(saved.panes) && saved.panes.length === 4 && saved.panes.every((pane) => typeof pane.path === 'string' && pane.path.length > 0 && ['name','modified','size'].includes(pane.sort) && [1,-1].includes(pane.direction));
  });
}
function sessionSnapshot() {
  return {version:1,workspaceId,workspaces:Object.fromEntries(Object.entries(workspaces).map(([id,item]) => [id,{layout:item.layout,active:item.active,panes:item.panes.map((pane) => ({path:pane.path,sort:pane.sort,direction:pane.direction}))}]))};
}
function renderStorageMessage() {
  const message = [startupWarning,saveError,preferenceError].filter(Boolean).join(' ');
  $('#session-message').textContent = message;
  $('#session-message').title = message;
  $('#session-message').hidden = !message;
  $('#storage-status').classList.toggle('storage-error',Boolean(saveError));
}
function persistSession() {
  if (!ready) return;
  const revision = ++saveRevision;
  $('#storage-status').textContent = '폴더 위치 저장 중…';
  // Dispatch every committed change now; the main process writes each snapshot synchronously.
  let request;
  try { request = bridge.saveSession(sessionSnapshot()); }
  catch (error) { request = Promise.reject(error); }
  Promise.resolve(request).then((result) => {
    if (revision !== saveRevision) return;
    if (!result?.ok) throw new Error(result?.error?.message || '설정을 저장하지 못했어요.');
    saveError = '';
    $('#storage-status').textContent = '폴더 위치 자동 저장';
    renderStorageMessage();
  }).catch((error) => {
    if (revision !== saveRevision) return;
    saveError = `열린 폴더를 저장하지 못했어요. ${error.message || '설정 폴더를 확인해 주세요.'}`;
    $('#storage-status').textContent = '폴더 위치 저장 실패';
    renderStorageMessage();
  });
}
function persistPreferences() {
  if (!ready || typeof bridge.savePreferences !== 'function') return;
  const revision = ++preferenceRevision;
  const snapshot = {favorites:userFavorites.map((item) => ({...item})),recentPaths:[...recentPaths]};
  let request;
  try { request = bridge.savePreferences(snapshot); }
  catch (error) { request = Promise.reject(error); }
  Promise.resolve(request).then((result) => {
    if (revision !== preferenceRevision) return;
    if (!result?.ok) throw new Error(result?.error?.message || '즐겨찾기를 저장하지 못했어요.');
    userFavorites = result.value.favorites;
    recentPaths = result.value.recentPaths;
    preferenceError = '';
    renderSidebar();
    updateSelection();
    renderStorageMessage();
  }).catch((error) => {
    if (revision !== preferenceRevision) return;
    preferenceError = `즐겨찾기와 최근 경로를 저장하지 못했어요. ${error.message || '설정 폴더를 확인해 주세요.'}`;
    renderStorageMessage();
  });
}
function rememberPath(path) {
  if (samePath(recentPaths[0],path)) return;
  recentPaths = [path,...recentPaths.filter((item) => !samePath(item,path))].slice(0,20);
  persistPreferences();
}
function addFavorite() {
  const pane = activePane();
  if (!ready || !pane?.loaded || typeof bridge.savePreferences !== 'function') return;
  if (combinedFavorites().some((item) => samePath(item.path,pane.path))) {showToast('이미 즐겨찾기에 있는 폴더예요.');return;}
  if (userFavorites.length >= 100) {showToast('즐겨찾기는 100개까지 추가할 수 있어요. 사용하지 않는 폴더를 제거해 주세요.');return;}
  userFavorites.push({path:pane.path,label:(pane.name || pane.path).slice(0,120)});
  renderSidebar();
  updateSelection();
  persistPreferences();
  showToast('즐겨찾기에 추가했어요.');
}
function closeAddressMenu(restoreFocus = false) {
  if (!openAddressPane) return;
  const pane = openAddressPane;
  const panel = panelElement(pane);
  const menu = $('.address-menu',panel);
  if (menu.matches(':popover-open')) menu.hidePopover();
  $('.path-dropdown-toggle',panel).setAttribute('aria-expanded','false');
  openAddressPane = null;
  if (restoreFocus) $('.path-dropdown-toggle',panel).focus({preventScroll:true});
}
function openAddressMenu(pane) {
  closeContextMenu();
  closeTransferResult();
  closeAddressMenu();
  const panel = panelElement(pane);
  const menu = $('.address-menu',panel);
  const groups = [
    ['현재 위치와 상위 폴더',[{path:pane.path,label:pane.name || pane.path},...(pane.breadcrumbs || []).slice().reverse().filter((item) => !samePath(item.path,pane.path)).map((item) => ({path:item.path,label:item.name}))]],
    ['즐겨찾기',combinedFavorites()],
    ['최근 경로',recentPaths.map((path) => ({path,label:path.split(/[\\/]/).filter(Boolean).at(-1) || path}))],
    ['내 드라이브',drives],
  ];
  pane.addressOptions = [];
  const seen = new Set();
  menu.innerHTML = groups.map(([label,items]) => {
    const options = items.filter((item) => {
      if (!item.path || seen.has(pathKey(item.path))) return false;
      seen.add(pathKey(item.path));
      return true;
    }).map((item) => {
      const index = pane.addressOptions.push(item.path)-1;
      return `<button type="button" class="address-option" role="menuitem" data-address-option="${index}">${icon(label==='내 드라이브'?'drive':label==='즐겨찾기'?'star':'folder')}<span>${escapeHtml(item.label || item.path)}<span class="address-option-detail">${escapeHtml(item.path)}</span></span></button>`;
    }).join('');
    return options ? `<div class="address-menu-group" role="presentation">${escapeHtml(label)}</div>${options}` : '';
  }).join('');
  const rect = $('.path-form',panel).getBoundingClientRect();
  menu.style.width = `${Math.min(Math.max(rect.width,300),window.innerWidth-24)}px`;
  menu.style.left = `${Math.max(12,Math.min(rect.left,window.innerWidth-parseFloat(menu.style.width)-12))}px`;
  menu.style.top = '0px';
  menu.showPopover();
  const menuHeight = menu.getBoundingClientRect().height;
  const top = rect.bottom+6+menuHeight <= window.innerHeight-12 ? rect.bottom+6 : Math.max(12,rect.top-menuHeight-6);
  menu.style.top = `${top}px`;
  openAddressPane = pane;
  $('.path-dropdown-toggle',panel).setAttribute('aria-expanded','true');
  $('.address-option',menu)?.focus({preventScroll:true});
}
function selectFile(pane,fileId,{toggle = false,range = false} = {}) {
  const rows = sortedFiles(pane);
  if (range && pane.selectionAnchor) {
    const start = rows.findIndex((file) => file.id === pane.selectionAnchor);
    const end = rows.findIndex((file) => file.id === fileId);
    if (start >= 0 && end >= 0) {
      if (!toggle) pane.selected.clear();
      rows.slice(Math.min(start,end),Math.max(start,end)+1).forEach((file) => pane.selected.add(file.id));
    } else pane.selected = new Set([fileId]);
  } else if (toggle) {
    if (pane.selected.has(fileId)) pane.selected.delete(fileId);
    else pane.selected.add(fileId);
    pane.selectionAnchor = fileId;
  } else {
    pane.selected = new Set([fileId]);
    pane.selectionAnchor = fileId;
  }
  updateSelection();
}
function copySelection(operation) {
  const pane = activePane();
  const files = selectedFiles();
  if (!files.length || transferPending || pane.loading || pane.error || typeof bridge.transfer !== 'function') return;
  clipboard = {operation,sources:files.map((file) => file.path)};
  clipboardRevision++;
  updateSelection();
  showToast(`${files.length}개 항목 ${operation==='move'?'이동':'복사'} 준비. 대상 창에서 붙여넣으세요.`);
}
function showTransferResult(result) {
  const root = $('#transfer-result');
  const verb = ({move:'이동',copy:'복사',trash:'휴지통 이동',rename:'이름 변경',create:'폴더 만들기'})[result.operation] || '파일 작업';
  const issues = [...result.skipped.map((item) => ({...item,label:'건너뜀'})),...result.failed.map((item) => ({...item,label:'실패'}))];
  const summary = `${verb} 완료 ${result.completed.length}개${result.skipped.length?` · 건너뜀 ${result.skipped.length}개`:''}${result.failed.length?` · 실패 ${result.failed.length}개`:''}`;
  root.innerHTML = `<div class="transfer-result-summary"><span>${summary}</span><button type="button" class="icon-button" data-dismiss-transfer aria-label="파일 작업 결과 닫기">${icon('close')}</button></div>${issues.length?`<details class="transfer-result-details" open><summary>작업하지 못한 항목 ${issues.length}개</summary><ul>${issues.map((item) => `<li><strong>${escapeHtml(item.label)} · ${escapeHtml(item.source)}</strong><span>${escapeHtml(item.message)}${item.code?` (${escapeHtml(item.code)})`:''}</span></li>`).join('')}</ul></details>`:'<p class="dialog-subtitle">요청한 작업을 완료했어요.</p>'}`;
  const button = $('#operation-results-button');
  button.hidden = false;
  button.textContent = issues.length ? '작업 결과 · 확인 필요' : '작업 결과';
  button.title = summary;
  button.classList.toggle('has-issues',Boolean(issues.length));
  showToast(summary);
}
function closeTransferResult(restoreFocus = false) {
  const root = $('#transfer-result');
  if (root.matches(':popover-open')) root.hidePopover();
  if (restoreFocus) $('#operation-results-button').focus({preventScroll:true});
}
function openTransferResult() {
  closeAddressMenu();
  closeContextMenu();
  const root = $('#transfer-result');
  if (root.matches(':popover-open')) {closeTransferResult();return;}
  const rect = $('#operation-results-button').getBoundingClientRect();
  root.showPopover();
  positionOverlay(root,rect.right-root.getBoundingClientRect().width,rect.bottom+6);
  $('[data-dismiss-transfer]',root)?.focus({preventScroll:true});
}
function pathWithin(value,parent) {
  return samePath(value,parent) || pathKey(value).startsWith(`${pathKey(parent)}\\`);
}
function parentPath(value) {
  const clean = String(value).replace(/[\\/]+$/,'');
  const index = clean.lastIndexOf('\\');
  const parent = clean.slice(0,index);
  return /^[a-z]:$/i.test(parent) ? `${parent}\\` : parent;
}
function relocatedPath(value,relocations) {
  return relocations.reduce((current,item) => pathWithin(current,item.source) ? item.destination + current.slice(item.source.length) : current,value);
}
async function refreshAffected(predicate,relocations = []) {
  const affected = allPanes().filter((pane) => (pane.loaded || pane.loading || pane.error) && (predicate(pane.path) || (pane.pendingPath && predicate(pane.pendingPath))));
  await Promise.all(affected.map((pane) => {
    if (pane.loading) {
      // Preserve the user's in-flight destination. Refresh only after the latest request commits.
      pane.refreshAfterLoad = true;
      pane.refreshRelocations = [...(pane.refreshRelocations || []),...relocations];
      return;
    }
    const nextPath = relocatedPath(pane.path,relocations);
    return navigate(pane,nextPath,{refresh:true,preserveDraft:true});
  }));
}
async function runMutation(label,operation,source,action) {
  if (transferPending) return;
  transferPending = true;
  mutationLabel = label;
  closeAddressMenu();
  closeContextMenu();
  closeTransferResult();
  clearDropFeedback();
  updateSelection();
  try {
    await action();
  } catch (error) {
    if ((operation==='rename' || operation==='create') && $('#name-dialog').open) {
      $('#name-error').textContent = error.message || '파일 작업을 완료하지 못했어요. 다시 시도해 주세요.';
      $('#name-error').hidden = false;
    }
    showTransferResult({operation,completed:[],skipped:[],failed:[{source,code:'FILE_OPERATION_ERROR',message:error.message || '파일 작업을 완료하지 못했어요.'}]});
  } finally {
    transferPending = false;
    mutationLabel = '';
    updateSelection();
  }
}
async function performTransfer(sources,destination,operation,fromClipboard = false) {
  if (!sources.length || !destination || transferPending || typeof bridge.transfer !== 'function') return;
  const revision = clipboardRevision;
  await runMutation(`${sources.length}개 항목 ${operation==='move'?'이동':'복사'} 중…`,operation,destination,async () => {
    const response = await bridge.transfer({sources:[...sources],destination,operation});
    if (!response?.ok) throw new Error(response?.error?.message || '파일 작업을 완료하지 못했어요.');
    const result = response.value;
    showTransferResult(result);
    if (fromClipboard && operation === 'move' && clipboard && clipboardRevision === revision) {
      const completed = new Set(result.completed.map((item) => pathKey(item.source)));
      clipboard.sources = clipboard.sources.filter((source) => !completed.has(pathKey(source)));
      if (!clipboard.sources.length) clipboard = null;
      clipboardRevision++;
    }
    if (operation==='move') result.completed.forEach((item) => remapReferences(item.source,item.destination));
    const affectedPath = (path) => samePath(path,destination) || sources.some((source) => samePath(path,parentPath(source)) || (operation==='move' && pathWithin(path,source)));
    await refreshAffected(affectedPath,operation==='move'?result.completed:[]);
  });
}
function pasteSelection() {
  const pane = activePane();
  if (clipboard && pane?.loaded && !pane.loading && !pane.error) performTransfer(clipboard.sources,pane.path,clipboard.operation,true);
}
function openTransferDialog() {
  const files = selectedFiles();
  if (!files.length || transferPending || activePane().loading || activePane().error) return;
  transferDraft = {sources:files.map((file) => file.path),destination:null};
  $('#transfer-description').textContent = `${files.length}개 항목을 보낼 폴더를 선택하세요. 다른 작업 공간의 창도 선택할 수 있어요.`;
  $('[name="transfer-operation"][value="copy"]').checked = true;
  const candidates = allPanes().filter((pane) => pane.loaded && !pane.loading && !pane.error && !samePath(pane.path,activePane().path));
  const seen = new Set();
  $('#transfer-destinations').innerHTML = candidates.filter((pane) => {
    if (seen.has(pathKey(pane.path))) return false;
    seen.add(pathKey(pane.path));
    return true;
  }).map((pane) => `<label class="transfer-target"><input type="radio" name="transfer-destination" value="${pane.id}"><span><strong>${escapeHtml(workspaces[pane.workspaceId].name)} · ${pane.index+1}번 패널</strong><small>${escapeHtml(pane.path)}</small></span></label>`).join('') || '<p class="dialog-subtitle">다른 창에서 대상 폴더를 먼저 열어주세요.</p>';
  $('#transfer-confirm').disabled = true;
  $('#transfer-confirm').textContent = '선택한 폴더에 복사';
  $('#transfer-dialog').showModal();
}
function positionOverlay(element,x,y) {
  const rect = element.getBoundingClientRect();
  element.style.right = 'auto';
  element.style.bottom = 'auto';
  element.style.left = `${Math.max(8,Math.min(x,window.innerWidth-rect.width-8))}px`;
  element.style.top = `${Math.max(8,Math.min(y,window.innerHeight-rect.height-8))}px`;
}
function closeContextMenu(restoreFocus = false) {
  const state = contextMenuState;
  const menu = $('#file-context-menu');
  if (menu.matches(':popover-open')) menu.hidePopover();
  contextMenuState = null;
  if (restoreFocus && state) focusPaneContent(state.pane,state.fileId);
}
function openContextMenu(pane,row,x,y) {
  if (!ready || !pane) return;
  closeAddressMenu();
  closeTransferResult();
  closeContextMenu();
  activate(pane);
  if (row) {
    if (!pane.selected.has(row.dataset.file)) selectFile(pane,row.dataset.file);
    row.focus({preventScroll:true});
  } else {
    pane.selected.clear();
    pane.selectionAnchor = null;
    updateSelection();
    panelElement(pane).focus({preventScroll:true});
  }
  const files = selectedFiles(pane);
  const single = files.length===1 ? files[0] : null;
  const usable = pane.loaded && !pane.loading && !pane.error;
  const mutable = usable && !transferPending;
  const canTransfer = mutable && typeof bridge.transfer==='function';
  const pasteTarget = single?.type==='folder' ? single.path : pane.path;
  contextMenuState = {pane,fileId:row?.dataset.file,pasteTarget};
  const command = (id,label,symbol,shortcut,enabled=true) => `<button type="button" role="menuitem" class="context-menu-item" data-context-action="${id}" aria-label="${label}" ${enabled?'':'disabled'}>${icon(symbol)}<span>${label}</span>${shortcut?`<kbd>${shortcut}</kbd>`:''}</button>`;
  const separator = '<div class="context-menu-separator" role="separator"></div>';
  const menu = $('#file-context-menu');
  menu.innerHTML = files.length ? [
    command('open','열기','open','Enter',usable && Boolean(single) && (single?.type==='folder' || typeof bridge.openPath==='function')),
    separator,
    command('cut','잘라내기','cut','Ctrl X',canTransfer),
    command('copy','복사','copy','Ctrl C',canTransfer),
    command('paste','붙여넣기','paste','Ctrl V',canTransfer && Boolean(clipboard?.sources.length)),
    command('transfer','다른 창으로','transfer','',canTransfer),
    separator,
    command('rename','이름 변경','rename','F2',mutable && Boolean(single) && typeof bridge.renameItem==='function'),
    command('trash','삭제','trash','Del',mutable && typeof bridge.trashItems==='function'),
    separator,
    command('reveal','탐색기에서 보기','desktop','',usable && Boolean(single) && typeof bridge.revealPath==='function'),
    command('info','파일 정보','info','Alt Enter',Boolean(single)),
  ].join('') : [
    command('newfolder','새 폴더','newfolder','Ctrl Shift N',mutable && typeof bridge.createFolder==='function'),
    command('paste','붙여넣기','paste','Ctrl V',canTransfer && Boolean(clipboard?.sources.length)),
    separator,
    command('refresh','새로고침','refresh','F5',Boolean(pane.path)),
    command('selectall','모두 선택','grid','Ctrl A',usable && Boolean(pane.entries.length)),
    command('reveal','탐색기에서 보기','desktop','',usable && typeof bridge.revealPath==='function'),
  ].join('');
  menu.showPopover();
  positionOverlay(menu,x,y);
  $('.context-menu-item:not(:disabled)',menu)?.focus({preventScroll:true});
}
async function invokeOpen(path,reveal = false) {
  const method = reveal ? 'revealPath' : 'openPath';
  if (typeof bridge?.[method] !== 'function') return;
  try {
    const result = await bridge[method](path);
    if (!result?.ok) throw new Error(result?.error?.message || '항목을 열지 못했어요.');
  } catch (error) {showToast(error.message || '항목을 열지 못했어요.');}
}
function openNameDialog(kind) {
  const pane = activePane();
  const file = selectedFile();
  if (transferPending || !pane?.loaded || pane.loading || pane.error) return;
  if (kind==='rename' && (!file || typeof bridge.renameItem!=='function')) return;
  if (kind==='create' && typeof bridge.createFolder!=='function') return;
  closeContextMenu();
  closeAddressMenu();
  nameDraft = {kind,pane,path:kind==='rename'?file.path:pane.path,file};
  $('#name-title').textContent = kind==='rename'?'이름 변경':'새 폴더';
  $('#name-dialog-icon').innerHTML = icon(kind==='rename'?'rename':'newfolder');
  $('#name-description').textContent = kind==='rename'?file.name:pane.path;
  $('#name-confirm').textContent = kind==='rename'?'변경':'만들기';
  $('#name-error').hidden = true;
  $('#name-error').textContent = '';
  $('#name-input').value = kind==='rename'?file.name:'새 폴더';
  $('#name-dialog').showModal();
  $('#name-input').focus();
  const dot = kind==='rename' && file.type==='file' ? file.name.lastIndexOf('.') : -1;
  $('#name-input').setSelectionRange(0,dot>0?dot:$('#name-input').value.length);
}
function remapReferences(source,destination) {
  const remap = (value) => pathWithin(value,source) ? destination + value.slice(source.length) : value;
  let preferencesChanged = false;
  userFavorites = userFavorites.map((item) => {
    const path = remap(item.path);
    if (path===item.path) return item;
    preferencesChanged = true;
    return {...item,path,label:samePath(item.path,source)?destination.split('\\').at(-1).slice(0,120):item.label};
  });
  recentPaths = recentPaths.map((path) => {
    const next = remap(path);
    if (next!==path) preferencesChanged = true;
    return next;
  }).filter((path,index,items) => items.findIndex((item) => samePath(item,path))===index);
  if (preferencesChanged) {renderSidebar();persistPreferences();}
  if (clipboard) {
    clipboard.sources = clipboard.sources.map(remap);
    clipboardRevision++;
  }
  allPanes().forEach((pane) => {pane.history = pane.history.map(remap);});
}
function openTrashDialog() {
  const pane = activePane();
  const files = selectedFiles();
  if (!files.length || transferPending || pane.loading || pane.error || typeof bridge.trashItems!=='function') return;
  closeContextMenu();
  closeAddressMenu();
  trashDraft = {paths:files.map((file) => file.path)};
  $('#trash-description').textContent = `${files.length}개 항목을 휴지통으로 이동할까요?`;
  $('#trash-items').innerHTML = files.slice(0,20).map((file) => `<li>${fileIcon(file)}<span title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</span></li>`).join('') + (files.length>20?`<li>외 ${files.length-20}개 항목</li>`:'');
  $('#trash-dialog').showModal();
  $('#trash-cancel').focus();
}
function windowsRoot(value) {
  const normalized = String(value).replace(/\//g,'\\');
  const drive = normalized.match(/^[a-z]:\\/i);
  if (drive) return drive[0].toLowerCase();
  const unc = normalized.match(/^\\\\[^\\]+\\[^\\]+/);
  return unc ? unc[0].toLowerCase() : '';
}
function dropOperation(sources,destination,event) {
  if (event.ctrlKey) return 'copy';
  if (event.shiftKey) return 'move';
  const root = windowsRoot(destination);
  return root && sources.every((source) => windowsRoot(source)===root) ? 'move' : 'copy';
}
function clearDropFeedback() {
  dropTarget?.element.classList.remove('drop-target');
  dropTarget = null;
  const feedback = $('#drag-feedback');
  if (feedback.matches(':popover-open')) feedback.hidePopover();
}
function clearDragState() {
  clearDropFeedback();
  internalDrag = null;
  $$('.drag-source').forEach((row) => row.classList.remove('drag-source'));
}
function getDropTarget(event) {
  const scroll = event.target.closest?.('.file-scroll');
  const pane = scroll && paneFromElement(scroll);
  if (!pane || !pane.loaded || pane.loading || pane.error || transferPending || typeof bridge.transfer!=='function') return null;
  const row = event.target.closest('[data-file]');
  const file = row && pane.entries.find((item) => item.id===row.dataset.file);
  return {pane,path:file?.type==='folder'?file.path:pane.path,name:file?.type==='folder'?file.name:pane.name,element:file?.type==='folder'?row:scroll};
}
function hasSupportedDrop(event) {
  const types = [...(event.dataTransfer?.types || [])];
  return Boolean(internalDrag && types.includes('application/x-pane-selection')) || (types.includes('Files') && typeof bridge?.droppedPaths==='function');
}
function showDropFeedback(target,event) {
  if (dropTarget?.element!==target.element) {
    clearDropFeedback();
    target.element.classList.add('drop-target');
  }
  dropTarget = target;
  const effect = internalDrag ? dropOperation(internalDrag.sources,target.path,event) : event.ctrlKey?'copy':event.shiftKey?'move':null;
  const feedback = $('#drag-feedback');
  const text = effect ? `${target.name}에 ${effect==='move'?'이동':'복사'}${internalDrag?` · ${internalDrag.sources.length}개`:''}` : `${target.name}에 놓기 · Ctrl 복사 / Shift 이동`;
  if (feedback.textContent!==text) feedback.textContent=text;
  if (!feedback.matches(':popover-open')) feedback.showPopover();
  positionOverlay(feedback,event.clientX+16,event.clientY+18);
  return effect || 'copy';
}
function sortedFiles(pane) {
  const query = $('#global-search').value.trim().toLocaleLowerCase('ko');
  return pane.entries.filter((file) => file.name.toLocaleLowerCase('ko').includes(query)).sort((a,b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    let compared;
    if (pane.sort === 'size') compared = (a.size ?? -1) - (b.size ?? -1);
    else if (pane.sort === 'modified') compared = (Date.parse(a.modified) || 0) - (Date.parse(b.modified) || 0);
    else compared = a.name.localeCompare(b.name,'ko',{numeric:true,sensitivity:'base'});
    return (compared || a.name.localeCompare(b.name,'ko',{numeric:true})) * pane.direction;
  });
}
function renderSidebar() {
  $('#workspaces').innerHTML = Object.entries(workspaceDefinitions).map(([id,item]) => `<button class="sidebar-button ${id===workspaceId?'selected':''}" data-workspace="${id}" aria-current="${id===workspaceId?'page':'false'}" title="${item.name}" ${ready?'':'disabled'}>${icon(item.icon)}<span>${item.name}</span>${id===workspaceId?'<i class="workspace-dot" aria-hidden="true"></i>':''}</button>`).join('');
  $('#favorites').innerHTML = favorites.map((item,index) => `<button class="sidebar-button" data-favorite="${index}" title="${escapeHtml(item.path)}" aria-label="${escapeHtml(item.label)}">${icon(Object.hasOwn({downloads:'download',pictures:'image'},item.icon)?{downloads:'download',pictures:'image'}[item.icon]:item.icon)}<span>${escapeHtml(item.label)}</span></button>`).join('') + userFavorites.map((item,index) => `<div class="favorite-row"><button class="sidebar-button" data-custom-favorite="${index}" title="${escapeHtml(item.path)}" aria-label="${escapeHtml(item.label)} 즐겨찾기 열기">${icon('star')}<span>${escapeHtml(item.label)}</span></button><button type="button" class="icon-button favorite-remove" data-remove-favorite="${index}" aria-label="${escapeHtml(item.label)} 즐겨찾기 제거" title="즐겨찾기 제거">${icon('close')}</button></div>`).join('');
  $('#drives').innerHTML = drives.map((item,index) => `<button class="sidebar-button drive-button" data-drive="${index}" title="${escapeHtml(item.path)}" aria-label="${escapeHtml(item.label)}">${icon('drive')}<span class="drive-copy"><span>${escapeHtml(item.label)}</span><small>${escapeHtml(item.path)}</small></span></button>`).join('');
}
function createPanel(pane) {
  const element = document.createElement('section');
  element.id = `panel-${pane.id}`;
  element.className = 'file-panel';
  element.dataset.pane = pane.id;
  element.tabIndex = -1;
  element.innerHTML = `<div class="panel-tabbar"><div class="panel-tab">${icon('folder','folder-svg')}<span class="panel-tab-label"></span></div><div class="panel-controls"><span class="active-badge" hidden>현재 창</span><button class="icon-button" data-action="expand" title="이 창 확대"></button></div></div><div class="panel-navigation"><button class="icon-button" data-action="back" aria-label="뒤로" title="뒤로 (Alt + ←)" disabled>${icon('back')}</button><button class="icon-button" data-action="up" aria-label="상위 폴더" title="상위 폴더 (Alt + ↑)" disabled>${icon('up')}</button><form class="path-form"><input class="path-input" aria-label="${pane.index+1}번 패널 폴더 경로" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="폴더 경로 입력"><button class="icon-button path-dropdown-toggle" type="button" data-action="address-menu" aria-label="${pane.index+1}번 패널 경로 목록" aria-haspopup="menu" aria-expanded="false" aria-controls="address-menu-${pane.id}" title="즐겨찾기와 최근 경로 (Alt + ↓)">${icon('down')}</button><button class="icon-button path-go" type="submit" aria-label="입력한 경로 열기" title="입력한 경로 열기 (Enter)">${icon('chevron')}</button><div class="address-menu" id="address-menu-${pane.id}" role="menu" aria-label="${pane.index+1}번 패널 경로 목록" popover="manual"></div></form><button class="icon-button" data-action="refresh" aria-label="폴더 새로고침" title="폴더 새로고침 (F5)">${icon('refresh')}</button></div><div class="panel-message" role="status" hidden></div><div class="file-scroll"></div><div class="panel-footer"><span class="panel-count"></span><span class="panel-footer-right"></span></div>`;
  $('#panels').append(element);
  addressElement(pane).value = pane.path;
  renderPanel(pane);
}
function renderPanel(pane) {
  const panel = panelElement(pane);
  if (!panel) return;
  panel.setAttribute('aria-label',`${pane.index+1}번 패널 ${pane.name || '폴더'}`);
  panel.setAttribute('aria-busy',String(pane.loading));
  $('.panel-tab-label',panel).textContent = pane.name || '폴더';
  $('.panel-tab-label',panel).title = pane.path;
  $('[data-action="back"]',panel).disabled = !pane.history.length;
  $('[data-action="up"]',panel).disabled = !pane.parent;
  $('[data-action="refresh"]',panel).disabled = !pane.path;
  const message = $('.panel-message',panel);
  message.classList.toggle('panel-error',Boolean(pane.error));
  if (pane.loading) {
    message.textContent = `${pane.pendingPath} 불러오는 중…`;
    message.hidden = false;
  } else if (pane.error) {
    message.innerHTML = `<span>${escapeHtml(pane.error.message)}<small>열지 못한 경로: ${escapeHtml(pane.error.path)}${pane.loaded?` · 현재 폴더: ${escapeHtml(pane.path)}`:''}</small></span><button class="retry-button" data-action="retry">다시 시도</button>`;
    message.hidden = false;
  } else {
    message.textContent = '';
    message.hidden = true;
  }
  renderFiles(pane);
}
function renderFiles(pane) {
  const panel = panelElement(pane);
  const rows = sortedFiles(pane);
  const visibleIds = new Set(rows.map((file) => file.id));
  pane.selected = new Set([...pane.selected].filter((id) => visibleIds.has(id)));
  const query = $('#global-search').value.trim();
  const table = `<table class="file-table" role="grid" aria-multiselectable="true" aria-label="${escapeHtml(pane.name)} 파일 목록"><colgroup><col class="name-column"><col class="date-column"><col class="size-column"></colgroup><thead><tr>${[['name','이름'],['modified','수정한 날짜'],['size','크기']].map(([key,label]) => `<th scope="col" aria-sort="${pane.sort===key?(pane.direction===1?'ascending':'descending'):'none'}"><button class="sort-button" data-sort="${key}" aria-label="${label}순 정렬">${label}${pane.sort===key?icon('sort',pane.direction===1?'sort-ascending':''):''}</button></th>`).join('')}</tr></thead><tbody>${rows.map((file) => `<tr tabindex="0" draggable="true" data-file="${file.id}" aria-selected="${pane.selected.has(file.id)}" class="${pane.selected.has(file.id)?'selected':''}" aria-label="${escapeHtml(file.name)}, ${file.type==='folder'?'폴더':sizeText(file.size)}"><td><span class="file-name">${fileIcon(file)}<span title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span></span></td><td>${modifiedDate(file.modified)}</td><td title="${file.size === null?'':escapeHtml(`${file.size.toLocaleString('ko-KR')} 바이트`)}">${sizeText(file.size)}</td></tr>`).join('')}</tbody></table>`;
  let empty = '';
  if (!rows.length) {
    const message = pane.loading ? '폴더를 불러오고 있어요' : pane.error && !pane.loaded ? '폴더를 열지 못했어요' : query && pane.loaded ? '일치하는 파일이 없어요' : pane.loaded ? '비어 있는 폴더예요' : '폴더 경로를 입력해 주세요';
    const detail = query && pane.loaded ? '다른 검색어를 입력해 보세요.' : pane.error && !pane.loaded ? '경로를 확인하거나 다시 시도해 주세요.' : '';
    empty = `<div class="empty-state">${icon(pane.error?'info':query?'search':'folder')}<p>${message}</p>${detail?`<small>${detail}</small>`:''}</div>`;
  }
  $('.file-scroll',panel).innerHTML = table + empty;
  $('.panel-count',panel).textContent = pane.loaded ? (query ? `${rows.length} / ${pane.entries.length}개 항목` : `${pane.entries.length}개 항목`) : pane.loading ? '불러오는 중' : '폴더를 확인해 주세요';
  $('.panel-footer-right',panel).innerHTML = pane.loaded ? `${icon('folder')}<span>${pane.entries.filter((file) => file.type==='folder').length}개 폴더${pane.skipped?` · ${pane.skipped}개 읽기 제외`:''}</span>` : '';
  updateSelection();
}
function updateWorkspaceView() {
  closeAddressMenu();
  closeContextMenu();
  const item = workspace();
  $('#app-workspace').textContent = item.name;
  $('#workspace-title').textContent = item.name;
  $('#workspace-description').textContent = item.description;
  $('#panels').dataset.layout = item.layout;
  const visibleIds = new Set(visiblePanes().map((pane) => pane.id));
  allPanes().forEach((pane) => {
    const panel = panelElement(pane);
    panel.hidden = !visibleIds.has(pane.id);
    const expand = $('[data-action="expand"]',panel);
    expand.innerHTML = icon(item.layout===1?'restore':'expand');
    expand.setAttribute('aria-label',`${pane.index+1}번 패널 ${item.layout===1?'4분할로 복원':'확대'}`);
    expand.title = item.layout===1?'4분할로 복원':'이 창 확대';
  });
  $$('button[data-layout]').forEach((button) => {
    button.disabled = !ready;
    button.setAttribute('aria-pressed',String(Number(button.dataset.layout) === item.layout));
  });
  updateSelection();
}
function updateSelection() {
  if (!ready) return;
  const current = activePane();
  const cutPaths = new Set(clipboard?.operation==='move' ? clipboard.sources.map(pathKey) : []);
  allPanes().forEach((pane) => {
    const panel = panelElement(pane);
    if (!panel) return;
    const active = pane.id === current.id;
    panel.classList.toggle('active',active);
    $('.active-badge',panel).hidden = !active;
    const entriesById = new Map(pane.entries.map((file) => [file.id,file]));
    $$('[data-file]',panel).forEach((row) => {
      const selected = pane.selected.has(row.dataset.file);
      row.classList.toggle('selected',selected);
      row.setAttribute('aria-selected',String(selected));
      const file = entriesById.get(row.dataset.file);
      row.classList.toggle('cut-pending',cutPaths.has(pathKey(file?.path)));
    });
  });
  $('#refresh-button').disabled = !current.path;
  $('#file-info-button').disabled = !selectedFile();
  const files = selectedFiles();
  const canTransfer = typeof bridge.transfer === 'function' && !transferPending;
  $('#copy-button').disabled = !canTransfer || !files.length || current.loading || Boolean(current.error);
  $('#cut-button').disabled = !canTransfer || !files.length || current.loading || Boolean(current.error);
  $('#transfer-button').disabled = !canTransfer || !files.length || current.loading || Boolean(current.error);
  $('#paste-button').disabled = !canTransfer || !clipboard?.sources.length || !current.loaded || current.loading || Boolean(current.error);
  const favoriteExists = combinedFavorites().some((item) => samePath(item.path,current.path));
  $('#add-favorite-button').disabled = !current.loaded || current.loading || favoriteExists || typeof bridge.savePreferences !== 'function';
  $('#add-favorite-button').title = favoriteExists ? '이미 즐겨찾기에 있는 폴더' : '현재 폴더 즐겨찾기 추가';
  const clipboardStatus = $('#clipboard-status');
  clipboardStatus.textContent = transferPending ? mutationLabel || '파일 작업 중… 완료될 때까지 기다려 주세요.' : clipboard ? `${clipboard.sources.length}개 항목 ${clipboard.operation==='move'?'이동':'복사'} 준비 · 대상 창에서 붙여넣기 (Ctrl + V)` : '오른쪽 클릭으로 파일 작업 · 창 사이로 끌어서 이동';
  clipboardStatus.title = clipboardStatus.textContent;
  $('#activity-strip').setAttribute('aria-busy',String(transferPending));
  $('#paste-button').setAttribute('aria-busy',String(transferPending));
  $('#toolbar-context').innerHTML = `${icon('folder')}<span>현재 창</span><strong title="${escapeHtml(current.path)}">${escapeHtml(current.name)}</strong>`;
  $('#selection-status').textContent = files.length ? `${files.length}개 선택${files.some((file) => file.type!=='folder')?` · ${sizeText(files.reduce((total,file) => total+(file.size || 0),0))}`:''}` : `${visiblePanes().length}개 창 열림`;
  $('#selection-status').classList.toggle('selection-description',Boolean(files.length));
}
function activate(pane) {
  if (!pane || pane.workspaceId !== workspaceId) return;
  if (workspace().active === pane.index) return;
  workspace().active = pane.index;
  updateSelection();
  persistSession();
}
function focusPaneContent(pane,fileId) {
  const panel = panelElement(pane);
  if (!panel || panel.hidden) return;
  const target = (fileId ? $$('[data-file]',panel).find((row) => row.dataset.file===fileId) : $('[data-file]',panel)) || panel;
  target.focus({preventScroll:true});
  if (target !== panel) target.scrollIntoView({block:'nearest'});
}
async function navigate(pane,requestedPath,options = {}) {
  if (!ready || !pane || typeof requestedPath !== 'string') return;
  if (openAddressPane === pane) closeAddressMenu();
  if (contextMenuState?.pane === pane) closeContextMenu();
  const token = ++pane.requestToken;
  const draftVersion = pane.draftVersion;
  const mayUpdateDraft = !options.preserveDraft || !pane.dirty;
  const previousPath = pane.path;
  const previousSelected = new Set(selectedFiles(pane).map((file) => pathKey(file.path)));
  const previousAnchor = pane.entries.find((file) => file.id===pane.selectionAnchor)?.path;
  pane.loading = true;
  pane.error = null;
  pane.pendingPath = requestedPath;
  renderPanel(pane);
  try {
    const result = await bridge.listDirectory(requestedPath);
    if (token !== pane.requestToken) return;
    if (!result?.ok) throw new Error(result?.error?.message || '폴더를 열지 못했어요. 경로를 확인해 주세요.');
    const directory = result.value;
    if (typeof directory?.path !== 'string' || !Array.isArray(directory.entries)) throw new Error('폴더 정보를 읽지 못했어요. 다시 시도해 주세요.');
    const changedPath = !samePath(directory.path,previousPath);
    if (options.back) pane.history.pop();
    else if (changedPath && pane.loaded && !options.initial) pane.history.push(previousPath);
    pane.path = directory.path;
    pane.name = directory.name || directory.path;
    pane.parent = directory.parent;
    pane.breadcrumbs = directory.breadcrumbs;
    pane.entries = directory.entries.map((file,index) => ({...file,id:`${pane.id}-r${token}-${index}`}));
    pane.skipped = directory.skipped || 0;
    pane.selected = !changedPath ? new Set(pane.entries.filter((file) => previousSelected.has(pathKey(file.path))).map((file) => file.id)) : new Set();
    pane.selectionAnchor = !changedPath ? pane.entries.find((file) => samePath(file.path,previousAnchor))?.id || null : null;
    pane.loaded = true;
    pane.loading = false;
    pane.pendingPath = null;
    if (pane.draftVersion === draftVersion && mayUpdateDraft) {
      pane.draft = pane.path;
      pane.dirty = false;
      addressElement(pane).value = pane.path;
    }
    renderPanel(pane);
    if (changedPath) persistSession();
    if (!options.initial && !options.refresh) rememberPath(directory.path);
    // Only the pane that initiated the request may receive focus; never steal it from another pane or a new draft.
    const focusedPane = paneFromElement(document.activeElement);
    if (options.focus && pane.workspaceId === workspaceId && activePane() === pane && pane.draftVersion === draftVersion && (!focusedPane || focusedPane === pane) && !document.activeElement.matches('#global-search, .path-input')) focusPaneContent(pane);
  } catch (error) {
    if (token !== pane.requestToken) return;
    pane.loading = false;
    pane.pendingPath = null;
    pane.error = {path:requestedPath,message:error.message || '폴더를 열지 못했어요. 경로를 확인해 주세요.'};
    if (options.refresh && samePath(requestedPath,pane.path)) {
      pane.loaded = false;
      pane.entries = [];
      pane.selected.clear();
      pane.selectionAnchor = null;
    }
    if (pane.draftVersion === draftVersion && mayUpdateDraft) {
      pane.draft = pane.path;
      pane.dirty = false;
      addressElement(pane).value = pane.path;
    }
    renderPanel(pane);
  }
  if (token === pane.requestToken && pane.refreshAfterLoad) {
    pane.refreshAfterLoad = false;
    const relocations = pane.refreshRelocations || [];
    pane.refreshRelocations = [];
    const failedDestination = pane.error && samePath(pane.error.path,requestedPath) && relocations.some((item) => pathWithin(requestedPath,item.source));
    navigate(pane,relocatedPath(failedDestination?requestedPath:pane.path,relocations),{refresh:true,preserveDraft:true});
  }
}
function setLayout(layout) {
  if (!ready) return;
  const item = workspace();
  if (layout === 2 && item.active > 1) item.active = 0;
  item.layout = layout;
  updateWorkspaceView();
  visiblePanes().forEach(renderFiles);
  persistSession();
}
function showToast(message) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'),2800);
}
function openInfo(file) {
  if (!file) return;
  $('#info-icon').innerHTML = fileIcon(file);
  $('#info-title').textContent = file.name;
  const extension = file.name.includes('.') ? file.name.split('.').pop().toUpperCase() : '';
  const kind = file.type==='folder'?'폴더':extension?`${extension} 파일`:'파일';
  $('#info-content').innerHTML = `<p class="info-label">파일 정보</p><dl class="properties"><dt>종류</dt><dd>${escapeHtml(kind)}${file.isSymbolicLink?' (링크)':''}</dd><dt>크기</dt><dd>${sizeText(file.size)}${typeof file.size==='number'?` (${file.size.toLocaleString('ko-KR')} 바이트)`:''}</dd><dt>수정한 날짜</dt><dd>${escapeHtml(dateText(file.modified,true))}</dd><dt>경로</dt><dd>${escapeHtml(file.path)}</dd></dl>`;
  $('#info-dialog').showModal();
}
function openFile(pane,file) {
  if (!file) return;
  if (file.type==='folder') navigate(pane,file.path,{focus:true});
  else invokeOpen(file.path);
}
function showUnavailable(message,retry = false) {
  ready = false;
  renderSidebar();
  $('#connection-status').textContent = hasNativeBridge?'PC 연결 실패':'포터블 앱 전용';
  $('#storage-status').textContent = hasNativeBridge?'PC 연결을 확인해 주세요':'포터블 앱에서 위치 자동 저장';
  $('#panels').dataset.layout = '1';
  $('#panels').innerHTML = `<section class="native-required">${icon('desktop')}<h2>${escapeHtml(message)}</h2><p>${hasNativeBridge?'PC 연결을 다시 확인해 주세요.':'다운로드한 Quadpane 포터블 실행파일을 열면 이 PC의 드라이브와 폴더를 탐색할 수 있어요.'}</p>${retry?'<button class="primary-button" id="bootstrap-retry">다시 연결</button>':''}</section>`;
  $('#global-search').disabled = true;
  $('#refresh-button').disabled = true;
  $('#file-info-button').disabled = true;
  ['copy-button','cut-button','paste-button','transfer-button','add-favorite-button'].forEach((id) => {$(`#${id}`).disabled=true;});
  $$('button[data-layout]').forEach((button) => {button.disabled=true;});
}
async function bootstrap() {
  const token = ++bootstrapToken;
  if (!hasNativeBridge) {
    showUnavailable('PC 파일을 탐색하려면 포터블 앱에서 실행하세요');
    return;
  }
  $('#panels').innerHTML = `<section class="native-required">${icon('drive')}<h2>이 PC의 폴더를 불러오고 있어요</h2></section>`;
  try {
    const result = await bridge.bootstrap();
    if (token !== bootstrapToken) return;
    if (!result?.ok) throw new Error(result?.error?.message || '이 PC의 폴더를 불러오지 못했어요.');
    favorites = result.value.favorites || [];
    userFavorites = result.value.preferences?.favorites || [];
    recentPaths = result.value.preferences?.recentPaths || [];
    drives = result.value.drives || [];
    startupWarning = [result.value.sessionWarning,result.value.preferencesWarning].filter(Boolean).join(' ');
    const session = isSessionValid(result.value.session) ? result.value.session : defaultSession();
    workspaceId = session.workspaceId;
    workspaces = Object.fromEntries(Object.entries(workspaceDefinitions).map(([id,definition]) => {
      const saved = session.workspaces[id];
      return [id,{...definition,layout:saved.layout,active:saved.layout===2 && saved.active>1?0:saved.active,panes:saved.panes.map((pane,index) => makePane(id,index,pane))}];
    }));
    ready = true;
    $('#panels').innerHTML = '';
    allPanes().forEach(createPanel);
    renderSidebar();
    updateWorkspaceView();
    $('#global-search').disabled = false;
    $('#connection-status').textContent = '이 PC에 연결됨';
    $('#storage-status').textContent = '폴더 위치 자동 저장';
    renderStorageMessage();
    if (!result.value.session) persistSession();
    allPanes().forEach((pane) => {navigate(pane,pane.path,{initial:true});});
  } catch (error) {
    if (token !== bootstrapToken) return;
    showUnavailable(error.message || '이 PC의 폴더를 불러오지 못했어요.',true);
  }
}

$('#search-icon').innerHTML = icon('search');
$('#help-button').innerHTML = icon('help');
$('#tip-icon').innerHTML = icon('tip');
$('#refresh-icon').innerHTML = icon('refresh');
$('#file-info-icon').innerHTML = icon('info');
$('#add-favorite-button').innerHTML = icon('plus');
$('#copy-icon').innerHTML = icon('copy');
$('#cut-icon').innerHTML = icon('cut');
$('#paste-icon').innerHTML = icon('paste');
$('#transfer-icon').innerHTML = icon('transfer');
$('#transfer-dialog-icon').innerHTML = icon('transfer');
$('#trash-dialog-icon').innerHTML = icon('trash');
$$('button[data-layout]').forEach((button) => {
  button.innerHTML = icon({1:'one',2:'two',4:'four'}[button.dataset.layout]);
  button.addEventListener('click',() => setLayout(Number(button.dataset.layout)));
});
$('#workspaces').addEventListener('click',(event) => {
  const button = event.target.closest('[data-workspace]');
  if (!ready || !button || button.dataset.workspace === workspaceId) return;
  workspaceId = button.dataset.workspace;
  $('#global-search').value = '';
  renderSidebar();
  updateWorkspaceView();
  visiblePanes().forEach(renderFiles);
  persistSession();
});
$('.sidebar').addEventListener('click',(event) => {
  if (!ready) return;
  const remove = event.target.closest('[data-remove-favorite]');
  if (remove) {
    userFavorites.splice(Number(remove.dataset.removeFavorite),1);
    renderSidebar();
    updateSelection();
    persistPreferences();
    showToast('즐겨찾기에서 제거했어요.');
    return;
  }
  const favorite = event.target.closest('[data-favorite]');
  const customFavorite = event.target.closest('[data-custom-favorite]');
  const drive = event.target.closest('[data-drive]');
  const path = favorite ? favorites[Number(favorite.dataset.favorite)]?.path : customFavorite ? userFavorites[Number(customFavorite.dataset.customFavorite)]?.path : drive ? drives[Number(drive.dataset.drive)]?.path : null;
  if (path) navigate(activePane(),path);
});
$('#panels').addEventListener('focusin',(event) => {if (ready) activate(paneFromElement(event.target));});
$('#panels').addEventListener('input',(event) => {
  if (!event.target.matches('.path-input')) return;
  const pane = paneFromElement(event.target);
  pane.draft = event.target.value;
  pane.dirty = true;
  pane.draftVersion++;
});
$('#panels').addEventListener('submit',(event) => {
  if (!event.target.matches('.path-form')) return;
  event.preventDefault();
  const pane = paneFromElement(event.target);
  activate(pane);
  navigate(pane,$('.path-input',event.target).value);
});
$('#panels').addEventListener('click',(event) => {
  if (event.target.closest('#bootstrap-retry')) {bootstrap();return;}
  if (!ready) return;
  const pane = paneFromElement(event.target);
  if (!pane) return;
  activate(pane);
  const addressOption = event.target.closest('[data-address-option]');
  if (addressOption) {
    const path = pane.addressOptions[Number(addressOption.dataset.addressOption)];
    closeAddressMenu();
    if (path) navigate(pane,path,{focus:true});
    return;
  }
  const row = event.target.closest('[data-file]');
  if (row) {selectFile(pane,row.dataset.file,{toggle:event.ctrlKey || event.metaKey,range:event.shiftKey});return;}
  if (event.target.closest('.file-scroll') && !event.target.closest('thead')) {
    pane.selected.clear();
    pane.selectionAnchor = null;
    updateSelection();
    panelElement(pane).focus({preventScroll:true});
  }
  const sort = event.target.closest('[data-sort]');
  if (sort) {
    const key = sort.dataset.sort;
    if (pane.sort===key) pane.direction *= -1;
    else {pane.sort=key;pane.direction=1;}
    renderFiles(pane);
    $(`[data-sort="${key}"]`,panelElement(pane)).focus({preventScroll:true});
    persistSession();
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action==='address-menu') {if (openAddressPane===pane) closeAddressMenu();else openAddressMenu(pane);}
  if (action==='back' && pane.history.length) navigate(pane,pane.history.at(-1),{back:true,focus:true});
  if (action==='up' && pane.parent) navigate(pane,pane.parent,{focus:true});
  if (action==='refresh') navigate(pane,pane.path,{refresh:true,preserveDraft:true});
  if (action==='retry' && pane.error) navigate(pane,pane.error.path);
  if (action==='expand') setLayout(workspace().layout===1?4:1);
});
$('#panels').addEventListener('dblclick',(event) => {
  const row = event.target.closest('[data-file]');
  if (!row) return;
  const pane = paneFromElement(row);
  openFile(pane,pane.entries.find((file) => file.id===row.dataset.file));
});
$('#panels').addEventListener('contextmenu',(event) => {
  const scroll = event.target.closest('.file-scroll');
  if (!scroll || !ready) return;
  event.preventDefault();
  openContextMenu(paneFromElement(scroll),event.target.closest('[data-file]'),event.clientX,event.clientY);
});
$('#file-context-menu').addEventListener('click',(event) => {
  const button = event.target.closest('[data-context-action]');
  if (!button || button.disabled || !contextMenuState) return;
  const state = contextMenuState;
  const action = button.dataset.contextAction;
  closeContextMenu(true);
  activate(state.pane);
  const file = selectedFile();
  if (action==='open') openFile(state.pane,file);
  if (action==='copy') copySelection('copy');
  if (action==='cut') copySelection('move');
  if (action==='paste' && clipboard) performTransfer(clipboard.sources,state.pasteTarget,clipboard.operation,true);
  if (action==='transfer') openTransferDialog();
  if (action==='rename') openNameDialog('rename');
  if (action==='newfolder') openNameDialog('create');
  if (action==='trash') openTrashDialog();
  if (action==='info') openInfo(file);
  if (action==='reveal') invokeOpen(file?.path || state.pane.path,true);
  if (action==='refresh') navigate(state.pane,state.pane.path,{refresh:true,preserveDraft:true});
  if (action==='selectall') {state.pane.selected = new Set(sortedFiles(state.pane).map((item) => item.id));updateSelection();}
});
$('#file-context-menu').addEventListener('keydown',(event) => {
  const buttons = $$('.context-menu-item:not(:disabled)',$('#file-context-menu'));
  const index = buttons.indexOf(document.activeElement);
  if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
    event.preventDefault();event.stopPropagation();
    const next = event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowDown'?(index+1)%buttons.length:(index-1+buttons.length)%buttons.length;
    buttons[next]?.focus({preventScroll:true});
    buttons[next]?.scrollIntoView({block:'nearest'});
  }
  if (event.key==='Escape' || event.key==='Tab') {event.preventDefault();event.stopPropagation();closeContextMenu(true);}
});
$('#panels').addEventListener('dragstart',(event) => {
  const row = event.target.closest('[data-file]');
  const pane = row && paneFromElement(row);
  if (!pane || pane.loading || pane.error || transferPending) {event.preventDefault();return;}
  activate(pane);
  if (!pane.selected.has(row.dataset.file)) selectFile(pane,row.dataset.file);
  const sources = selectedFiles(pane).map((file) => file.path);
  if (!sources.length) {event.preventDefault();return;}
  closeAddressMenu();closeContextMenu();closeTransferResult();
  if (event.altKey && typeof bridge.beginNativeDrag==='function') {
    event.preventDefault();
    clearDragState();
    nativeDragOut = true;
    Promise.resolve(bridge.beginNativeDrag(sources)).then((result) => {
      if (!result?.ok) showToast(result?.error?.message || '파일을 창 밖으로 끌지 못했어요.');
    }).catch((error) => showToast(error.message || '파일을 창 밖으로 끌지 못했어요.'));
    return;
  }
  internalDrag = {sources,originPaneId:pane.id,token:crypto.randomUUID()};
  event.dataTransfer.effectAllowed = 'copyMove';
  // The payload identifies this live selection; file paths are never accepted from HTML drag text.
  event.dataTransfer.setData('application/x-pane-selection',internalDrag.token);
  $$('[data-file]',panelElement(pane)).filter((item) => pane.selected.has(item.dataset.file)).forEach((item) => item.classList.add('drag-source'));
});
$('#panels').addEventListener('dragover',(event) => {
  if (!hasSupportedDrop(event)) return;
  event.preventDefault();
  const target = getDropTarget(event);
  if (!target || internalDrag?.sources.some((source) => pathWithin(target.path,source))) {
    clearDropFeedback();event.dataTransfer.dropEffect='none';return;
  }
  event.dataTransfer.dropEffect = showDropFeedback(target,event);
});
$('#panels').addEventListener('dragleave',(event) => {
  if (dropTarget && !dropTarget.element.contains(event.relatedTarget)) clearDropFeedback();
});
$('#panels').addEventListener('drop',(event) => {
  if (!hasSupportedDrop(event)) return;
  event.preventDefault();event.stopPropagation();
  const target = getDropTarget(event);
  let sources = [];
  try {
    if (internalDrag && event.dataTransfer.getData('application/x-pane-selection')===internalDrag.token) sources=[...internalDrag.sources];
    else if (typeof bridge.droppedPaths==='function' && event.dataTransfer.files.length) sources=bridge.droppedPaths(Array.from(event.dataTransfer.files));
  } catch {showToast('끌어온 파일 경로를 확인하지 못했어요.');}
  const validSources = Array.isArray(sources) ? [...new Set(sources.filter((source) => typeof source==='string' && source))] : [];
  const operation = target && validSources.length ? dropOperation(validSources,target.path,event) : null;
  clearDragState();
  if (!target || !validSources.length) return;
  if (validSources.some((source) => pathWithin(target.path,source))) {showToast('자기 자신이나 하위 폴더에는 놓을 수 없어요.');return;}
  activate(target.pane);
  performTransfer(validSources,target.path,operation);
});
document.addEventListener('dragend',clearDragState);
document.addEventListener('dragover',(event) => {
  if (!hasSupportedDrop(event)) return;
  event.preventDefault();
  if (!event.target.closest?.('.file-scroll')) {clearDropFeedback();event.dataTransfer.dropEffect='none';}
});
document.addEventListener('drop',(event) => {
  if (hasSupportedDrop(event)) event.preventDefault();
  clearDragState();
});
$('#panels').addEventListener('keydown',(event) => {
  if (event.target.closest('.address-menu')) {
    const menu = event.target.closest('.address-menu');
    const options = $$('.address-option',menu);
    const index = options.indexOf(event.target.closest('.address-option'));
    if (['ArrowDown','ArrowUp','Home','End','Escape','Tab'].includes(event.key)) {
      if (event.key!=='Tab') event.preventDefault();
      event.stopPropagation();
      if (event.key==='Escape' || event.key==='Tab') {closeAddressMenu(true);return;}
      const next = event.key==='Home'?0:event.key==='End'?options.length-1:event.key==='ArrowDown'?(index+1)%options.length:(index-1+options.length)%options.length;
      options[next]?.focus({preventScroll:true});
      options[next]?.scrollIntoView({block:'nearest'});
    }
    return;
  }
  if (event.target.matches('.path-dropdown-toggle') && ['ArrowDown','ArrowUp'].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    openAddressMenu(paneFromElement(event.target));
    return;
  }
  if (event.target.matches('.path-input')) {
    if (event.altKey && event.key==='ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      openAddressMenu(paneFromElement(event.target));
      return;
    }
    if (event.key==='Escape') {
      event.preventDefault();
      event.stopPropagation();
      const pane = paneFromElement(event.target);
      pane.draft = pane.path;
      pane.dirty = false;
      pane.draftVersion++;
      event.target.value = pane.path;
      event.target.select();
    }
    return;
  }
  const row = event.target.closest('[data-file]');
  if (!row) return;
  const pane = paneFromElement(row);
  if (!['Enter',' ','ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
  event.preventDefault();
  activate(pane);
  if (event.key==='Enter') {
    event.stopPropagation();
    const file = pane.entries.find((item) => item.id===row.dataset.file);
    if (event.altKey) openInfo(file);else openFile(pane,file);
    return;
  }
  if (event.key===' ') {selectFile(pane,row.dataset.file,{toggle:event.ctrlKey || event.metaKey,range:event.shiftKey});return;}
  const next = event.key==='ArrowDown'?row.nextElementSibling:event.key==='ArrowUp'?row.previousElementSibling:event.key==='Home'?row.parentElement.firstElementChild:event.key==='End'?row.parentElement.lastElementChild:null;
  if (next) {
    next.focus();
    if (!(event.ctrlKey || event.metaKey) || event.shiftKey) selectFile(pane,next.dataset.file,{toggle:event.ctrlKey || event.metaKey,range:event.shiftKey});
  }
});
$('#global-search').addEventListener('input',() => {if (ready) visiblePanes().forEach(renderFiles);});
$('#refresh-button').addEventListener('click',() => navigate(activePane(),activePane().path,{refresh:true,preserveDraft:true}));
$('#file-info-button').addEventListener('click',() => openInfo(selectedFile()));
$('#add-favorite-button').addEventListener('click',addFavorite);
$('#copy-button').addEventListener('click',() => copySelection('copy'));
$('#cut-button').addEventListener('click',() => copySelection('move'));
$('#paste-button').addEventListener('click',pasteSelection);
$('#transfer-button').addEventListener('click',openTransferDialog);
$('#transfer-result').addEventListener('click',(event) => {
  if (event.target.closest('[data-dismiss-transfer]')) closeTransferResult(true);
});
$('#operation-results-button').addEventListener('click',openTransferResult);
$('#transfer-result').addEventListener('keydown',(event) => {
  if (event.key==='Escape') {event.preventDefault();event.stopPropagation();closeTransferResult(true);}
});
$('#transfer-dialog').addEventListener('change',(event) => {
  if (event.target.matches('[name="transfer-destination"]')) {
    const pane = allPanes().find((item) => item.id === event.target.value);
    transferDraft.destination = pane?.path || null;
    $('#transfer-confirm').disabled = !transferDraft.destination;
  }
  $('#transfer-confirm').textContent = `선택한 폴더에 ${$('[name="transfer-operation"]:checked').value==='move'?'이동':'복사'}`;
});
$('#transfer-confirm').addEventListener('click',() => {
  if (!transferDraft?.destination) return;
  const {sources,destination} = transferDraft;
  const operation = $('[name="transfer-operation"]:checked').value;
  $('#transfer-dialog').close();
  transferDraft = null;
  performTransfer(sources,destination,operation);
});
$('#name-form').addEventListener('submit',async (event) => {
  event.preventDefault();
  if (!nameDraft || transferPending) return;
  const draft = nameDraft;
  const name = $('#name-input').value;
  if (!name.trim()) {$('#name-error').textContent='이름을 입력해 주세요.';$('#name-error').hidden=false;return;}
  $('#name-error').hidden = true;
  const controls = $$('button,input',$('#name-dialog'));
  controls.forEach((control) => {control.disabled=true;});
  try {
    await runMutation(draft.kind==='rename'?'이름 변경 중…':'폴더 만드는 중…',draft.kind,draft.path,async () => {
      const response = draft.kind==='rename' ? await bridge.renameItem({path:draft.path,name}) : await bridge.createFolder({parent:draft.path,name});
      if (!response?.ok) {
        $('#name-error').textContent = response?.error?.message || '이름을 확인하고 다시 시도해 주세요.';
        $('#name-error').hidden = false;
        return;
      }
      $('#name-dialog').close();
      nameDraft = null;
      const createdPath = response.value.path;
      if (draft.kind==='rename') {
        remapReferences(draft.path,createdPath);
        await refreshAffected((path) => samePath(path,parentPath(draft.path)) || pathWithin(path,draft.path),[{source:draft.path,destination:createdPath}]);
      } else await refreshAffected((path) => samePath(path,draft.path));
      const current = draft.pane.entries.find((file) => samePath(file.path,createdPath));
      if (current) {selectFile(draft.pane,current.id);focusPaneContent(draft.pane,current.id);}
      showTransferResult({operation:draft.kind,completed:[{source:createdPath}],skipped:[],failed:[]});
    });
  } finally {
    controls.forEach((control) => {control.disabled=false;});
    if ($('#name-dialog').open) {$('#name-input').focus();$('#name-input').select();}
  }
});
$('#name-dialog').addEventListener('cancel',(event) => {if (transferPending) event.preventDefault();});
$('#trash-confirm').addEventListener('click',async () => {
  if (!trashDraft || transferPending) return;
  const {paths:selection} = trashDraft;
  $('#trash-dialog').close();
  trashDraft = null;
  await runMutation(`${selection.length}개 항목을 휴지통으로 이동 중…`,'trash',selection[0],async () => {
    const response = await bridge.trashItems({paths:selection});
    if (!response?.ok) throw new Error(response?.error?.message || '휴지통으로 이동하지 못했어요.');
    const result = response.value;
    const completed = result.completed.map((item) => item.source);
    if (clipboard) {
      clipboard.sources = clipboard.sources.filter((source) => !completed.some((path) => pathWithin(source,path)));
      if (!clipboard.sources.length) clipboard=null;
      clipboardRevision++;
    }
    showTransferResult(result);
    await refreshAffected((path) => selection.some((source) => samePath(path,parentPath(source)) || pathWithin(path,source)));
  });
});
$$('[data-close-dialog]').forEach((button) => button.addEventListener('click',() => button.closest('dialog').close()));
$('#help-button').addEventListener('click',() => {
  $('#info-icon').innerHTML=icon('grid');
  $('#info-title').textContent='pane 사용 안내';
  $('#info-content').innerHTML='<p class="dialog-subtitle">여러 폴더를 나란히 보고, 마지막 위치에서 이어서 탐색하세요.</p><ul class="help-list"><li>주소창에 경로를 입력하고 <kbd>Enter</kbd>를 누르세요. <kbd>Ctrl + L</kbd>은 주소 선택, <kbd>Alt + ↓</kbd>는 경로 목록이에요.</li><li>즐겨찾기 옆 <strong>＋</strong>로 현재 폴더를 추가할 수 있어요. 열린 위치·분할·정렬·즐겨찾기는 다시 실행해도 유지돼요.</li><li><kbd>Ctrl</kbd> 또는 <kbd>Shift</kbd>와 함께 클릭하면 여러 항목을 선택해요. <kbd>Ctrl + A</kbd>로 모두 선택할 수 있어요.</li><li>파일과 빈 공간에서 <strong>오른쪽 클릭</strong>하면 작업 메뉴를 열어요. 키보드에서는 <kbd>Shift + F10</kbd> 또는 메뉴 키를 사용하세요.</li><li><kbd>Ctrl + C</kbd> 복사, <kbd>Ctrl + X</kbd> 잘라내기 후 다른 창이나 작업 공간에서 <kbd>Ctrl + V</kbd>로 붙여넣으세요.</li><li>선택한 항목을 다른 창이나 폴더에 끌어 놓으세요. 같은 드라이브는 이동, 다른 드라이브는 복사하며 <kbd>Ctrl</kbd>은 복사, <kbd>Shift</kbd>는 이동이에요. 같은 이름의 항목은 건너뜁니다.</li><li>Windows 탐색기의 파일도 끌어올 수 있어요. pane에서 다른 앱으로 끌어낼 때는 <kbd>Alt</kbd>를 누른 채 드래그를 시작하세요.</li><li>두 번 클릭하거나 <kbd>Enter</kbd>를 누르면 폴더 또는 연결된 앱에서 파일을 열어요. <kbd>Alt + Enter</kbd>로 파일 정보를 확인하세요.</li><li><kbd>F2</kbd> 이름 변경, <kbd>Ctrl + Shift + N</kbd> 새 폴더, <kbd>Delete</kbd> 휴지통 이동을 지원해요. 삭제는 확인 후 실행합니다.</li><li><kbd>Alt + ↑</kbd> 상위 폴더, <kbd>Alt + ←</kbd> 이전 폴더, <kbd>F5</kbd> 새로고침, <kbd>Ctrl + K</kbd> 검색을 지원해요.</li></ul>';
  $('#info-dialog').showModal();
});
document.addEventListener('keydown',(event) => {
  if ($('dialog[open]') || !ready) return;
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && key==='k') {event.preventDefault();closeAddressMenu();$('#global-search').focus();$('#global-search').select();return;}
  if ((event.ctrlKey || event.metaKey) && key==='l') {event.preventDefault();closeAddressMenu();addressElement(activePane()).focus();addressElement(activePane()).select();return;}
  if (event.key==='F5') {event.preventDefault();navigate(activePane(),activePane().path,{refresh:true,preserveDraft:true});return;}
  const editing = document.activeElement.matches('input,textarea,[contenteditable="true"]');
  if (event.key==='Escape' && contextMenuState) {event.preventDefault();closeContextMenu(true);return;}
  if (event.key==='Escape' && $('#transfer-result').matches(':popover-open')) {event.preventDefault();closeTransferResult(true);return;}
  if (!editing && (event.key==='ContextMenu' || (event.shiftKey && event.key==='F10'))) {
    event.preventDefault();
    const pane = paneFromElement(document.activeElement) || activePane();
    const focusedRow = document.activeElement.closest('[data-file]');
    const selectedRow = $$('[data-file]',panelElement(pane)).find((row) => pane.selected.has(row.dataset.file));
    const row = focusedRow || selectedRow;
    const rect = (row || $('.file-scroll',panelElement(pane))).getBoundingClientRect();
    openContextMenu(pane,row,rect.left+24,Math.min(rect.bottom,rect.top+28));
    return;
  }
  if (!editing && (event.ctrlKey || event.metaKey) && event.shiftKey && key==='n') {event.preventDefault();openNameDialog('create');return;}
  if (!editing && event.key==='F2') {event.preventDefault();openNameDialog('rename');return;}
  if (!editing && event.key==='Delete') {event.preventDefault();openTrashDialog();return;}
  if (!editing && event.altKey && event.key==='Enter') {event.preventDefault();openInfo(selectedFile());return;}
  if (!editing && (event.ctrlKey || event.metaKey) && ['a','c','x','v'].includes(key)) {
    event.preventDefault();
    if (key==='a') {activePane().selected = new Set(sortedFiles(activePane()).map((file) => file.id));updateSelection();}
    if (key==='c') copySelection('copy');
    if (key==='x') copySelection('move');
    if (key==='v') pasteSelection();
    return;
  }
  if (!editing && event.altKey && event.key==='ArrowUp' && activePane().parent) {event.preventDefault();navigate(activePane(),activePane().parent,{focus:true});return;}
  if (!editing && event.altKey && event.key==='ArrowLeft' && activePane().history.length) {event.preventDefault();navigate(activePane(),activePane().history.at(-1),{back:true,focus:true});return;}
  if (event.key==='Escape' && openAddressPane) {event.preventDefault();closeAddressMenu(true);return;}
  if (event.key==='Escape' && $('#global-search').value) {$('#global-search').value='';visiblePanes().forEach(renderFiles);return;}
  if (event.key==='Escape' && !editing && clipboard && !transferPending) {clipboard=null;clipboardRevision++;updateSelection();}
});
document.addEventListener('pointerdown',(event) => {
  if (openAddressPane && !event.target.closest('.address-menu,.path-dropdown-toggle')) closeAddressMenu();
  if (contextMenuState && !event.target.closest('#file-context-menu')) closeContextMenu();
  if ($('#transfer-result').matches(':popover-open') && !event.target.closest('#transfer-result,#operation-results-button')) closeTransferResult();
});
window.addEventListener('resize',() => {closeAddressMenu();closeContextMenu();closeTransferResult();clearDropFeedback();});
window.addEventListener('focus',() => {
  if (!nativeDragOut || !ready || transferPending) return;
  nativeDragOut = false;
  allPanes().filter((pane) => pane.loaded && !pane.loading).forEach((pane) => navigate(pane,pane.path,{refresh:true,preserveDraft:true}));
});
renderSidebar();
bootstrap();
