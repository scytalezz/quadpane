'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const boundary = source.indexOf("$('#search-icon').innerHTML");
assert.ok(boundary > 0, 'app.js DOM initialization boundary must exist');
const prefix = new vm.Script(source.slice(0, boundary), { filename: 'app.js' });
const retryAction = source.split(/\r?\n/).find(line => line.trimStart().startsWith("if (action==='retry' && pane.error)"));
assert.ok(retryAction, 'app.js Retry action must exist');
const [A, B, C, D, E, X, Y] = ['A', 'B', 'C', 'D', 'E', 'X', 'Y'].map(name => `C:\\${name}`);
const listed = target => ({ ok: true, value: { path: target, entries: [], breadcrumbs: [], parent: 'C:\\' } });
const state = pane => JSON.parse(JSON.stringify([pane.path, pane.history, pane.forwardHistory]));
const check = (name, fn) => test(name, { timeout: 2000 }, fn);

function fixture() {
  const calls = [];
  let reply = listed;
  const input = { value: '' };
  const document = {
    modal: false, activeElement: { closest: () => null, matches: () => false },
    querySelector(selector) { assert.equal(selector, 'dialog[open]'); return this.modal ? {} : null; },
    getElementById: () => ({ querySelector(selector) { assert.equal(selector, '.path-input'); return input; } }),
  };
  const bridge = { bootstrap() {}, saveSession() {}, listDirectory(target) { calls.push(target); return reply(target); } };
  const context = vm.createContext({ document, window: { pane: bridge } });
  prefix.runInContext(context, { timeout: 1000 });
  const run = code => vm.runInContext(code, context, { timeout: 1000 });
  // Replace side effects AFTER loading, retaining the actual navigation, factory and remapping functions.
  const api = run(`
    renderPanel = renderSidebar = persistSession = persistPreferences = focusPaneContent = () => {};
    ready = true;
    workspaces = {design:{layout:2,active:0,panes:['C:\\\\A','C:\\\\X'].map((path,index) =>
      makePane('design',index,{path,sort:'name',direction:1}))}};
    ({panes:allPanes(),navigate,history:(...args) => navigateHistory(...args),remapReferences,refreshAffected,samePath});
  `);
  return { ...api, calls, document, run, setReply(fn) { reply = fn; } };
}
async function atBranch() {
  const h = fixture(), p = h.panes[0];
  await h.navigate(p, A, { initial: true });
  await h.navigate(p, B);
  await h.navigate(p, C);
  await h.history('back');
  return h;
}
async function queueRelocations(h, affectedPath, relocations) {
  for (const { source, destination } of relocations) h.remapReferences(source, destination);
  await h.refreshAffected(value => h.samePath(value, affectedPath), relocations);
}

check('pane factory creates independent empty back and forward stacks', async () => {
  const h = fixture(), [p, other] = h.panes;
  assert.deepEqual(state(p), [A, [], []]);
  assert.deepEqual(state(other), [X, [], []]);
  assert.notEqual(p.history, other.history);
  assert.notEqual(p.forwardHistory, other.forwardHistory);
  await h.history('back');
  await h.history('forward');
  assert.deepEqual(h.calls, []);
  await h.navigate(p, A, { initial: true });
  assert.deepEqual(state(p), [A, [], []]);
});

check('A → B → C round trips and a successful branch clears forward history', async () => {
  const h = fixture(), p = h.panes[0];
  for (const target of [A, B, C]) await h.navigate(p, target);
  assert.deepEqual(state(p), [C, [A, B], []]);
  for (const [direction, expected] of [
    ['back', [B, [A], [C]]], ['back', [A, [], [C, B]]],
    ['forward', [B, [A], [C]]], ['forward', [C, [A, B], []]], ['back', [B, [A], [C]]],
  ]) { await h.history(direction); assert.deepEqual(state(p), expected); }
  await h.navigate(p, D);
  assert.deepEqual(state(p), [D, [A, B], []]);
  const count = h.calls.length;
  await h.history('forward');
  assert.equal(h.calls.length, count);
});

check('same paths, refreshes and initial loads preserve both stacks', async () => {
  const h = await atBranch(), p = h.panes[0];
  for (const [target, options] of [['c:/b/', {}], [B, { refresh: true }],
    [D, { refresh: true }], [E, { initial: true }]]) {
    await h.navigate(p, target, options);
    assert.deepEqual(state(p), [target, [A], [C]]);
    assert.equal(p.error, null);
  }
});

