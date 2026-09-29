// Pure planning/read-model helpers. No database writes occur on import or render.
export const ADJUSTMENT_COLLECTION = "finishedGoodsAdjustments";

export function stockNumber(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

const text = value => String(value ?? "").trim();
const revision = item => stockNumber(item?.finishedGoodsAdjustmentRevision ?? 0);

export function buildFinishedRows(wipList, shippingHistory, adjustments, helpers) {
  const { getPackagingLot, getTraceMixLot, getProductLabel } = helpers;
  const groups = new Map();
  const sourceLots = new Map();
  [...wipList, ...adjustments, ...shippingHistory].forEach(item => {
    const sourceId = text(item.sourceWipId || (item.currentStep ? item.id : ""));
    const lot = getPackagingLot(item);
    if (sourceId && lot) sourceLots.set(sourceId, lot);
  });
  function add(item, bucket) {
    const sourceId = text(item.sourceWipId || (item.currentStep ? item.id : ""));
    const packLot = getPackagingLot(item) || sourceLots.get(sourceId) || "";
    const key = packLot ? `lot:${packLot}` : `missing:${sourceId || bucket + ":" + item.id}`;
    if (!groups.has(key)) groups.set(key, { key, packLot, live: [], inProcess: [], shipments: [], adjustments: [] });
    groups.get(key)[bucket].push(item);
  }
  wipList.forEach(item => {
    if (item.currentStep === "done") add(item, "live");
    else if (getPackagingLot(item)) add(item, "inProcess");
  });
  shippingHistory.forEach(item => add(item, "shipments"));
  adjustments.forEach(item => add(item, "adjustments"));
  return [...groups.values()]
    .filter(row => row.live.length || row.shipments.length || row.adjustments.length)
    .map(row => {
      const all = [...row.live, ...row.inProcess, ...row.shipments, ...row.adjustments];
      const products = [...new Set(all.map(item => `${getProductLabel(item.type)} ${item.height ?? ""}T`.trim()))];
      const mixLots = [...new Set(all.map(getTraceMixLot).filter(Boolean))];
      const quantities = row.live.map(item => stockNumber(item.qty));
      const qty = quantities.reduce((sum, count) => sum + (count ?? 0), 0);
      const invalidQty = quantities.includes(null) || !Number.isSafeInteger(qty);
      let blockedReason = "";
      if (!row.live.length) blockedReason = "현재 재고 문서가 없는 이력 조회용 LOT입니다.";
      else if (!row.packLot) blockedReason = "최종 포장 LOT 연결을 먼저 확인해주세요.";
      else if (row.live.length !== 1) blockedReason = "같은 포장 LOT에 여러 재고 문서가 있습니다. 연결 확인 전에는 정정할 수 없습니다.";
      else if (row.inProcess.length) blockedReason = "같은 포장 LOT에 진행 중인 공정이 있습니다. 연결을 확인해주세요.";
      else if (products.length !== 1) blockedReason = "동일 포장 LOT의 제품 정보가 서로 다릅니다. 연결을 확인해주세요.";
      else if (invalidQty || revision(row.live[0]) === null) blockedReason = "저장된 수량 또는 정정 버전을 확인해주세요.";
      return { ...row, products, mixLots, qty, invalidQty, blockedReason, adjustable: !blockedReason };
    })
    .sort((a, b) => (b.packLot || b.key).localeCompare(a.packLot || a.key));
}

export function filterFinishedRows(rows, { search = "", product = "", includeZero = false } = {}) {
  const terms = search.trim().toUpperCase().split(/\s+/).filter(Boolean);
  return rows.filter(row => {
    const haystack = [row.packLot, ...row.mixLots, ...row.products].join(" ").toUpperCase();
    return (includeZero || row.qty > 0 || row.invalidQty) &&
      (!product || row.products.includes(product)) &&
      terms.every(term => haystack.includes(term));
  });
}

// Only documented values are displayed. Historical packaging quantity is NOT
// inferred from current stock, label print counts, or shipment totals.
export function finishedHistory(row) {
  if (!row) return [];
  const events = [];
  const seenPackaging = new Set();
  [...row.live, ...row.shipments, ...row.adjustments].forEach(item => {
    const date = item.packagedAt || item.originalPackagedAt ||
      /\[([^\]]+)\]\s*\[포장완료\]/.exec(item.details || "")?.[1];
    if (!date) return;
    const source = text(item.sourceWipId || (item.currentStep ? item.id : ""));
    const key = `${source || row.packLot}:${date}`;
    if (seenPackaging.has(key)) return;
    seenPackaging.add(key);
    const qty = stockNumber(item.packagedQty);
    events.push({ id: `pack:${key}`, date, kind: "포장 완료", delta: qty, before: null, after: null,
      operator: "", note: qty === null ? "기존 기록에 당시 입고수량이 없어 표시하지 않습니다." : "저장된 포장 완료 수량" });
  });
  row.shipments.forEach(item => events.push({
    id: `ship:${item.id}`, date: item.date || "", kind: "출고",
    delta: stockNumber(item.qty) === null ? null : -Number(item.qty),
    before: stockNumber(item.stockBeforeQty), after: stockNumber(item.remainingQty),
    operator: item.operator || "", note: item.destination || ""
  }));
  row.adjustments.forEach(item => events.push({
    id: `adjust:${item.id}`, date: item.adjustedAt || "", kind: "수량 정정",
    delta: Number.isSafeInteger(item.deltaQty) ? item.deltaQty : null,
    before: stockNumber(item.beforeQty), after: stockNumber(item.afterQty),
    operator: item.operator || "", note: item.reason || ""
  }));
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

export function planFinishedAdjustment(live, request, helpers) {
  const { expected, targetQty, reason, operator, actorUid, isAdmin, adjustmentId, now } = request;
  if (isAdmin !== true || !text(actorUid)) throw new Error("마스터 권한으로 다시 접속해주세요.");
  if (!live) throw new Error("이미 전량 출고되었거나 삭제된 LOT입니다. 최신 목록을 확인해주세요.");
  if (!expected?.id || live.currentStep !== "done") throw new Error("완제품 창고에 있는 LOT만 정정할 수 있습니다.");
  const beforeQty = stockNumber(live.qty);
  const afterQty = stockNumber(targetQty);
  const expectedQty = stockNumber(expected.qty);
  if (afterQty === null) throw new Error("변경 수량은 0 이상의 정수로 입력해주세요. 빈칸은 저장할 수 없습니다.");
  if (beforeQty === null || revision(live) === null) throw new Error("저장된 재고 수량 또는 정정 버전을 확인해주세요.");
  const packLot = helpers.getPackagingLot(live);
  if (!packLot || packLot !== helpers.getPackagingLot(expected) ||
      helpers.getTraceMixLot(live) !== helpers.getTraceMixLot(expected) ||
      helpers.getProductLabel(live.type) !== helpers.getProductLabel(expected.type) ||
      text(live.height) !== text(expected.height) ||
      beforeQty !== expectedQty || revision(live) !== revision(expected)) {
    throw new Error("수량 또는 LOT 정보가 변경되었습니다. 창을 닫고 최신 수량을 확인한 뒤 다시 정정해주세요.");
  }
  if (afterQty === beforeQty) throw new Error("변경 전후 수량이 같습니다.");
  if (!text(reason) || text(reason).length > 500) throw new Error("정정 사유를 1~500자로 입력해주세요.");
  if (!text(operator) || text(operator).length > 80) throw new Error("처리자 이름을 1~80자로 입력해주세요.");
  if (!adjustmentId || !now) throw new Error("정정 요청 정보가 없습니다. 창을 다시 열어주세요.");
  const nextRevision = revision(live) + 1;
  if (!Number.isSafeInteger(nextRevision)) throw new Error("정정 버전 한도를 초과했습니다.");
  const history = {
    id: adjustmentId, kind: "FINISHED_GOODS_ADJUSTMENT", sourceWipId: text(expected.id),
    packLot, productionLot: helpers.getTraceMixLot(live),
    type: live.type ?? "", height: live.height ?? "", orderId: live.orderId || "",
    beforeQty, afterQty, deltaQty: afterQty - beforeQty,
    reason: text(reason), operator: text(operator), actorUid: text(actorUid),
    adjustedAt: now, originalPackagedAt: live.packagedAt || "",
    revision: nextRevision
  };
  return {
    update: {
      qty: afterQty,
      finishedGoodsAdjustmentRevision: nextRevision,
      finishedGoodsLastAdjustment: {
        id: adjustmentId, beforeQty, afterQty, deltaQty: history.deltaQty,
        reason: history.reason, operator: history.operator, actorUid: history.actorUid, adjustedAt: now
      }
    },
    history
  };
}

// The same WIP document used by shipping is read and updated atomically with
// the append-only ledger. A missing document is never recreated automatically.
export async function commitFinishedAdjustment({ request, helpers, db, runTransaction, getDocRef, adjustmentRef, serverTimestamp }) {
  if (request.isAdmin !== true || !text(request.actorUid)) throw new Error("마스터 권한으로 다시 접속해주세요.");
  const wipRef = getDocRef("wipList", text(request.expected?.id));
  const normalizedRequest = { ...request, adjustmentId: adjustmentRef.id };
  return runTransaction(db, async tx => {
    const liveSnap = await tx.get(wipRef);
    const auditSnap = await tx.get(adjustmentRef);
    if (auditSnap.exists()) {
      const previous = auditSnap.data();
      if (previous.sourceWipId !== text(request.expected?.id) ||
          previous.afterQty !== stockNumber(request.targetQty) ||
          previous.reason !== text(request.reason) || previous.operator !== text(request.operator) ||
          previous.actorUid !== text(request.actorUid)) {
        throw new Error("이미 사용된 정정 요청입니다. 창을 다시 열어주세요.");
      }
      return { ...previous, alreadySaved: true };
    }
    const planned = planFinishedAdjustment(liveSnap.exists() ? liveSnap.data() : null, normalizedRequest, helpers);
    tx.update(wipRef, planned.update);
    tx.set(adjustmentRef, { ...planned.history, createdAt: serverTimestamp() });
    return planned.history;
  });
}
