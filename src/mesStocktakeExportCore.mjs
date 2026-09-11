// Read-only reconciliation export. This module does not import any write API.
// It is not a full Firestore backup and has no apply, delete, or restore method.
export const COLLECTION_NAMES = Object.freeze([
  'wipList', 'equipment', 'orderList', 'shippingHistory',
  'shrinkArchives', 'systemCounters', 'inventory', 'inventoryHistory'
]);

export function encodeFirestoreValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : { __firestoreType: 'number', value: String(value) };
  }
  if (typeof value !== 'object') throw new Error('Unsupported Firestore value; export aborted.');
  if (ancestors.has(value)) throw new Error('Circular value; export aborted.');
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Invalid Date; export aborted.');
    return { __firestoreType: 'date', iso: value.toISOString() };
  }
  if (typeof value.toDate === 'function' && Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds)) {
    return { __firestoreType: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (typeof value.toBase64 === 'function') {
    return { __firestoreType: 'bytes', base64: value.toBase64() };
  }
  if (value.type === 'document' && typeof value.path === 'string' && value.firestore) {
    return { __firestoreType: 'reference', path: value.path,
      projectId: value.firestore.app?.options?.projectId || null };
  }
  if (Number.isFinite(value.latitude) && Number.isFinite(value.longitude) && typeof value.isEqual === 'function') {
    return { __firestoreType: 'geopoint', latitude: value.latitude, longitude: value.longitude };
  }
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map(v => encodeFirestoreValue(v, ancestors));
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`Unsupported object type: ${value.constructor?.name || 'unknown'}`);
    }
    result = Object.fromEntries(Object.keys(value).sort().map(k => [k, encodeFirestoreValue(value[k], ancestors)]));
  }
  ancestors.delete(value);
  return result;
}

// Dependencies are passed in so this logic can be tested without a live database.
// readCollection must be Firebase getDocsFromServer in the actual UI.
export async function buildMesExport({ getCollectionRef, readCollection, onProgress = () => {} }) {
  if (typeof getCollectionRef !== 'function' || typeof readCollection !== 'function') {
    throw new Error('getCollectionRef and readCollection are required.');
  }
  const clientStartedAt = new Date().toISOString();
  const refs = Object.fromEntries(COLLECTION_NAMES.map(name => [name, getCollectionRef(name)]));
  const primary = refs.wipList;
  if (!primary?.path?.endsWith('/wipList')) throw new Error('Invalid WIP collection path.');
  const rootPath = primary.path.slice(0, -'/wipList'.length);
  const projectId = primary.firestore?.app?.options?.projectId || null;
  for (const name of COLLECTION_NAMES) {
    if (refs[name]?.path !== `${rootPath}/${name}` || refs[name].firestore !== primary.firestore) {
      throw new Error(`Unexpected database or collection path: ${name}`);
    }
  }
  const windows = [];
  async function readPass(pass) {
    const output = {};
    for (let index = 0; index < COLLECTION_NAMES.length; index++) {
      const name = COLLECTION_NAMES[index];
      onProgress({ pass, name, index: index + 1, total: COLLECTION_NAMES.length });
      const startedAt = new Date().toISOString();
      let snap;
      try { snap = await readCollection(refs[name]); }
      catch (error) { throw new Error(`${name}: ${error?.code || ''} ${error?.message || String(error)}`.trim()); }
      if (!snap || !Array.isArray(snap.docs)) throw new Error(`Invalid query result: ${name}`);
      if (snap.metadata?.fromCache || snap.metadata?.hasPendingWrites) {
        throw new Error(`Server-confirmed data required: ${name}`);
      }
      const ids = new Set();
      output[name] = snap.docs.map(item => {
        if (!item.id || ids.has(item.id)) throw new Error(`Invalid or duplicate document ID: ${name}`);
        ids.add(item.id);
        if (item.ref?.path !== `${refs[name].path}/${item.id}`) throw new Error(`Unexpected document path: ${name}/${item.id}`);
        if (item.metadata?.hasPendingWrites || item.metadata?.fromCache) throw new Error(`Unconfirmed document: ${name}/${item.id}`);
        return { documentId: item.id, documentPath: item.ref.path, data: encodeFirestoreValue(item.data()) };
      }).sort((a, b) => a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0);
      windows.push({ pass, name, clientStartedAt: startedAt, clientEndedAt: new Date().toISOString() });
    }
    return output;
  }
  const first = await readPass(1);
  const second = await readPass(2);
  const changed = COLLECTION_NAMES.filter(name => JSON.stringify(first[name]) !== JSON.stringify(second[name]));
  if (changed.length) throw new Error(`Data changed during export: ${changed.join(', ')}. Finish pending input and export again.`);
  const warnings = [
    'Two matching sequential reads are NOT an atomic database snapshot. Keep all writers quiescent during export.',
    'Only the eight named collections at this app path were read; subcollections, print-queue, Rules, indexes, Auth and Storage are excluded.',
    'This JSON is for review, not an executable correction plan or a full backup/restore archive.'
  ];
  for (const name of COLLECTION_NAMES) {
    for (const item of second[name]) {
      if (item.data.id !== undefined && String(item.data.id) !== item.documentId) {
        warnings.push(`Document ID differs from data.id: ${name}/${item.documentId}`);
      }
    }
  }
  if (!second.wipList.length) warnings.push('WIP collection is empty. Verify the app path, permissions, and expected database before any reconciliation.');
  let validWipQuantitySubtotal = 0;
  const invalidWipQuantityIds = [];
  for (const item of second.wipList) {
    const qty = item.data.qty;
    if (typeof qty === 'number' && Number.isSafeInteger(qty) && qty >= 0) validWipQuantitySubtotal += qty;
    else invalidWipQuantityIds.push(item.documentId);
  }
  return {
    format: 'mes-reconciliation-export-v1', writeOperations: 0,
    source: { projectId, rootPath, clientStartedAt, clientEndedAt: new Date().toISOString() },
    consistency: { serverReads: true, matchingPasses: 2, atomicSnapshot: false, readWindows: windows },
    counts: Object.fromEntries(COLLECTION_NAMES.map(name => [name, second[name].length])),
    wipQuantitySummary: { validWipQuantitySubtotal, invalidWipQuantityIds, includesFinishedGoods: true },
    warnings, collections: second
  };
}
