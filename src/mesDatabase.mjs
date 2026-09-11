let fs = null;
export function installFirestoreDriver(driver) { fs = driver; }
import { canonical, clonePlain, invariant, kst, uid, validData, quantity, STEPS, SAFETY_VERSION, encodeAuditValue } from './mesSafetyCore.mjs';

// Memory driver implements only the Firestore operations used by this app.
// It is for isolated UI/logic rehearsal, NOT a Firestore emulator or a backup.
export function createMemoryDatabase(seed = {}) {
  return { __mesMemory: true, docs: new Map(Object.entries(seed).map(([p,d]) => [p, clonePlain(d)])), listeners: new Set(), tail: Promise.resolve(), failNextCommit: false };
}
function databaseOf(ref) { return ref.firestore || ref; }
export function collection(db, ...parts) {
  if (!db.__mesMemory) return fs.collection(db, ...parts);
  return { firestore: db, path: parts.join('/'), kind: 'collection' };
}
export function doc(base, ...parts) {
  const db = databaseOf(base);
  if (!db.__mesMemory) return fs.doc(base, ...parts);
  const suffix = parts.length ? parts.join('/') : uid('doc');
  const path = base.path ? `${base.path}/${suffix}` : suffix;
  invariant(path && !path.includes('//'), '잘못된 문서 경로입니다.');
  return { firestore: db, path, id: path.split('/').at(-1), kind: 'document' };
}
function memSnap(db, ref, map = db.docs) {
  const data = map.get(ref.path);
  return { id: ref.id, ref, exists: () => data !== undefined, data: () => clonePlain(data), metadata: { fromCache: false, hasPendingWrites: false } };
}
function memQuery(ref) {
  const db = ref.firestore;
  const rows = [...db.docs.keys()].filter(p => p.startsWith(ref.path + '/') && p.split('/').length === ref.path.split('/').length + 1).sort();
  let docs = rows.map(path => memSnap(db, doc(db, path)));
  for (const c of ref.constraints || []) {
    if (c.kind === 'orderBy') {
      const field = v => c.field.split('.').reduce((a,k)=>a?.[k], v);
      docs = docs.filter(d => field(d.data()) !== undefined);
      docs.sort((a,b) => { const x=field(a.data()), y=field(b.data()); const v=x===y?0:x<y?-1:1; return c.direction==='desc'?-v:v; });
    } else if (c.kind === 'limit') docs = docs.slice(0,c.count);
  }
  return { docs, size: docs.length, empty: docs.length === 0, metadata: { fromCache: false, hasPendingWrites: false }, forEach: fn => docs.forEach(fn) };
}
export function limitedQuery(ref, field, count = 50) {
  invariant(Number.isInteger(count) && count > 0 && count <= 200, 'Invalid query limit.');
  return ref.firestore.__mesMemory ? {...ref, constraints:[{kind:'orderBy',field,direction:'desc'},{kind:'limit',count}]} : fs.query(ref,fs.orderBy(field,'desc'),fs.limit(count));
}
export function getDocsFromServer(ref) { return ref.firestore.__mesMemory ? Promise.resolve(memQuery(ref)) : fs.getDocsFromServer(ref); }
export function getDocFromServer(ref) { return ref.firestore.__mesMemory ? Promise.resolve(memSnap(ref.firestore, ref)) : fs.getDocFromServer(ref); }
export function onSnapshot(ref, ...args) {
  if (!ref.firestore.__mesMemory) return fs.onSnapshot(ref, ...args);
  const next = args.find(x => typeof x === 'function');
  const error = args.filter(x => typeof x === 'function')[1];
  let closed = false;
  const listener = () => {
    if (closed) return;
    try { next(ref.kind === 'collection' ? memQuery(ref) : memSnap(ref.firestore, ref)); }
    catch (e) { if (error) error(e); else console.error(e); }
  };
  ref.firestore.listeners.add(listener);
  queueMicrotask(listener);
  return () => { closed = true; ref.firestore.listeners.delete(listener); };
}
export const serverTimestamp = () => fs ? fs.serverTimestamp() : ({ __mesServerTimestamp: true });
function resolveValue(v) {
  if (v?.__mesServerTimestamp || v?._methodName === 'serverTimestamp') return fs ? fs.Timestamp.now() : ({ seconds: Math.floor(Date.now()/1000), nanoseconds: 0 });
  if (Array.isArray(v)) return v.map(resolveValue);
  if (v && v.constructor === Object) return Object.fromEntries(Object.entries(v).map(([k,x]) => [k, resolveValue(x)]));
  return v;
}
function mergeMaps(a = {}, b = {}) {
  const out = clonePlain(a || {});
  for (const [k,v] of Object.entries(b)) out[k] = v?.constructor === Object && out[k]?.constructor === Object ? mergeMaps(out[k], v) : clonePlain(v);
  return out;
}
function updateMap(a, fields) {
  const out = clonePlain(a);
  for (const [path, value] of Object.entries(fields)) {
    const parts = path.split('.'); let at = out;
    for (const k of parts.slice(0,-1)) { if (at[k]?.constructor !== Object) at[k] = {}; at = at[k]; }
    at[parts.at(-1)] = clonePlain(value);
  }
  return out;
}
async function rawMemoryTransaction(db, fn) {
  const run = async () => {
    const view = new Map([...db.docs].map(([p,d]) => [p, clonePlain(d)]));
    const writes = [];
    const tx = {
      get: async ref => { invariant(!writes.length, 'Transaction read after write.'); return memSnap(db, ref, view); },
      set: (ref,data,opts) => writes.push({kind:'set',ref,data,opts}),
      update: (ref,data) => writes.push({kind:'update',ref,data}),
      delete: ref => writes.push({kind:'delete',ref})
    };
    const result = await fn(tx);
    for (const w of writes) {
      const old = view.get(w.ref.path);
      if (w.kind === 'delete') view.delete(w.ref.path);
      else if (w.kind === 'update') { invariant(old !== undefined, 'Update target missing.'); view.set(w.ref.path, resolveValue(updateMap(old, w.data))); }
      else view.set(w.ref.path, resolveValue(w.opts?.merge ? mergeMaps(old,w.data) : clonePlain(w.data)));
    }
    if (db.failNextCommit) { db.failNextCommit = false; throw new Error('TEST: atomic commit rejected'); }
    db.docs = view;
    if (writes.length) queueMicrotask(() => db.listeners.forEach(fn => fn()));
    return result;
  };
  const p = db.tail.then(run,run); db.tail = p.catch(() => {}); return p;
}
const configs = new WeakMap();
const pendingListeners = new Set();
let pendingCount = 0;
export function subscribePending(callback) { pendingListeners.add(callback); callback(pendingCount); return () => pendingListeners.delete(callback); }
export function pendingWrites() { return pendingCount; }
function changePending(n) { pendingCount += n; pendingListeners.forEach(fn => fn(pendingCount)); }
export function configureDatabase(db, options) { configs.set(db, options); }
export function getDatabaseConfig(db) { return configs.get(db); }
export async function runTransaction(db, action, options = {}) {
  const config = configs.get(db);
  invariant(config, '안전 저장 구성이 없습니다.');
  invariant(config.canWrite(), '현재는 읽기 전용입니다. 운영 데이터 쓰기는 승인 후 별도로 활성화합니다.');
  const opId = uid('audit');
  const label = options.label || 'MES 데이터 저장';
  const actor = options.actor || config.actor?.() || '미기재';
  const raw = db.__mesMemory ? rawMemoryTransaction : fs.runTransaction;
  changePending(1);
  try {
    return await raw(db, async rawTx => {
      const controlRef = doc(db, `${config.root}/mesControl/main`);
      const control = await rawTx.get(controlRef);
      const reads = new Map([[controlRef.path, control]]);
      const writes = [];
      let metadata = {};
      let writing = false;
      async function read(ref) {
        invariant(ref.firestore === db, '다른 데이터베이스로 쓰기를 시도했습니다.');
        if (!reads.has(ref.path)) reads.set(ref.path, await rawTx.get(ref));
        return reads.get(ref.path);
      }
      const tx = {
        annotate: data => { validData(data); metadata = {...metadata, ...clonePlain(data)}; },
        get: async ref => { invariant(!writing, '읽기가 끝나기 전에 저장을 시작했습니다.'); return read(ref); },
        // All patched writers also touch mesControl. This serializes new-client
        // collection queries; it does not protect against unpatched old clients.
        list: async ref => {
          invariant(!writing, '조회는 저장 전에 해야 합니다.');
          const query = await getDocsFromServer(ref);
          invariant(!query.metadata.fromCache && !query.metadata.hasPendingWrites, '서버에서 확인한 데이터가 필요합니다.');
          const list = [];
          for (const item of query.docs) { const s = await read(item.ref); if (s.exists()) list.push(s); }
          return list;
        },
        set: (ref,data,opts) => { writing = true; writes.push({kind:'set',ref,data,opts}); },
        update: (ref,data) => { writing = true; writes.push({kind:'update',ref,data}); },
        delete: ref => { writing = true; writes.push({kind:'delete',ref}); }
      };
      const result = await action(tx);
      if (!writes.length) return result;
      invariant(writes.length <= 180, '한 번에 처리할 기록이 너무 많습니다. 작업을 나누세요.');
      const before = new Map(); const after = new Map(); const refs = new Map();
      for (const w of writes) {
        invariant(w.ref.firestore === db, '다른 데이터베이스 쓰기입니다.');
        invariant(w.ref.path.startsWith(config.root + '/') || w.ref.path.startsWith('print-queue/'), '허용되지 않은 경로입니다.');
        const col = w.ref.path.split('/').at(-2);
        invariant(!['mesAudit','mesControl','wipArchive'].includes(col), '보호된 이력은 직접 변경할 수 없습니다.');
        if (!before.has(w.ref.path)) { const snap = await read(w.ref); before.set(w.ref.path, snap.exists() ? snap.data() : null); after.set(w.ref.path, before.get(w.ref.path)); refs.set(w.ref.path, w.ref); }
        const old = after.get(w.ref.path);
        if (['shippingHistory','inventoryHistory'].includes(col) && old) invariant(w.kind !== 'delete' && options.allowHistoryAmendment === true, '입출고 이력은 삭제하거나 수량을 덮어쓸 수 없습니다. 정정 이력을 별도로 남기세요.');
        if (w.kind === 'delete') { invariant(old !== null, '이미 삭제된 기록입니다.'); after.set(w.ref.path,null); }
        else {
          validData(w.data);
          if (w.kind === 'update') invariant(old !== null, '이미 삭제/분할/출고된 기록입니다.');
          const next = w.kind === 'update' ? updateMap(old,w.data) : w.opts?.merge ? mergeMaps(old,w.data) : clonePlain(w.data);
          if (col === 'wipList') {
            quantity(next.qty); invariant(STEPS.includes(next.currentStep), '알 수 없는 공정입니다.');
            invariant(next.id === w.ref.id && next.mixLot, '로트 번호 또는 저장 ID가 올바르지 않습니다.');
            if (old === null) { const a = await read(doc(db, `${config.root}/wipArchive/${w.ref.id}`)); invariant(!a.exists(), '종료/취소된 ID를 다시 생성할 수 없습니다.'); }
          }
          if (['wipList','inventory','orderList'].includes(col)) next._mesRevision = (Number(before.get(w.ref.path)?._mesRevision) || 0) + 1;
          after.set(w.ref.path,next);
        }
      }
      const archiveWrites = [];
      for (const [path, old] of before) {
        if (old && after.get(path) === null && path.split('/').at(-2) === 'wipList') {
          const r = doc(db, `${config.root}/wipArchive/${refs.get(path).id}`);
          const existing = await read(r);
          invariant(!existing.exists(), '이미 종료 이력이 있는 ID입니다.');
          archiveWrites.push({ref:r, data:{ ...old, archivedAt:kst(), archiveAction:label, archiveActor:actor, sourceWipId:refs.get(path).id, operationId:opId, archiveContext:encodeAuditValue(metadata), successorWipIds:[...after].filter(([p,v]) => p.split('/').at(-2) === 'wipList' && before.get(p) === null && v && (v.parentWipIds||[]).includes(old.id)).map(([,v]) => v.id) }});
        }
      }
      const changes = [...before].map(([path,old]) => ({path, before:encodeAuditValue(old), after:encodeAuditValue(after.get(path))}));
      invariant(new TextEncoder().encode(canonical({changes,metadata})).length < 700000, '원본 이력 보관 용량을 초과했습니다. 저장하지 않았습니다.');
      // No external side effects in the retryable callback. Flush only now.
      for (const [path, value] of after) { if (value === null) rawTx.delete(refs.get(path)); else rawTx.set(refs.get(path), value); }
      for (const item of archiveWrites) rawTx.set(item.ref,item.data);
      rawTx.set(doc(db, `${config.root}/mesAudit/${opId}`), {id:opId, version:SAFETY_VERSION, label, actor, recordedAt:kst(), createdAt:serverTimestamp(), metadata:encodeAuditValue(metadata), changes});
      rawTx.set(controlRef, {revision:(Number(control.data()?.revision)||0)+1, version:SAFETY_VERSION, lastOperationId:opId, updatedAt:serverTimestamp()}, {merge:true});
      return result;
    });
  } finally { changePending(-1); }
}
export function setDoc(ref,data,opts) { return runTransaction(ref.firestore, tx => { tx.set(ref,data,opts); }, {label:'일반 문서 저장'}); }
export function deleteDoc(ref) { return runTransaction(ref.firestore, tx => { tx.delete(ref); }, {label:'문서 취소'}); }
export async function addDoc(ref,data) { const r = doc(ref); await setDoc(r,data); return r; }
