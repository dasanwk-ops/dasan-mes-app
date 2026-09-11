// Pure validation and plan helpers. No Firebase, network, or React dependency.
export const SAFETY_VERSION = '2026-09-11-rc1';
export const STEPS = ['step1', 'step2', 'step3', 'step4', 'step5', 'step5_shrink', 'step6', 'step7', 'step7_drying', 'step8', 'done'];
export function invariant(ok, message) { if (!ok) throw new Error(message); }
export function quantity(value, label = '수량', allowZero = true) {
  invariant((typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '', `${label}: 빈 값은 허용되지 않습니다.`);
  const n = Number(value);
  invariant(Number.isSafeInteger(n) && n >= (allowZero ? 0 : 1), `${label}: ${allowZero ? '0 이상' : '양수'}의 정수를 입력하세요.`);
  return n;
}
export function optionalQuantity(value, label = '불량 수량') { return quantity(value === '' || value == null ? 0 : value, label); }
export function positiveNumber(value, label = '측정값', allowZero = false) {
  invariant((typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '', `${label}을 입력하세요.`);
  const n = Number(value);
  invariant(Number.isFinite(n) && (allowZero ? n >= 0 : n > 0), `${label}은 ${allowZero ? '0 이상' : '양수'}의 유한한 숫자여야 합니다.`);
  return n;
}
export function shrinkage(value) {
  const n = positiveNumber(value, '수축률');
  invariant(n < 100, '수축률은 0보다 크고 100보다 작아야 합니다.');
  return n;
}
export function requiredText(value, label = '사유') {
  const s = String(value ?? '').trim();
  invariant(s.length > 0 && s.length <= 4000, `${label}을 입력하세요 (최대 4,000자).`);
  return s;
}
export function canonical(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (typeof value.toMillis === 'function') return `timestamp:${value.toMillis()}`;
  if (value._methodName) return `field:${value._methodName}`;
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
export function assertSame(live, expected, label = '데이터') {
  invariant(live && expected, `${label}가 없거나 삭제되었습니다. 새로고침하세요.`);
  // UI-only fields are deliberately not persisted or compared.
  const clean = x => Object.fromEntries(Object.entries(x).filter(([k]) => !k.startsWith('__ui')));
  invariant(canonical(clean(live)) === canonical(clean(expected)), `${label}가 화면을 연 이후 변경되었습니다. 새로고침한 뒤 다시 확인하세요.`);
}
export function assertWip(live, expected, step) {
  assertSame(live, expected, '로트');
  invariant(live.currentStep === step, '이미 다른 공정으로 이동했거나 취소된 로트입니다.');
  quantity(live.qty);
  invariant(live.id === expected.id, '문서 ID가 다릅니다.');
}
export function normalType(value) {
  const s = String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
  return /^(345|234)\s/.test(s) ? s : `345 ${s}`;
}
export function kst(date = new Date()) {
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = x => p.find(t => t.type === x)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
export function uid(prefix = 'op') {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}
export const packDate = () => kst().slice(2, 10).replace(/-/g, '');
export const packNumber = (date, n) => `F${date}${String(n).padStart(3, '0')}`;
export function invalidateLabel() {
  return { labelPrintedAt: '', labelPrintedQty: null, labelPrintedDefectQty: null, labelPrintedPackLot: '', labelPrintedShrinkage: '', labelPrintedMfgDate: '', labelPrintFingerprint: '', labelJobId: '' };
}
export function manufactureDate(w) {
  const arr = (w.heatTreatmentHistory || []).filter(h => h?.completedAt);
  const date = String(arr.at(-1)?.completedAt || '').split(' ')[0];
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date + 'T00:00:00Z')) && new Date(date + 'T00:00:00Z').toISOString().slice(0,10) === date, '열처리 완료일 원기록이 필요합니다. 임의 날짜를 입력하지 마세요.');
  return date;
}
export function printFingerprint(w, defects) {
  shrinkage(w.shrinkageRate);
  const d = quantity(defects);
  const q = quantity(w.qty, '현재 수량');
  invariant(d < q, '출력 가능한 정상품이 없습니다.');
  invariant(w.packLot, '포장 LOT가 아직 발급되지 않았습니다.');
  return canonical({ lot: w.mixLot, packLot: w.packLot, type: normalType(w.type), height: String(w.height), qty: q - d, defects: d, shrinkageRate: Number(w.shrinkageRate), mfgDate: manufactureDate(w) });
}
export function defectsFor(w, defects, reason) {
  const d = optionalQuantity(defects);
  invariant(d <= quantity(w.qty), '불량 수량이 현재 재고보다 많습니다.');
  if (d) requiredText(reason, '불량 사유');
  return d;
}
export function allFurnaceSlots(furnaces) {
  return Object.entries(furnaces || {}).flatMap(([fid, f]) => Object.entries(f?.slotData || {}).map(([slotId, s]) => ({ fid: String(fid), slotId, ...s, isHeating: !!f.isHeating })));
}
export function allDeskSlots(desks) {
  return Object.entries(desks || {}).flatMap(([fid, d]) => [d, ...(d?.queue || [])].flatMap(b => Object.entries(b?.slotData || {}).map(([slotId, s]) => ({ fid: String(fid), batchId: b.batchId || '', slotId, ...s }))));
}
export function validateAllocated(furnaces, wips) {
  const totals = new Map();
  for (const s of allFurnaceSlots(furnaces)) {
    invariant(['1','2'].includes(s.fid) && /^[LR][1-6]$/.test(s.slotId), '알 수 없는 전기로 위치입니다.');
    const w = wips.get(String(s.wipId));
    invariant(w && w.currentStep === 'step5', '전기로에 삭제/이동된 로트가 연결되어 있습니다.');
    invariant(w.mixLot === s.mixLot && normalType(w.type) === normalType(s.type) && String(w.height) === String(s.height), '전기로 로트/제품 정보가 일치하지 않습니다.');
    totals.set(w.id, (totals.get(w.id) || 0) + quantity(s.qty, '슬롯 수량', false));
  }
  for (const [id, n] of totals) invariant(n <= quantity(wips.get(id).qty), '여러 전기로에 배정한 합계가 로트 재고를 초과합니다.');
  return totals;
}
export function clonePlain(value) {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clonePlain);
  if (value.constructor && value.constructor !== Object) return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clonePlain(v)]));
}
export function validData(value, path = '') {
  invariant(value !== undefined, `저장할 값이 없습니다: ${path}`);
  if (typeof value === 'number') invariant(Number.isFinite(value), `NaN/무한대는 저장할 수 없습니다: ${path}`);
  if (!value || typeof value !== 'object' || (value.constructor !== Object && !Array.isArray(value))) return;
  for (const [k,v] of Object.entries(value)) validData(v, `${path}.${k}`);
}

