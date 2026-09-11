import test from 'node:test';
import assert from 'node:assert/strict';
import { getWipProcessStatus as status } from '../src/mesProcessStatus.mjs';
const w = (extra = {}) => ({ id: 'w1', currentStep: 'step5', qty: 10, mixLot: 'MIX-DEMO-005', ...extra });
const f = (heating, qty = 10, id = 'w1') => ({ '1': { isHeating: heating, slotData: { L1: { wipId: id, qty } } } });
const waiting = '\uc5f4\ucc98\ub9ac \ub300\uae30';
const assigned = '\uc804\uae30\ub85c \ubc30\uc815 (1\ud638\uae30)';
const heating = '\uc5f4\ucc98\ub9ac \uc911 (1\ud638\uae30)';

test('RC2 unassigned heat-treatment WIP is waiting', () => {
  assert.equal(status(w(), { '1': { isHeating: false, slotData: {} } }).label, waiting);
});
test('RC2 assigned but stopped furnace is not called heating', () => {
  assert.equal(status(w(), f(false)).label, assigned);
  assert.equal(status(w(), f(false)).tone, 'assigned');
});
test('RC2 running furnace displays heating without changing step5', () => {
  const item = w();
  assert.equal(status(item, f(true)).label, heating);
  assert.equal(status(item, f(true)).tone, 'heating');
  assert.equal(item.currentStep, 'step5');
});
test('RC2 furnace number comes from the actual matching equipment', () => {
  assert.equal(status(w(), { '2': f(true)['1'] }).label, '\uc5f4\ucc98\ub9ac \uc911 (2\ud638\uae30)');
});
test('RC2 several slots in one furnace count as a single assignment', () => {
  assert.equal(status(w(), { '1': { isHeating: true, slotData: { L1: { wipId: 'w1', qty: 4 }, R1: { wipId: 'w1', qty: 6 } } } }).label, heating);
});
test('RC2 another WIP with the same LOT text never supplies the state', () => {
  const furnaces = f(true, 10, 'another-id');
  furnaces['1'].slotData.L1.mixLot = w().mixLot;
  assert.equal(status(w(), furnaces).label, waiting);
});
test('RC2 historical furnaceSlots do not imply an active furnace', () => {
  assert.equal(status(w({ furnaceSlots: [{ fid: 1, slotId: 'L1', qty: 10 }] }), {}).label, waiting);
});
test('RC2 completed heat treatment uses the new WIP step even with stale equipment', () => {
  assert.equal(status(w({ currentStep: 'step5_shrink' }), f(true), 'SHRINK WAITING').label, 'SHRINK WAITING');
});
test('RC2 other process labels are unchanged', () => {
  for (const step of ['step1', 'step3', 'step4', 'step6', 'step7', 'step7_drying', 'step8', 'done']) {
    assert.deepEqual(status(w({ currentStep: step }), f(true), step), { label: step, tone: 'neutral', furnaceIds: [] });
  }
});
test('RC2 partial or excessive assignment is flagged instead of claiming all units are heating', () => {
  for (const qty of [1, 9, 11]) assert.equal(status(w(), f(true, qty)).tone, 'warning');
});
test('RC2 duplicate assignments across furnaces are flagged', () => {
  const result = status(w(), { '2': f(false, 5)['1'], '1': f(true, 5)['1'] });
  assert.equal(result.tone, 'warning');
  assert.deepEqual(result.furnaceIds, ['1', '2']);
});
test('RC2 string IDs and numeric quantities from legacy records remain supported', () => {
  assert.equal(status(w({ id: 123, qty: '10' }), f(true, '10', '123')).label, heating);
});
test('RC2 invalid slot quantities never claim valid heating', () => {
  for (const qty of [0, -1, 1.2, '', null, true, NaN, Infinity]) assert.equal(status(w(), f(true, qty)).tone, 'warning');
});
test('RC2 missing or nonboolean running flag is not silently trusted', () => {
  for (const flag of [undefined, null, 'true', 'false', 0, 1]) assert.equal(status(w(), f(flag)).tone, 'warning');
});
test('RC2 missing equipment or WIP identity is shown as uncertain', () => {
  for (const equipment of [null, undefined, [], 'offline']) assert.equal(status(w(), equipment).tone, 'warning');
  assert.equal(status(w({ id: '' }), f(true)).tone, 'warning');
  assert.equal(status(w({ id: undefined }), f(true)).tone, 'warning');
});
test('RC2 null equipment entries and unrelated metadata cannot crash rendering', () => {
  assert.equal(status(w(), { ...f(true), '2': null, revision: 6, note: 'example' }).label, heating);
  assert.equal(status(null, null, 'UNKNOWN').label, 'UNKNOWN');
});
test('RC2 calculations do not mutate any source record', () => {
  function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
  const item = freeze(w()), equipment = freeze(f(true));
  const before = JSON.stringify([item, equipment]);
  status(item, equipment);
  assert.equal(JSON.stringify([item, equipment]), before);
});
test('RC2 display follows start and stop immediately from current input', () => {
  const item = w(), equipment = f(false);
  assert.equal(status(item, equipment).label, assigned);
  equipment['1'].isHeating = true;
  assert.equal(status(item, equipment).label, heating);
  equipment['1'].isHeating = false;
  assert.equal(status(item, equipment).label, assigned);
  equipment['1'].slotData = {};
  assert.equal(status(item, equipment).label, waiting);
});
