// Label-only date resolution. Never invent heat-treatment records or use a LOT's
// creation/packaging date as its manufacturing date.
export const normalizeManufacturingDate = value => {
  if (value && typeof value === "object") {
    if (typeof value.toDate === "function") return normalizeManufacturingDate(value.toDate());
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? new Date(value.getTime() + 9 * 3600000).toISOString().slice(0, 10) : "";
    }
    if (Number.isFinite(value.seconds)) return normalizeManufacturingDate(new Date(value.seconds * 1000));
    return "";
  }
  if (typeof value !== "string") return "";
  const text = value.trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?=$|[ T])/);
  if (!match) return "";
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() + 1 !== Number(m) || date.getUTCDate() !== Number(d)) return "";
  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) return normalizeManufacturingDate(new Date(text));
  if (!/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(text)) return "";
  return `${y}-${m}-${d}`;
};

export const getLabelManufacturingDate = (wip, today) => {
  const candidates = [];
  const add = (value, source) => {
    const date = normalizeManufacturingDate(value);
    if (date && date <= today) candidates.push({date, source});
  };
  for (const record of Array.isArray(wip?.heatTreatmentHistory) ? wip.heatTreatmentHistory : []) add(record?.completedAt, "heat_history");
  add(wip?.heatCompletedAt, "heat_completed_at");
  for (const slot of Array.isArray(wip?.furnaceSlots) ? wip.furnaceSlots : []) add(slot?.heatCompletedAt, "heat_slot");
  // Only dated completion events qualify; starts, measurements and free-form
  // mentions of heat treatment are not manufacturing-date evidence.
  const event = /(?:^|\n)\s*\[([^\]\n]+)\]\s*\[열처리\s*완료\]/g;
  for (const match of String(wip?.details || "").matchAll(event)) add(match[1], "process_history");
  if (candidates.length) return candidates.reduce((latest, item) => item.date > latest.date ? item : latest);

  const confirmed = wip?.labelManufacturingDateConfirmation;
  const confirmedDate = normalizeManufacturingDate(confirmed?.date);
  if (confirmedDate && confirmedDate <= today && String(confirmed?.confirmedBy || "").trim() && String(confirmed?.reason || "").trim() && confirmed?.confirmedAt) {
    return {date:confirmedDate, source:"confirmed"};
  }
  // Preserve the previously user-approved exception, with its original scope.
  if (String(wip?.id || "") === "stocktake-recovery-260724-667" &&
      String(wip?.mixLot || "") === "MIX-260724-667" && Number(wip?.qty) === 94 &&
      String(wip?.shrinkageRate || "") === "19.7665" &&
      String(wip?.stocktakeRecovery?.sourceLot || "") === "MIX-260724-667" && today >= "2026-09-21") {
    return {date:"2026-09-21",source:"approved_legacy"};
  }
  return null;
};

export const confirmLabelManufacturingDate = (fields, now) => {
  const date = normalizeManufacturingDate(fields?.labelMfgDate);
  if (!date || date > now.slice(0, 10)) throw new Error("실제 열처리 완료일을 확인해 라벨 제조일을 입력해주세요. 미래 날짜는 사용할 수 없습니다.");
  const confirmedBy = String(fields?.operator || "").trim();
  const reason = String(fields?.labelMfgReason || "").trim();
  if (!confirmedBy || !reason) throw new Error("제조일 확인 근거와 담당 작업자를 입력해주세요.");
  return {date,confirmedBy,reason,confirmedAt:now};
};

export const manufacturingDateSourceLabel = source => ({
  heat_history:"열처리 이력", heat_completed_at:"열처리 완료 기록", heat_slot:"열처리 배치 기록",
  process_history:"기존 공정 이력", confirmed:"담당자 확인", approved_legacy:"기존 승인 제조일"
}[source] || "확인 필요");
