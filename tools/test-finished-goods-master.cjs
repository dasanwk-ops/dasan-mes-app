const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { applyFinishedGoodsMaster } = require("./apply-finished-goods-master.cjs");
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log("PASS " + name); };
(async () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/finishedGoodsMaster.js"), "utf8");
  const { stockNumber, buildFinishedRows, filterFinishedRows, finishedHistory, planFinishedAdjustment, commitFinishedAdjustment } =
    await import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
  const helpers = {
    getPackagingLot: item => String(item?.packLot || (item?.currentStep === "done" && /^F/i.test(item?.mixLot || "") ? item.mixLot : "") || item?.lot || "").trim(),
    getTraceMixLot: item => [item?.mixLot, item?.productionLot, item?.sourceLot, item?.originalLot].map(x => String(x || "").trim()).find(x => /^MIX-/i.test(x)) || "",
    getProductLabel: value => /^(345|234)\s/.test(String(value || "")) ? value : `345 ${value || ""}`
  };
  // Synthetic fixtures only. These are not read from the production database.
  const wip = {
    id: "fixture-1", currentStep: "done", packLot: "F260928001", mixLot: "MIX-260907-696-B",
    type: "345 B1", height: "30", qty: 56, orderId: "fixture-order",
    packagedAt: "2026-09-28 15:00:00", details: "unchanged process history",
    labelPrintedQty: 56, labelPrintCount: 1, labelPrintHistory: [{ quantity: 56 }],
    shrinkageRate: 19.5, weight: 15, consumedMaterials: [{ qty: 15 }]
  };
  const request = {
    expected: { ...wip }, targetQty: "57", reason: " Count checked ", operator: " Tester ",
    actorUid: "fixture-anonymous-user", isAdmin: true, adjustmentId: "adjust-1", now: "2026-09-29 15:00:00"
  };
  await test("strict quantity validation including zero vs blank", () => {
    for (const x of ["", " ", null, undefined, false, true, [], {}, -1, "1.5", Infinity, "abc", Number.MAX_SAFE_INTEGER + 1]) assert.equal(stockNumber(x), null);
    for (const x of [0, "0", 56, "57"]) assert.equal(stockNumber(x), Number(x));
  });
  await test("56 -> 57 plan updates stock and audit metadata only", () => {
    const original = structuredClone(wip);
    const plan = planFinishedAdjustment(wip, request, helpers);
    assert.equal(plan.update.qty, 57);
    assert.deepEqual(Object.keys(plan.update).sort(), ["finishedGoodsAdjustmentRevision", "finishedGoodsLastAdjustment", "qty"]);
    assert.equal(plan.history.beforeQty, 56); assert.equal(plan.history.afterQty, 57); assert.equal(plan.history.deltaQty, 1);
    assert.equal(plan.history.packLot, wip.packLot); assert.equal(plan.history.productionLot, wip.mixLot);
    assert.equal(plan.history.reason, "Count checked"); assert.equal(plan.history.operator, "Tester");
    assert.deepEqual(wip, original);
  });
  await test("zero is allowed and does not delete or recreate a LOT", () => {
    const plan = planFinishedAdjustment(wip, { ...request, targetQty: "0" }, helpers);
    assert.equal(plan.update.qty, 0); assert.equal(plan.history.deltaQty, -56);
    assert.equal(plan.update.currentStep, undefined);
  });
  for (const [name, change] of [
    ["blank target", { targetQty: "" }], ["negative", { targetQty: -1 }], ["fraction", { targetQty: 57.5 }],
    ["no change", { targetQty: 56 }], ["blank reason", { reason: " " }], ["long reason", { reason: "a".repeat(501) }],
    ["blank operator", { operator: "" }], ["worker mode", { isAdmin: false }], ["missing actor", { actorUid: "" }]
  ]) await test("reject " + name, () => assert.throws(() => planFinishedAdjustment(wip, { ...request, ...change }, helpers)));
  for (const [name, live] of [
    ["missing document", null], ["in process", { ...wip, currentStep: "step8" }], ["shipped stock", { ...wip, qty: 55 }],
    ["changed final lot", { ...wip, packLot: "F260928002" }], ["changed mix lot", { ...wip, mixLot: "MIX-other" }],
    ["changed product", { ...wip, type: "234 B1" }], ["changed height", { ...wip, height: "25" }],
    ["changed revision even with same quantity", { ...wip, finishedGoodsAdjustmentRevision: 2 }],
    ["corrupt live qty", { ...wip, qty: null }]
  ]) await test("reject stale target: " + name, () => assert.throws(() => planFinishedAdjustment(live, request, helpers)));
  const shipment = { id: "ship-1", sourceWipId: wip.id, packLot: wip.packLot, productionLot: wip.mixLot, type: wip.type, height: "30", qty: 56,
    stockBeforeQty: 56, remainingQty: 0, date: "2026-09-29 16:00", operator: "Shipper", destination: "Test only" };
  await test("uses done WIP only, not work-in-process quantities", () => {
    const rows = buildFinishedRows([wip, { id: "wip-2", currentStep: "step3", qty: 96, mixLot: "MIX-progress" }], [], [], helpers);
    assert.equal(rows.length, 1); assert.equal(rows[0].qty, 56); assert.equal(rows[0].adjustable, true);
  });
  await test("zero-stock shipped LOT is readable, not silently recreated", () => {
    const rows = buildFinishedRows([], [shipment], [], helpers);
    assert.equal(rows[0].qty, 0); assert.equal(rows[0].adjustable, false);
    assert.equal(filterFinishedRows(rows).length, 0); assert.equal(filterFinishedRows(rows, { includeZero: true }).length, 1);
  });
  await test("search by final LOT, MIX LOT and product with product filter", () => {
    const rows = buildFinishedRows([wip], [], [], helpers);
    assert.equal(filterFinishedRows(rows, { search: "f260928001" }).length, 1);
    assert.equal(filterFinishedRows(rows, { search: "mix-260907 30T" }).length, 1);
    assert.equal(filterFinishedRows(rows, { product: "345 B1 30T" }).length, 1);
    assert.equal(filterFinishedRows(rows, { product: "234 B1 30T" }).length, 0);
  });
  await test("split final packaging LOTs stay separate even with same MIX", () => {
    const rows = buildFinishedRows([wip, { ...wip, id: "fixture-2", packLot: "F260928002", qty: 10 }], [], [], helpers);
    assert.equal(rows.length, 2); assert.equal(rows.reduce((n, row) => n + row.qty, 0), 66);
  });
  await test("duplicate WIP documents sum for display but cannot be edited ambiguously", () => {
    const rows = buildFinishedRows([wip, { ...wip, id: "duplicate", qty: 1 }], [], [], helpers);
    assert.equal(rows.length, 1); assert.equal(rows[0].qty, 57); assert.equal(rows[0].adjustable, false);
  });
  await test("missing final LOT and mixed product links block correction", () => {
    assert.equal(buildFinishedRows([{ ...wip, packLot: "" }], [], [], helpers)[0].adjustable, false);
    assert.equal(buildFinishedRows([wip], [{ ...shipment, type: "234 B1" }], [], helpers)[0].adjustable, false);
  });
  await test("historical final LOT rolled back to process is not editable as finished stock", () => {
    const rows = buildFinishedRows([{ ...wip, currentStep: "step8" }], [shipment], [], helpers);
    assert.equal(rows[0].qty, 0); assert.equal(rows[0].inProcess.length, 1); assert.equal(rows[0].adjustable, false);
  });
  await test("legacy shade-only product labels match normalized finished product", () => {
    const rows = buildFinishedRows([{ ...wip, type: "B1" }], [shipment], [], helpers);
    assert.equal(rows[0].adjustable, true);
  });
  await test("history preserves unknown historical values instead of inventing receipt quantities", () => {
    const audit = planFinishedAdjustment(wip, request, helpers).history;
    const rows = buildFinishedRows([{ ...wip, qty: 57 }], [{ ...shipment, stockBeforeQty: undefined, remainingQty: undefined }], [audit], helpers);
    const events = finishedHistory(rows[0]);
    assert.equal(events.find(e => e.kind === "포장 완료").delta, null);
    assert.equal(events.find(e => e.kind === "출고").before, null);
    assert.equal(events.find(e => e.kind === "수량 정정").delta, 1);
  });
  const key = ref => typeof ref === "string" ? ref : ref.path;
  function store(options = {}) {
    const docs = new Map([["wipList/fixture-1", structuredClone(wip)], ["unrelated/value", { value: 10 }]]);
    const writes = [];
    let calls = 0;
    return {
      docs, writes,
      runTransaction: async (_db, callback) => {
        const attempt = async () => {
          const pending = []; let wrote = false;
          const result = await callback({
            get: async ref => { assert.equal(wrote, false, "all reads must precede writes"); const data = docs.get(key(ref)); return { exists: () => !!data, data: () => structuredClone(data) }; },
            update: (ref, value) => { wrote = true; pending.push(["update", key(ref), structuredClone(value)]); },
            set: (ref, value) => { wrote = true; pending.push(["set", key(ref), structuredClone(value)]); }
          });
          return { pending, result };
        };
        let outcome = await attempt(); calls++;
        if (options.concurrent && calls === 1) { options.concurrent(docs); outcome = await attempt(); }
        if (options.fail) throw new Error("simulated permission failure");
        for (const [op, p, value] of outcome.pending) {
          if (op === "update") docs.set(p, { ...docs.get(p), ...value });
          else docs.set(p, value);
          writes.push({ op, path: p });
        }
        return outcome.result;
      }
    };
  }
  const args = fake => ({ request, helpers, db: {}, runTransaction: fake.runTransaction,
    getDocRef: (col, id) => `${col}/${id}`, adjustmentRef: { id: "adjust-1", path: "finishedGoodsAdjustments/adjust-1" },
    serverTimestamp: () => "server-time-placeholder" });
  await test("atomic commit updates the shipping WIP and creates one permanent audit", async () => {
    const fake = store(); await commitFinishedAdjustment(args(fake));
    const saved = fake.docs.get("wipList/fixture-1");
    assert.equal(saved.qty, 57); assert.equal(fake.docs.get("finishedGoodsAdjustments/adjust-1").deltaQty, 1);
    assert.equal(fake.docs.get("finishedGoodsAdjustments/adjust-1").createdAt, "server-time-placeholder");
    for (const field of Object.keys(wip).filter(field => field !== "qty")) assert.deepEqual(saved[field], wip[field]);
    assert.deepEqual(fake.writes.map(x => x.path), ["wipList/fixture-1", "finishedGoodsAdjustments/adjust-1"]);
    assert.deepEqual(fake.docs.get("unrelated/value"), { value: 10 });
  });
  await test("duplicate request is idempotent; no second +1 audit", async () => {
    const fake = store(); await commitFinishedAdjustment(args(fake));
    const again = await commitFinishedAdjustment(args(fake));
    assert.equal(again.alreadySaved, true); assert.equal(fake.writes.length, 2);
    assert.equal(fake.docs.get("wipList/fixture-1").qty, 57);
  });
  await test("network retry after subsequent full shipping never recreates WIP", async () => {
    const fake = store(); await commitFinishedAdjustment(args(fake)); fake.docs.delete("wipList/fixture-1");
    assert.equal((await commitFinishedAdjustment(args(fake))).alreadySaved, true);
    assert.equal(fake.docs.has("wipList/fixture-1"), false); assert.equal(fake.writes.length, 2);
  });
  await test("failed atomic write leaves both stock and ledger unchanged", async () => {
    const fake = store({ fail: true }); await assert.rejects(() => commitFinishedAdjustment(args(fake)));
    assert.equal(fake.docs.get("wipList/fixture-1").qty, 56);
    assert.equal(fake.docs.has("finishedGoodsAdjustments/adjust-1"), false); assert.equal(fake.writes.length, 0);
  });
  for (const [name, concurrent] of [
    ["partial shipping", docs => docs.set("wipList/fixture-1", { ...wip, qty: 55 })],
    ["full shipping", docs => docs.delete("wipList/fixture-1")]
  ]) await test("transaction retry after concurrent " + name + " fails safely", async () => {
    const fake = store({ concurrent }); await assert.rejects(() => commitFinishedAdjustment(args(fake)));
    assert.equal(fake.docs.has("finishedGoodsAdjustments/adjust-1"), false); assert.equal(fake.writes.length, 0);
  });
  await test("non-admin requests do not start a database transaction", async () => {
    let calls = 0; await assert.rejects(() => commitFinishedAdjustment({ ...args(store()), request: { ...request, isAdmin: false },
      runTransaction: () => { calls++; } })); assert.equal(calls, 0);
  });
  const appPath = path.join(__dirname, "../src/App.js");
  if (fs.existsSync(appPath)) await test("integration is idempotent and preserves all production functions", () => {
    const original = fs.readFileSync(appPath, "utf8");
    const updated = applyFinishedGoodsMaster(original);
    assert.equal(applyFinishedGoodsMaster(updated), updated);
    assert.equal(updated.slice(updated.indexOf("function Step0OrderManagement(")),
      original.slice(original.indexOf("function Step0OrderManagement(")));
    for (const name of ["handleSaveWip", "handleDeleteWip"]) {
      const extract = s => s.slice(s.indexOf(`  const ${name} =`), s.indexOf("\n  };", s.indexOf(`  const ${name} =`)) + 6);
      assert.equal(extract(updated), extract(original));
    }
    assert.equal(updated.split("<FinishedGoodsMaster").length, 2);
    assert.equal(updated.split('import FinishedGoodsMaster from "./FinishedGoodsMaster";').length, 2);
    assert.ok(updated.indexOf("<FinishedGoodsMaster") > updated.indexOf("activeWipList.map"));
  });
  await test("patch fails closed when a required source anchor changed", () => assert.throws(() => applyFinishedGoodsMaster("unrelated source")));
  console.log(`Finished goods master: ${passed} tests passed. Production Firebase was not accessed.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
