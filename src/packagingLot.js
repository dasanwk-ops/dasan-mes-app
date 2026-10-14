// The printed/finished-goods LOT. Internal MIX identifiers remain trace links.
export const PACKAGING_LOT_FORMAT = "manufacturing-date-height-US5-seq2";

export const packagingDateKey = manufacturingDate => {
  if (typeof manufacturingDate !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(manufacturingDate)) {
    throw new Error("로트 발급에 사용할 제조일을 확인해주세요.");
  }
  const date = new Date(`${manufacturingDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== manufacturingDate) {
    throw new Error("유효한 제조일이 필요합니다.");
  }
  return manufacturingDate.slice(2).replace(/-/g, "");
};

export const packagingHeight = height => {
  const text = String(height ?? "").trim().toUpperCase();
  if (!/^[1-9]\d*(?:\.\d+)?T?$/.test(text)) {
    throw new Error("로트 발급에 사용할 제품 높이를 확인해주세요.");
  }
  return `${text.replace(/T$/, "")}T`;
};

export const formatPackagingLot = (manufacturingDate, height, sequence) => {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 99) {
    throw new Error("같은 제조일의 로트는 01~99까지 발급할 수 있습니다. 번호를 재사용하지 말고 관리자에게 확인해주세요.");
  }
  return `${packagingDateKey(manufacturingDate)}${packagingHeight(height)}US5${String(sequence).padStart(2, "0")}`;
};

export const assertPackagingLotMatchesLabel = (wip, manufacturingDate) => {
  const lot = String(wip?.packLot || "").trim();
  const match = lot.match(/^(\d{6})([1-9]\d*(?:\.\d+)?T)US5(\d{2})$/);
  if (!match && wip?.packLotFormat !== PACKAGING_LOT_FORMAT) return; // Preserve legacy F… lots.
  if (!match || Number(match[3]) === 0 ||
      match[1] !== packagingDateKey(manufacturingDate) || match[2] !== packagingHeight(wip.height)) {
    throw new Error("발급된 로트의 제조일 또는 높이가 라벨 정보와 다릅니다. 기존 라벨과 로트 이력을 확인해주세요.");
  }
};

// Reads only: callers can finish every transaction read before any writes.
// Counter, WIP and print job are then committed as one atomic operation.
export const preparePackagingLot = async ({ transaction, getDocRef, wip, manufacturingDate, now }) => {
  const existing = String(wip.packLot || "").trim();
  if (existing) {
    assertPackagingLotMatchesLabel(wip, manufacturingDate);
    return { lot: existing, wipUpdate: {}, counter: null };
  }
  const dateKey = packagingDateKey(manufacturingDate);
  packagingHeight(wip.height);
  // A separate namespace starts the new scheme at 01, independent of legacy F counters.
  // All heights, shades and split WIPs for this factory/manufacturing day share it.
  const counterRef = getDocRef("systemCounters", `packLot-US5-${dateKey}`);
  const snap = await transaction.get(counterRef);
  const lastSeq = snap.exists() ? snap.data().lastSeq : 0;
  if (!Number.isInteger(lastSeq) || lastSeq < 0 || lastSeq > 99) {
    throw new Error("로트 순번 기록이 올바르지 않습니다. 관리자 확인 후 다시 시도해주세요.");
  }
  const sequence = lastSeq + 1;
  const lot = formatPackagingLot(manufacturingDate, wip.height, sequence);
  return {
    lot,
    wipUpdate: { packLot: lot, packLotCreatedAt: now, packLotManufacturingDate: manufacturingDate,
      packLotFormat: PACKAGING_LOT_FORMAT, packLotSequence: sequence },
    counter: { ref: counterRef, data: { dateKey, manufacturingDate, factoryCode: "5", discCode: "US",
      lastSeq: sequence, updatedAt: now } }
  };
};

// A physically split child must not inherit its parent's printed LOT or print approval.
// Retain the former packaging/print records as lineage, including after a process rollback.
export const splitPackagingIdentity = wip => {
  const child = { ...wip };
  const inherited = {};
  for (const key of Object.keys(child)) {
    if (/^(packLot|labelPrint|labelReprint|labelLastReprint)/.test(key)) {
      inherited[key] = child[key];
      delete child[key];
    }
  }
  if (Object.keys(inherited).length) {
    child.packagingLotLineage = [...(wip.packagingLotLineage || []), { sourceWipId: wip.id, ...inherited }];
  }
  return child;
};