for (const direction of ['back', 'forward']) check(`${direction} failures retain stacks and retry history intent`, async () => {
  for (const failure of ['denied', 'rejected', 'malformed']) {
    const h = await atBranch(), p = h.panes[0], pending = Promise.withResolvers();
    h.setReply(() => pending.promise);
    const navigation = h.history(direction);
    assert.deepEqual(state(p), [B, [A], [C]], 'no mutation before listDirectory settles');
    assert.equal(p.loading, true);
    if (failure === 'rejected') pending.reject(new Error('offline'));
    else pending.resolve(failure === 'denied' ? { ok: false, error: { message: 'denied' } } : { ok: true, value: { path: A } });
    await navigation;
    assert.deepEqual(state(p), [B, [A], [C]]);
    assert.equal(p.loading, false);
    assert.equal(p.error.history, direction);
    assert.equal(p.error.path, direction === 'back' ? A : C);
    h.setReply(listed);
    await h.navigate(p, p.error.path, { history: p.error.history });
    assert.deepEqual(state(p), direction === 'back' ? [A, [], [C, B]] : [C, [A, B], []]);
    assert.equal(p.error, null);
  }
});

check('failed normal branch retains forward history until a successful retry', async () => {
  const h = await atBranch(), p = h.panes[0];
  h.setReply(() => ({ ok: false, error: { message: 'missing' } }));
  await h.navigate(p, D);
  assert.deepEqual(state(p), [B, [A], [C]]);
  assert.equal(p.error.path, D);
  h.setReply(listed);
  await h.navigate(p, p.error.path);
  assert.deepEqual(state(p), [D, [A, B], []]);
});

for (const kind of ['normal', 'back', 'forward']) for (const olderFirst of [true, false]) {
  for (const staleOk of [true, false]) check(`stale ${kind} ${staleOk ? 'success' : 'failure'}, older settles ${olderFirst ? 'first' : 'last'}`, async () => {
    const h = await atBranch(), p = h.panes[0], pending = [];
    h.setReply(target => { const request = { target, ...Promise.withResolvers() }; pending.push(request); return request.promise; });
    const older = kind === 'normal' ? h.navigate(p, D) : h.history(kind);
    const newer = h.navigate(p, E);
    assert.deepEqual(state(p), [B, [A], [C]]);
    assert.deepEqual(pending.map(item => item.target), [kind === 'normal' ? D : kind === 'back' ? A : C, E]);
    const settleOlder = async () => {
      pending[0].resolve(staleOk ? listed(pending[0].target) : { ok: false, error: { message: 'stale' } });
      await older;
    };
    if (olderFirst) {
      await settleOlder();
      assert.deepEqual(state(p), [B, [A], [C]]);
      assert.equal(p.loading, true);
      assert.equal(p.pendingPath, E);
    }
    pending[1].resolve(listed(E));
    await newer;
    if (!olderFirst) await settleOlder();
    assert.deepEqual(state(p), [E, [A, B], []]);
    assert.equal(p.error, null);
    assert.equal(p.loading, false);
    assert.equal(p.pendingPath, null);
  });
}

check('default history targets only the active pane; explicit pane stays independent', async () => {
  const h = await atBranch(), [p, other] = h.panes;
  await h.navigate(other, X, { initial: true });
  await h.navigate(other, Y);
  h.run('workspace().active = 1');
  await h.history('back');
  assert.deepEqual(state(other), [X, [], [Y]]);
  assert.deepEqual(state(p), [B, [A], [C]]);
  await h.history('forward');
  await h.history('back', p);
  assert.deepEqual(state(other), [Y, [X], []]);
  assert.deepEqual(state(p), [A, [], [C, B]]);
});

check('loading, mutation, shell menu, modal and startup guards reject both directions', async () => {
  const h = await atBranch(), p = h.panes[0];
  for (const guard of ['activePane().loading', 'transferPending', 'shellMenuPending', 'document.modal', '!ready']) {
    h.run(guard === '!ready' ? 'ready = false' : `${guard} = true`);
    const count = h.calls.length;
    for (const direction of ['back', 'forward']) await h.history(direction);
    assert.equal(h.calls.length, count, guard);
    assert.deepEqual(state(p), [B, [A], [C]], guard);
    h.run(guard === '!ready' ? 'ready = true' : `${guard} = false`);
  }
  await h.history('back', null);
  await h.history('forward', null);
});

check('remapping moves both stacks, including descendants, without matching sibling prefixes', async () => {
  const h = await atBranch(), [p, other] = h.panes;
  p.history = [A, `${A}\\child`, `${A}-sibling`];
  p.forwardHistory = [`${A}\\future`, C];
  other.history = [A]; other.forwardHistory = [`${A}\\nested`];
  h.remapReferences(A, D);
  assert.deepEqual(state(p), [B, [D, `${D}\\child`, `${A}-sibling`], [`${D}\\future`, C]]);
  assert.deepEqual(state(other), [X, [D], [`${D}\\nested`]]);
  await h.history('forward', other);
  assert.equal(h.calls.at(-1), `${D}\\nested`);
  assert.deepEqual(state(other), [`${D}\\nested`, [D, X], []]);
});

