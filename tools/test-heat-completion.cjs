// Run: node --test tools/test-heat-completion.cjs
// Execute the real completion handler with an in-memory transaction; no production access.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/App.js'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing source section: ${start}`);
  return source.slice(from, to);
}
const stateCode = section('const DEFAULT_FURNACES =', 'const DEFAULT_DRYING_ROOM =');
const handlerCode = section('  const toggleHeating = async (fid) => {', '\n  return (');
const clone = value => JSON.parse(JSON.stringify(value));
const sorted = value => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]))
    : value;
const baseFurnace = () => sorted({
  isHeating: true, temp: '1050', operator: 'tester', memo: '',
  startedAt: '2026-09-23 08:00:00',
  slotData: {
    L1: { wipId: 'w1', mixLot: 'TEST-LOT', type: '3Y', height: '20', qty: 4 },
    R1: { wipId: 'w1', mixLot: 'TEST-LOT', type: '3Y', height: '20', qty: 6 },
  },
});

function setup({ live = baseFurnace(), screen = live, wip, desks = {}, legacy = false } = {}) {
  const otherFurnace = { isHeating: true, memo: 'Keep other furnace', slotData: {} };
  let data = {
    'equipment/furnaces': { 1: clone(live), 2: clone(otherFurnace) },
    'equipment/shrinkDesks': clone(desks),
  };
  if (wip !== null) data['wipList/w1'] = wip || {
    id: 'w1', currentStep: 'step5', qty: 10, details: 'Prior history',
    heatTreatmentHistory: [{ furnaceId: '2', completedAt: 'prior cycle' }],
  };
  const alerts = [], logs = [];
  let commits = 0;
  const context = vm.createContext({
    getFirestore: () => ({}),
    getDocRef: (collection, id) => `${collection}/${id}`,
    getKST: () => '2026-09-23 12:00:00',
    cloneDeep: clone,
    getFurnaceSlotLabel: slot => slot,
    furnaces: {},
    wipList: Object.values(data).filter(value => value.id),
    setAlertModal: alert => alerts.push(alert),
    ctx: { showToast: () => {} },
    console: { error: () => {} },
    logProcessToGoogleSheet: async (...args) => logs.push(args),
    runTransaction: async (_db, callback) => {
      const writes = [];
      await callback({
        get: async ref => {
          assert.equal(writes.length, 0, 'All reads precede writes');
          const value = data[ref];
          return { ref, exists: () => value !== undefined, data: () => clone(value) };
        },
        update: (ref, value) => writes.push(['update', ref, clone(value)]),
        set: (ref, value) => writes.push(['set', ref, clone(value)]),
      });
      const next = clone(data);
      for (const [kind, ref, value] of writes) {
        if (kind === 'update') assert.ok(next[ref], 'Cannot update missing WIP');
        next[ref] = kind === 'update' ? { ...next[ref], ...value } : value;
      }
      data = next;
      commits++;
    },
  });
  vm.runInContext(stateCode, context);
  context.screen = clone(screen);
  vm.runInContext('furnaces[1] = { ...DEFAULT_FURNACES[1], ...screen };', context);
  const handler = legacy ? handlerCode.replace(
    'getFurnaceComparisonKey(fid, liveFurnace) !== getFurnaceComparisonKey(fid, f)',
    'JSON.stringify(liveFurnace) !== JSON.stringify(f)'
  ) : handlerCode;
  vm.runInContext(`${handler}\nthis.complete = toggleHeating;`, context);
  return { complete: () => context.complete('1'), alerts, logs,
    data: () => clone(data), commits: () => commits, otherFurnace };
}

test('reproduces the old false conflict with Firestore-sorted keys', async () => {
  const h = setup({ legacy: true });
  const before = h.data();
  await h.complete();
  assert.match(h.alerts.at(-1).message, /전기로 데이터가 변경/);
  assert.equal(h.commits(), 0);
  assert.deepEqual(h.data(), before);
});

