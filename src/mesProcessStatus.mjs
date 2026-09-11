// Read-only presentation. Never changes currentStep, quantities or equipment.
// Only current equipment.slotData (not historical furnaceSlots) is authoritative here.
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveQty = value => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

export function getWipProcessStatus(wip, furnaces, fallbackLabel = "\uacf5\uc815 \ud655\uc778 \ud544\uc694") {
  const result = (label, tone, furnaceIds = []) => ({ label, tone, furnaceIds });
  if (wip?.currentStep !== "step5") return result(fallbackLabel, "neutral");
  if (wip.id === undefined || wip.id === null || String(wip.id) === "" || !isRecord(furnaces)) {
    return result("\uc5f4\ucc98\ub9ac \uc0c1\ud0dc \ud655\uc778 \ud544\uc694", "warning");
  }
  const id = String(wip.id);
  const assignments = [];
  for (const [fid, furnace] of Object.entries(furnaces)) {
    if (!isRecord(furnace) || !isRecord(furnace.slotData)) continue;
    const slots = Object.values(furnace.slotData).filter(slot =>
      isRecord(slot) && slot.wipId !== undefined && slot.wipId !== null && String(slot.wipId) === id);
    if (slots.length) assignments.push({ fid, furnace, slots });
  }
  if (!assignments.length) return result("\uc5f4\ucc98\ub9ac \ub300\uae30", "neutral");
  const furnaceIds = assignments.map(a => a.fid).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const location = furnaceIds.map(fid => `${fid}\ud638\uae30`).join(", ");
  const slots = assignments.flatMap(a => a.slots);
  const qtyMatches = positiveQty(wip.qty) && slots.every(s => positiveQty(s.qty)) &&
    slots.reduce((sum, s) => sum + Number(s.qty), 0) === Number(wip.qty);
  if (assignments.length !== 1 || !qtyMatches || typeof assignments[0].furnace.isHeating !== "boolean") {
    return result(`\uc5f4\ucc98\ub9ac \ubc30\uc815 \ud655\uc778 \ud544\uc694 (${location})`, "warning", furnaceIds);
  }
  return assignments[0].furnace.isHeating
    ? result(`\uc5f4\ucc98\ub9ac \uc911 (${location})`, "heating", furnaceIds)
    : result(`\uc804\uae30\ub85c \ubc30\uc815 (${location})`, "assigned", furnaceIds);
}
