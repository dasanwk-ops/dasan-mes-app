// Regression checks for zero-yield quality closure. Read-only: no Firebase calls.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const moduleSource = fs.readFileSync(path.join(__dirname, "../src/fullyDefectiveClosure.js"), "utf8");
  const { FULLY_DEFECTIVE_STEP, isFullyDefectiveClosed, canCloseFullyDefective, hasActiveEquipmentReference } =
    await import("data:text/javascript;charset=utf-8," + encodeURIComponent(moduleSource));
  const wip = { id: "example", qty: 0, currentStep: "step8", mixLot: "MIX-TEST-001" };

  assert.equal(FULLY_DEFECTIVE_STEP, "scrapped");
  assert.equal(canCloseFullyDefective(wip), true, "zero-yield packaging LOT can close");
  assert.equal(canCloseFullyDefective({ ...wip, currentStep: "step3" }), true, "zero-yield earlier process can close");
  assert.equal(canCloseFullyDefective({ ...wip, qty: 1 }), false, "nonzero yield cannot close");
  assert.equal(canCloseFullyDefective({ ...wip, qty: -1 }), false, "invalid quantity cannot close");
  assert.equal(canCloseFullyDefective({ ...wip, currentStep: "done" }), false, "finished goods cannot close");
  assert.equal(canCloseFullyDefective({ ...wip, currentStep: FULLY_DEFECTIVE_STEP }), false, "cannot close twice");
  assert.equal(canCloseFullyDefective({ ...wip, labelPrintedAt: "2026-11-23" }), false, "issued labels block closure");
  assert.equal(canCloseFullyDefective({ ...wip, labelPrintJobId: "job-1" }), false, "pending label job blocks closure");
  assert.equal(canCloseFullyDefective({ ...wip, packLot: "26112325TUS501" }), false, "assigned pack LOT blocks closure");
  assert.equal(isFullyDefectiveClosed({ ...wip, currentStep: "scrapped" }), true);
  assert.equal(isFullyDefectiveClosed(wip), false);

  assert.equal(hasActiveEquipmentReference(wip.id, {}, {}), false, "unassigned LOT can close");
  assert.equal(hasActiveEquipmentReference(wip.id, { 1: { slotData: { L1: { wipId: "example", qty: 1 } } } }, {}), true, "furnace assignment blocks closure");
  assert.equal(hasActiveEquipmentReference(wip.id, {}, { dryingWipIds: ["example"] }), true, "active drying blocks closure");
  assert.equal(hasActiveEquipmentReference(wip.id, {}, { cartItems: [{ wipId: "example" }] }), true, "drying cart blocks closure");
  assert.equal(hasActiveEquipmentReference(wip.id, {}, { completionData: { example: { defects: 0 } } }), true, "drying form blocks closure");
  assert.equal(hasActiveEquipmentReference("other", { 1: { slotData: { L1: { wipId: "example" } } } }, {}), false, "another LOT is unaffected");

  const app = fs.readFileSync(path.join(__dirname, "../src/App.js"), "utf8");
  const includes = (fragment, message) => assert.ok(app.includes(fragment), message);
  includes('currentStep: FULLY_DEFECTIVE_STEP,', "closure writes dedicated status");
  includes('qty: 0,\n              currentStep: FULLY_DEFECTIVE_STEP,', "closure writes zero quantity");
  includes('fullyDefectiveClosedAt: now,', "closure records time");
  includes('fullyDefectiveClosedBy: operator,', "closure records operator");
  includes('fullyDefectiveReason: reason,', "closure records reason");
  includes('details: `${live.details || ""}', "closure retains process history");
  includes('hasActiveEquipmentReference(wip.id,', "closure checks equipment before commit");
  includes('.filter(w => !isFullyDefectiveClosed(w))', "closed LOT omitted from order coverage");
  includes('!isFullyDefectiveClosed(w));', "closed LOT omitted from active dashboard");
  includes('fullyDefectiveHistory.map(wip => (', "closed LOT visible in audit history");
  includes('if (isFullyDefectiveClosed(snapshot.data())) throw new Error', "tracking prevents deletion race");
  includes('currentStep === "done" && Number(w.qty) > 0', "finished inventory still excludes zero-quantity LOTs");

  console.log("PASS: fully defective closure eligibility, equipment guards, audit trail and WIP accounting");
})().catch(err => { console.error(err); process.exitCode = 1; });