test('completes equivalent state, preserves history/quantity, and blocks repeat completion', async () => {
  const h = setup();
  await h.complete();
  const data = h.data();
  assert.equal(h.alerts.at(-1).type, 'success');
  assert.equal(data['wipList/w1'].currentStep, 'step5_shrink');
  assert.equal(data['wipList/w1'].qty, 10);
  assert.equal(data['wipList/w1'].heatTreatmentHistory.length, 2);
  assert.equal(data['wipList/w1'].heatTreatmentHistory[1].startedAt, '2026-09-23 08:00:00');
  assert.equal(data['equipment/shrinkDesks'][1].slotData.L1.qty, 4);
  assert.equal(data['equipment/shrinkDesks'][1].slotData.R1.qty, 6);
  assert.deepEqual(data['equipment/furnaces'][1].slotData, {});
  assert.equal(data['equipment/furnaces'][1].isHeating, false);
  assert.deepEqual(data['equipment/furnaces'][2], h.otherFurnace);
  assert.equal(h.logs.length, 1);
  await h.complete();
  assert.equal(h.alerts.at(-1).type, 'error');
  assert.equal(h.commits(), 1);
  assert.equal(h.logs.length, 1);
  assert.deepEqual(h.data(), data);
});

test('accepts nested key order differences and screen-only default values', async () => {
  const live = baseFurnace();
  delete live.memo;
  delete live.temp;
  const screen = clone(live);
  screen.slotData = Object.fromEntries(Object.entries(screen.slotData).reverse().map(
    ([key, value]) => [key, Object.fromEntries(Object.entries(value).reverse())]
  ));
  const h = setup({ live, screen });
  await h.complete();
  assert.equal(h.alerts.at(-1).type, 'success');
});

test('queues the completed load without overwriting an active measurement batch', async () => {
  const active = { batchId: 'active', step: 2, slotData: { L2: { wipId: 'older', qty: 2 } },
    queue: [{ batchId: 'waiting', slotData: { R2: { wipId: 'queued', qty: 3 } } }] };
  const h = setup({ desks: { 1: active } });
  await h.complete();
  const desk = h.data()['equipment/shrinkDesks'][1];
  assert.deepEqual(desk.slotData, active.slotData);
  assert.equal(desk.batchId, 'active');
  assert.deepEqual(desk.queue[0], active.queue[0]);
  assert.equal(desk.queue.length, 2);
  assert.equal(desk.queue[1].slotData.L1.qty + desk.queue[1].slotData.R1.qty, 10);
});

for (const [label, change] of Object.entries({
  stopped: f => { f.isHeating = false; },
  quantity: f => { f.slotData.L1.qty = 5; },
  wip: f => { f.slotData.L1.wipId = 'other'; },
  slot: f => { f.slotData.L2 = f.slotData.L1; delete f.slotData.L1; },
  startTime: f => { f.startedAt = '2026-09-23 09:00:00'; },
  temperature: f => { f.temp = '1100'; },
  operator: f => { f.operator = 'other'; },
  memo: f => { f.memo = 'Changed'; },
  extraField: f => { f.revision = 1; },
})) {
  test(`rejects actual furnace change: ${label}`, async () => {
    const screen = baseFurnace(), live = clone(screen);
    change(live);
    const h = setup({ live, screen }), before = h.data();
    await h.complete();
    assert.match(h.alerts.at(-1).message, /전기로 데이터가 변경/);
    assert.equal(h.commits(), 0);
    assert.deepEqual(h.data(), before);
    assert.equal(h.logs.length, 0);
  });
}

for (const [label, wip] of Object.entries({
  missing: null,
  moved: { id: 'w1', currentStep: 'step5_shrink', qty: 10 },
  partial: { id: 'w1', currentStep: 'step5', qty: 20 },
})) {
  test(`retains WIP protection: ${label}`, async () => {
    const h = setup({ wip }), before = h.data();
    await h.complete();
    assert.equal(h.alerts.at(-1).type, 'error');
    assert.equal(h.commits(), 0);
    assert.deepEqual(h.data(), before);
    assert.equal(h.logs.length, 0);
  });
}