// Audit records place before/after objects inside an array. Firestore transform
// sentinels cannot be nested in arrays; encode them instead of copying them.
// The enclosing audit.createdAt is the server timestamp of the same commit.
export function encodeAuditValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v.__mesServerTimestamp || v._methodName === 'serverTimestamp') return {__firestoreType:'serverTimestamp',resolvedBy:'audit.createdAt'};
  if (v._methodName) throw new Error('Unsupported transform in audit: '+v._methodName);
  if (typeof v.toMillis === 'function' && Number.isFinite(v.seconds)) return {__firestoreType:'timestamp',seconds:v.seconds,nanoseconds:v.nanoseconds||0};
  if (typeof v.path === 'string' && v.firestore) return {__firestoreType:'reference',path:v.path,projectId:v.firestore.app?.options?.projectId||''};
  if (Number.isFinite(v.latitude) && Number.isFinite(v.longitude) && typeof v.isEqual==='function') return {__firestoreType:'geopoint',latitude:v.latitude,longitude:v.longitude};
  if (typeof v.toBase64==='function') return {__firestoreType:'bytes',base64:v.toBase64()};
  if (v instanceof Date) return {__firestoreType:'date',iso:v.toISOString()};
  if (Array.isArray(v)) return v.map(encodeAuditValue);
  return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,encodeAuditValue(x)]));
}
