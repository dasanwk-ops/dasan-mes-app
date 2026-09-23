// Preview-only adapter. No Firebase SDK, authentication request, or network I/O.
// This file is intentionally kept out of the production feature commit.
const STORAGE_KEY = 'dasan-lab-furnace-preview-v1';
const ROOT = 'artifacts/dasan-mes-app/public/data/';
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const listeners = new Set();
let serial = Promise.resolve();
const seed = () => ({
  [ROOT + 'equipment/furnaces']: {
    1: { isHeating: false, temp: '1050', operator: '', memo: '', slotData: {} },
    2: { isHeating: false, temp: '1050', operator: '', memo: '', slotData: {} },
    lab: { isHeating: false, temp: '1050', operator: '', memo: '', slotData: {} },
  },
  [ROOT + 'equipment/shrinkDesks']: {},
  ...Object.fromEntries(['4Y-W', '4Y-W-S', '4Y-Y', '5E-P', '4Y-G'].map(type => [ROOT + `inventory/demo-${type}`, {
    id: `demo-${type}`, type, lot: `TEST-POWDER-${type}`, weight: 100, status: '사용중', date: '2026-09-23'
  }])),
  [ROOT + 'wipList/demo-lab']: {
    id: 'demo-lab', mixLot: 'TEST-LAB-001', originalLot: 'TEST-LAB-001', type: '3Y-W', height: 20,
    qty: 6, isExperimental: true, includeShrinkageSpecimen: false, specimenPowderG: 0, currentStep: 'step5', details: '[테스트] 실험로 배정용 샘플 6개',
    heatTreatmentHistory: [],
  },
  [ROOT + 'wipList/demo-production']: {
    id: 'demo-production', mixLot: 'TEST-MAIN-002', originalLot: 'TEST-MAIN-002', type: '3Y-W', height: 25,
    qty: 28, currentStep: 'step5', details: '[테스트] 기존 전기로 비교용 샘플 28개',
    heatTreatmentHistory: [],
  },
  [ROOT + 'wipList/demo-history']: {
    id: 'demo-history', mixLot: 'TEST-HISTORY-003', originalLot: 'TEST-HISTORY-003', type: '3Y-W', height: 20,
    qty: 12, currentStep: 'step6', shrinkageRate: '5.00',
    details: '[테스트] 다른 로트의 기존 이력 보존 확인용',
    heatTreatmentHistory: [{ furnaceId: 1, startedAt: '2026-09-22 08:00:00', completedAt: '2026-09-22 12:00:00', temperature: '1050', operator: '샘플', slots: [{furnaceId:1,slotId:'L1',qty:12}] }],
  },
});
const load = () => {
  try { return JSON.parse(window.sessionStorage.getItem(STORAGE_KEY)) || seed(); }
  catch { return seed(); }
};
let data = load();
const persist = next => {
  // If browser storage is unavailable/full, report failure before changing in-memory state.
  if (typeof window !== 'undefined') window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  data = next;
  for (const listener of listeners) queueMicrotask(() => {
    if (listeners.has(listener)) listener.callback(snapshot(listener.ref));
  });
};
const ref = (kind, parent, parts) => {
  const path = [parent?.path, ...parts].filter(Boolean).join('/');
  return { kind, path, id: path.split('/').at(-1) };
};
const documentSnapshot = (r, current = data) => ({
  id: r.id, ref: r, exists: () => current[r.path] !== undefined,
  data: () => clone(current[r.path]),
});
const snapshot = r => r.kind === 'collection' ? {
  docs: Object.keys(data).filter(path => path.startsWith(r.path + '/') && !path.slice(r.path.length + 1).includes('/'))
    .map(path => documentSnapshot({kind:'doc',path,id:path.split('/').at(-1)})),
} : documentSnapshot(r);
const queue = action => {
  const result = serial.then(action);
  serial = result.catch(() => {});
  return result;
};
const merge = (before, patch) => {
  const next = clone(before || {});
  for (const [key, value] of Object.entries(patch)) {
    next[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(next[key], value) : clone(value);
  }
  return next;
};
export const SANDBOX_MODE = true;
export const initializeApp = () => ({ sandbox: true });
export const getAuth = () => ({ sandbox: true });
export const getFirestore = () => ({ sandbox: true });
export const signInAnonymously = async () => ({ user: { uid: 'sandbox' } });
export const onAuthStateChanged = (_auth, callback) => {
  let active = true;
  queueMicrotask(() => { if (active) callback({uid:'sandbox'}); });
  return () => { active = false; };
};
export const collection = (parent, ...parts) => ref('collection', parent, parts);
export const doc = (parent, ...parts) => ref('doc', parent, parts);
export const onSnapshot = (r, callback) => {
  const listener = {ref:r,callback};
  listeners.add(listener);
  queueMicrotask(() => { if (listeners.has(listener)) callback(snapshot(r)); });
  return () => listeners.delete(listener);
};
export const setDoc = (r, value, options = {}) => queue(() => {
  const next = clone(data);
  next[r.path] = options.merge ? merge(next[r.path], value) : clone(value);
  persist(next);
});
export const deleteDoc = r => queue(() => {
  const next = clone(data); delete next[r.path]; persist(next);
});
export const serverTimestamp = () => new Date().toISOString();
export const addDoc = async (r, value) => {
  const target = doc(r, `sandbox-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await setDoc(target, value); return target;
};
export const runTransaction = (_db, callback) => queue(async () => {
  const before = clone(data), writes = [];
  const result = await callback({
    get: async r => {
      if (writes.length) throw new Error('트랜잭션은 모든 읽기를 쓰기보다 먼저 처리해야 합니다.');
      return documentSnapshot(r, before);
    },
    set: (r, value, options) => writes.push({kind:'set',r,value:clone(value),options}),
    update: (r, value) => writes.push({kind:'update',r,value:clone(value)}),
    delete: r => writes.push({kind:'delete',r}),
  });
  const next = clone(before);
  for (const {kind,r,value,options} of writes) {
    if (kind === 'delete') delete next[r.path];
    else if (kind === 'update') {
      if (!next[r.path]) throw new Error('테스트 문서가 없습니다.');
      next[r.path] = {...next[r.path],...value};
    } else next[r.path] = options?.merge ? merge(next[r.path], value) : value;
  }
  persist(next);
  return result;
});
// Both Google Sheets calls in App.js bind to this local no-op, never browser fetch.
export const sandboxFetch = async () => ({ok:true,status:200,json:async()=>({sandbox:true})});
export const resetSandbox = () => {
  window.sessionStorage.removeItem(STORAGE_KEY);
  window.location.reload();
};
