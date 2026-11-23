// Production LOTs with no acceptable units are retained for quality traceability.
// A fully defective LOT must never be treated as finished inventory or a label job.
export const FULLY_DEFECTIVE_STEP = "scrapped";

export const isFullyDefectiveClosed = (wip) =>
  wip?.currentStep === FULLY_DEFECTIVE_STEP;

export const canCloseFullyDefective = (wip) => {
  if (!wip || !wip.currentStep || ["done", FULLY_DEFECTIVE_STEP].includes(wip.currentStep)) return false;
  const qty = Number(wip.qty);
  return Number.isInteger(qty) && qty === 0 &&
    !wip.labelPrintedAt && !wip.labelPrintJobId && !wip.packLot;
};

// Never close a LOT while it is still assigned to furnace or drying equipment.
export const hasActiveEquipmentReference = (wipId, furnaces = {}, dryingRoom = {}) => {
  const id = String(wipId);
  const furnaceAssigned = Object.values(furnaces || {}).some((furnace) =>
    Object.values(furnace?.slotData || {}).some((slot) =>
      String(slot?.wipId ?? "") === id
    )
  );
  const dryingAssigned = (dryingRoom?.dryingWipIds || []).some((item) =>
    String(item) === id
  ) || (dryingRoom?.cartItems || []).some((item) =>
    String(item?.wipId ?? item?.id ?? "") === id
  ) || Object.prototype.hasOwnProperty.call(dryingRoom?.completionData || {}, id);
  return furnaceAssigned || dryingAssigned;
};