for (const direction of ['back', 'forward']) for (const originalOk of [false, true]) {
  check(`${direction} relocated target commits once after original ${originalOk ? 'success' : 'failure'}`, async () => {
    const h = await atBranch(), p = h.panes[0], pending = Promise.withResolvers();
    const target = direction === 'back' ? A : C, start = h.calls.length;
    h.setReply(() => pending.promise);
    const navigation = h.history(direction);
    await queueRelocations(h, target, [{ source: target, destination: D }]);
    assert.deepEqual(state(p), direction === 'back' ? [B, [D], [C]] : [B, [A], [D]]);
    h.setReply(listed);
    if (originalOk) pending.resolve(listed(target));
    else pending.reject(new Error('renamed while listing'));
    await navigation;
    await new Promise(setImmediate); // Drain the follow-up refresh started by the actual navigate().
    assert.deepEqual(h.calls.slice(start), [target, D]);
    assert.deepEqual(state(p), direction === 'back' ? [D, [], [C, B]] : [D, [A, B], []]);
    assert.equal(p.loading, false);
    assert.equal(p.error, null);
  });
}

for (const kind of ['normal', 'back', 'forward']) check(`${kind} traversal records a relocated origin`, async () => {
  const h = await atBranch(), p = h.panes[0], pending = Promise.withResolvers();
  const target = kind === 'normal' ? E : kind === 'back' ? A : C, start = h.calls.length;
  h.setReply(() => pending.promise);
  const navigation = kind === 'normal' ? h.navigate(p, target) : h.history(kind);
  await queueRelocations(h, B, [{ source: B, destination: D }]);
  h.setReply(listed);
  pending.resolve(listed(target));
  await navigation;
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.slice(start), [target, target]);
  assert.deepEqual(state(p), kind === 'back' ? [A, [], [C, D]] : [target, [A, D], []]);
  assert.equal(p.loading, false);
  assert.equal(p.error, null);
  await h.history(kind === 'back' ? 'forward' : 'back');
  assert.equal(h.calls.at(-1), D, 'the reverse traversal must request the renamed origin');
  assert.equal(p.path, D);
});

for (const direction of ['back', 'forward']) check(`${direction} recovery carries origin through chained relocations`, async () => {
  const h = await atBranch(), p = h.panes[0], pending = Promise.withResolvers(), recovery = Promise.withResolvers();
  const target = direction === 'back' ? A : C, start = h.calls.length;
  h.setReply(() => pending.promise);
  const navigation = h.history(direction);
  await queueRelocations(h, B, [
    { source: target, destination: D }, { source: D, destination: E }, { source: B, destination: X },
  ]);
  h.setReply(value => value === E ? recovery.promise : listed(value));
  pending.resolve({ ok: false, error: { message: 'renamed while listing' } });
  await navigation;
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.slice(start), [target, E]);
  assert.deepEqual(state(p), direction === 'back' ? [B, [E], [C]] : [B, [A], [E]]);
  assert.equal(p.loading, true, 'recovery must still defer the history transition');
  await queueRelocations(h, E, [{ source: E, destination: D }, { source: X, destination: Y }]);
  recovery.reject(new Error('renamed again during recovery'));
  await new Promise(setImmediate);
  assert.deepEqual(h.calls.slice(start), [target, E, D]);
  assert.deepEqual(state(p), direction === 'back' ? [D, [], [C, Y]] : [D, [A, Y], []]);
  assert.equal(p.loading, false);
  assert.equal(p.error, null);
  await h.history(direction === 'back' ? 'forward' : 'back');
  assert.equal(h.calls.at(-1), Y);
  assert.equal(p.path, Y);
});

for (const direction of ['back', 'forward']) for (const retry of ['button', 'direction']) {
  check(`${direction} failed recovery retains relocated origin on ${retry} retry`, async () => {
    const h = await atBranch(), p = h.panes[0], pending = Promise.withResolvers();
    const target = direction === 'back' ? A : C, start = h.calls.length;
    h.setReply(() => pending.promise);
    const navigation = h.history(direction);
    await queueRelocations(h, B, [{ source: B, destination: X }, { source: target, destination: D }]);
    h.setReply(() => ({ ok: false, error: { message: 'recovery unavailable' } }));
    pending.reject(new Error('renamed while listing'));
    await navigation;
    await new Promise(setImmediate);
    assert.deepEqual(state(p), direction === 'back' ? [B, [D], [C]] : [B, [A], [D]]);
    assert.equal(p.loading, false);
    const recoveryError = p.error;
    assert.equal(recoveryError.path, D);
    assert.equal(recoveryError.history, direction);
    h.setReply(listed);
    if (retry === 'button') await h.run(`{ const pane = activePane(), action = 'retry'; ${retryAction} }`);
    else await h.history(direction);
    assert.deepEqual(h.calls.slice(start), [target, D, D]);
    assert.deepEqual(state(p), direction === 'back' ? [D, [], [C, X]] : [D, [A, X], []]);
    assert.equal(recoveryError.historyOrigin, X);
    assert.equal(p.loading, false);
    assert.equal(p.error, null);
  });
}
