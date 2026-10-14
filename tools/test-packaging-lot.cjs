// Synthetic transaction/print-queue fixtures only; never connects to production.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/App.js"), "utf8");
const helper = name => fs.readFileSync(path.join(root, "src", name), "utf8").replaceAll("export const ", "const ");
const lotHelper = helper("packagingLot.js");
const dateHelper = helper("labelManufacturingDate.js");
const existingHelpers = source.slice(source.indexOf("const HEAT_FURNACE_IDS ="), source.indexOf("const DEFAULT_DRYING_ROOM ="));
const lotReaders = source.slice(source.indexOf("const getPackagingLot ="), source.indexOf("const LotLink ="));
const packagingStart = source.indexOf("function Step8Packaging(");
const printStart = source.indexOf("  const handlePrintLabel =", packagingStart);
const printHandler = source.slice(printStart, source.indexOf("\n  return (", printStart));
const completeStart = source.indexOf("  const moveNext =", packagingStart);
const completeHandler = source.slice(completeStart, printStart);
const clone = value => JSON.parse(JSON.stringify(value));
const ref = (collection, id) => ({ path: `${collection}/${id}`, id });
const fixture = (id, height = "25", date = "2026-10-14") => ({
  id, mixLot: `MIX-261010-123-${id}`, type: "345 BL3", height, qty: 10,
  currentStep: "step8", shrinkageRate: "19.5", shrinkageStatus: "measured",
  heatTreatmentHistory: [{ completedAt: `${date} 18:00:00` }], details: "existing history"
});

function database(records = {}) {
  const docs = new Map(Object.entries(clone(records)));
  const versions = new Map();
  let retries = 0;
  let rejectCommit = false;
  const read = key => docs.has(key) ? clone(docs.get(key)) : undefined;
  const write = (key, value) => { docs.set(key, clone(value)); versions.set(key, (versions.get(key) || 0) + 1); };
  return {
    read, write, retries: () => retries, rejectCommit: value => { rejectCommit = value; },
    entries: prefix => [...docs].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, clone(value)]),
    async runTransaction(_db, callback) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const reads = new Map();
        const writes = [];
        const result = await callback({
          get: async reference => {
            assert.equal(writes.length, 0, "Firestore reads must precede writes");
            const data = read(reference.path);
            reads.set(reference.path, versions.get(reference.path) || 0);
            return { exists: () => data !== undefined, data: () => clone(data), ref: reference };
          },
          set: (reference, data, options) => writes.push({ reference, data: clone(data), merge: !!options?.merge }),
          update: (reference, data) => writes.push({ reference, data: clone(data), merge: true }),
          delete: reference => writes.push({ reference, remove: true })
        });
        if ([...reads].some(([key, version]) => version !== (versions.get(key) || 0))) { retries++; continue; }
        if (rejectCommit) throw new Error("Simulated atomic commit failure");
        for (const item of writes) {
          if (item.remove) { docs.delete(item.reference.path); versions.set(item.reference.path, (versions.get(item.reference.path) || 0) + 1); }
          else write(item.reference.path, item.merge ? { ...read(item.reference.path), ...item.data } : item.data);
        }
        return result;
      }
      throw new Error("Too many transaction retries");
    }
  };
}

function screen(db, id, { form = {}, now = "2026-10-16 10:00:00" } = {}) {
  const wip = db.read(`wipList/${id}`);
  const toasts = [], previews = [];
  const context = vm.createContext({
    Date, console: { ...console, error: () => {} }, db, wipList: [wip], formData: { [id]: form }, printedStatus: {},
    printingRef: { current: new Set() }, setPrinting: () => {}, setPrintedStatus: () => {},
    setLabelPreview: value => previews.push(clone(value)),
    ctx: { showToast: (message, type) => toasts.push({ message, type }) },
    getKST: () => now, getFirestore: () => db, getDocRef: ref,
    doc: (_db, collection, key) => ref(collection, key), serverTimestamp: () => "SERVER_TIME",
    runTransaction: db.runTransaction, logProcessToGoogleSheet: () => {},
    getProductSeries: value => value.split(" ")[0], getProductShade: value => value.split(" ")[1],
    getProductSKU: (value, height) => `Z${value.replace(/\s/g, "")}${height}`
  });
  vm.runInContext(lotHelper + dateHelper + existingHelpers + lotReaders + completeHandler + printHandler +
    ";this.print = handlePrintLabel; this.complete = moveNext; this.split = splitPackagingIdentity; this.format = formatPackagingLot;", context);
  return { print: () => context.print(id), complete: () => context.complete(id), toasts, previews,
    split: wip => clone(context.split(wip)), format: (...args) => context.format(...args) };
}

test("date/height validation and exact US5 format", () => {
  const h = screen(database({ "wipList/A": fixture("A") }), "A");
  assert.equal(h.format("2026-10-14", "25", 1), "26101425TUS501");
  assert.equal(h.format("2026-10-14", "30T", 99), "26101430TUS599");
  for (const args of [["2026-02-30", "25", 1], ["invalid", "25", 1], ["2026-10-14", "", 1],
    ["2026-10-14", "25x", 1], ["2026-10-14", "25", 0], ["2026-10-14", "25", 100]]) assert.throws(() => h.format(...args));
});

test("manufacturing day drives shared numbering across heights, shades and later print dates", async () => {
  const db = database({ "wipList/A": fixture("A"), "wipList/B": { ...fixture("B", "30"), type: "234 A2" },
    "wipList/C": fixture("C", "25", "2026-10-15"), "wipList/D": fixture("D") });
  for (const id of ["A", "B", "C", "D"]) await screen(db, id).print();
  assert.deepEqual(["A", "B", "C", "D"].map(id => db.read(`wipList/${id}`).packLot),
    ["26101425TUS501", "26101430TUS502", "26101525TUS501", "26101425TUS503"]);
  const job = db.entries("print-queue/")[0][1];
  assert.equal(job.lotNumber, "26101425TUS501"); assert.equal(job.mfgDate, "2026-10-14");
  assert.equal(job.sourceLot, fixture("A").mixLot); assert.equal(job.quantity, 10); assert.equal(job.unitQty, 1);
  assert.equal(job.gtin, "08600015381754"); assert.equal(job.status, "pending");
});

test("concurrent operators receive unique consecutive numbers, including transaction retries", async () => {
  const items = Array.from({ length: 8 }, (_, i) => fixture(String(i), i % 2 ? "30" : "25"));
  const db = database(Object.fromEntries(items.map(w => [`wipList/${w.id}`, w])));
  await Promise.all(items.map(w => screen(db, w.id).print()));
  const numbers = items.map(w => db.read(`wipList/${w.id}`).packLotSequence).sort((a, b) => a - b);
  assert.deepEqual(numbers, [1, 2, 3, 4, 5, 6, 7, 8]); assert.ok(db.retries() > 0);
  assert.equal(db.entries("print-queue/").length, 8);
});

test("two screens printing the same lot concurrently create one job and consume one number", async () => {
  const db = database({ "wipList/A": fixture("A") });
  const a = screen(db, "A"), b = screen(db, "A");
  await Promise.all([a.print(), b.print()]);
  assert.equal(db.entries("print-queue/").length, 1);
  assert.equal(db.read("systemCounters/packLot-US5-261014").lastSeq, 1);
  assert.ok([...a.toasts, ...b.toasts].some(t => t.type === "error"));
});

test("reprinting preserves the assigned lot, counter and audit links", async () => {
  const db = database({ "wipList/A": fixture("A") });
  await screen(db, "A").print();
  await screen(db, "A", { now: "2026-10-17 10:00:00" }).print();
  const jobs = db.entries("print-queue/").map(([, value]) => value);
  assert.equal(jobs.length, 2); assert.ok(jobs.every(j => j.lotNumber === "26101425TUS501"));
  assert.equal(db.read("systemCounters/packLot-US5-261014").lastSeq, 1);
  assert.equal(db.read("wipList/A").labelPrintHistory[1].lotNumber, jobs[1].lotNumber);
});

test("existing F lots print unchanged without creating a new counter", async () => {
  const db = database({ "wipList/A": { ...fixture("A"), packLot: "F260914018" } });
  await screen(db, "A").print();
  assert.equal(db.read("wipList/A").packLot, "F260914018");
  assert.equal(db.entries("print-queue/")[0][1].lotNumber, "F260914018");
  assert.equal(db.entries("systemCounters/").length, 0);
});

test("failed queue commit rolls back LOT, counter, date confirmation and print history", async () => {
  const original = { ...fixture("A"), heatTreatmentHistory: [] };
  const db = database({ "wipList/A": original }); db.rejectCommit(true);
  await screen(db, "A", { form: { labelMfgDate: "2026-10-14", labelMfgReason: "일지", operator: "담당" } }).print();
  assert.deepEqual(db.read("wipList/A"), original);
  assert.equal(db.entries("systemCounters/").length, 0); assert.equal(db.entries("print-queue/").length, 0);
  db.rejectCommit(false);
  await screen(db, "A", { form: { labelMfgDate: "2026-10-14", labelMfgReason: "일지", operator: "담당" } }).print();
  assert.equal(db.read("wipList/A").packLot, "26101425TUS501");
  assert.equal(db.read("wipList/A").heatTreatmentHistory.length, 0);
});

test("missing manufacturing evidence does not allocate or print", async () => {
  const original = { ...fixture("A"), heatTreatmentHistory: [] };
  const db = database({ "wipList/A": original }); await screen(db, "A").print();
  assert.deepEqual(db.read("wipList/A"), original);
  assert.equal(db.entries("systemCounters/").length, 0); assert.equal(db.entries("print-queue/").length, 0);
});

test("99 is the final number; overflow and damaged counters never wrap or reset", async () => {
  for (const value of [99, -1, "2", null, 1.5]) {
    const db = database({ "wipList/A": fixture("A"), "systemCounters/packLot-US5-261014": { lastSeq: value } });
    const h = screen(db, "A"); await h.print();
    assert.equal(db.read("wipList/A").packLot, undefined); assert.equal(db.entries("print-queue/").length, 0);
    assert.equal(db.read("systemCounters/packLot-US5-261014").lastSeq, value); assert.equal(h.toasts.at(-1).type, "error");
  }
  const db = database({ "wipList/A": fixture("A"), "systemCounters/packLot-US5-261014": { lastSeq: 98 } });
  await screen(db, "A").print(); assert.equal(db.read("wipList/A").packLot, "26101425TUS599");
});

test("split children get independent sequences and retain parent packaging lineage", async () => {
  const db = database({ "wipList/A": fixture("A") }); await screen(db, "A").print();
  const parent = db.read("wipList/A"), h = screen(db, "A");
  for (const id of ["B", "C"]) {
    const child = { ...h.split(parent), id, mixLot: `${parent.mixLot}-${id}`, qty: 5 };
    assert.equal(child.packLot, undefined); assert.equal(child.labelPrintedAt, undefined); assert.equal(child.labelPrintHistory, undefined);
    assert.equal(child.packagingLotLineage[0].packLot, "26101425TUS501");
    assert.equal(child.packagingLotLineage[0].labelPrintHistory.length, 1);
    db.write(`wipList/${id}`, child); await screen(db, id).print();
  }
  assert.equal(db.read("wipList/B").packLot, "26101425TUS502");
  assert.equal(db.read("wipList/C").packLot, "26101425TUS503");
  assert.deepEqual(db.read("wipList/A"), parent);
});

test("packaging completion retains assigned lot and MIX linkage", async () => {
  const db = database({ "wipList/A": fixture("A") }); await screen(db, "A").print();
  const h = screen(db, "A", { form: { operator: "담당" } }); await h.complete();
  assert.equal(db.read("wipList/A").currentStep, "done");
  assert.equal(db.read("wipList/A").packLot, "26101425TUS501");
  assert.equal(db.read("wipList/A").productionLot, fixture("A").mixLot);
});

test("changed manufacturing date, height or product blocks stale reprint/completion", async () => {
  for (const change of [{ height: "30" }, { heatTreatmentHistory: [{ completedAt: "2026-10-15 18:00:00" }] }, { type: "234 A2" }]) {
    const db = database({ "wipList/A": fixture("A") }); await screen(db, "A").print();
    db.write("wipList/A", { ...db.read("wipList/A"), ...change });
    const h = screen(db, "A", { form: { operator: "담당" } }); await h.complete();
    assert.equal(db.read("wipList/A").currentStep, "step8");
    if (!change.type) { await h.print(); assert.equal(db.entries("print-queue/").length, 1); }
    assert.equal(h.toasts.at(-1).type, "error");
  }
});

test("a MIX trace changed by another operator cannot enter a stale print job", async () => {
  const db = database({ "wipList/A": fixture("A") });
  const h = screen(db, "A");
  db.write("wipList/A", { ...fixture("A"), mixLot: "MIX-261014-999" });
  await h.print(); assert.equal(db.entries("print-queue/").length, 0);
  assert.equal(h.toasts.at(-1).type, "error");
});

test("actual A/B molding handler clears inherited label approval for both children", async () => {
  const original = { ...fixture("A"), currentStep: "step4", packLot: "F260914018", labelPrintedAt: "old", labelPrintHistory: [{ jobId: "old-job" }] };
  const db = database({ "wipList/A": original });
  const start = source.indexOf("  const moveNext =", source.indexOf("function Step4SecondMolding("));
  const handler = source.slice(start, source.indexOf("\n  return (", start));
  const toasts = [];
  const context = vm.createContext({
    Date, db, formData: { A: { operator: "담당", qtyA: "6", qtyB: "4" } }, wipList: [original],
    masterSettings: {}, calcAvg: () => "0", getSeriesPressure: () => "250", getKST: () => "2026-10-16 10:00:00",
    getDocRef: ref, runTransaction: db.runTransaction, logProcessToGoogleSheet: () => {},
    ctx: { showToast: (message, type) => toasts.push({ message, type }) }
  });
  vm.runInContext(lotHelper + handler + ";this.run=moveNext;", context); await context.run("A");
  assert.equal(toasts.at(-1).type, "success"); assert.equal(db.read("wipList/A"), undefined);
  const children = db.entries("wipList/").map(([, w]) => w);
  assert.deepEqual(children.map(w => w.qty).sort(), [4, 6]);
  for (const child of children) {
    assert.equal(child.packLot, undefined); assert.equal(child.labelPrintedAt, undefined);
    assert.equal(child.packagingLotLineage[0].packLot, original.packLot);
  }
});

test("actual shipping handler carries new LOT through partial and full shipment", async () => {
  const db = database({ "wipList/A": fixture("A") });
  await screen(db, "A").print(); await screen(db, "A", { form: { operator: "담당" } }).complete();
  const start = source.indexOf("  const handleShip =", source.indexOf("function Step9FinishedGoods("));
  const handler = source.slice(start, source.indexOf("\n  const inventorySummary", start));
  for (const quantity of [3, 7]) {
    const confirmations = [], toasts = [];
    const context = vm.createContext({
      Date, db, shipData: { A: { qty: quantity, destination: "시험 출고처", operator: "담당" } },
      shippingBusy: { current: new Set() }, setShippingIds: () => {}, setShipData: () => {},
      getKST: () => "2026-10-16 10:00:00", serverTimestamp: () => "SERVER_TIME",
      getDocRef: ref, runTransaction: db.runTransaction, logProcessToGoogleSheet: () => {},
      ctx: { showToast: (message, type) => toasts.push({ message, type }),
        showConfirm: (_message, callback) => confirmations.push(callback()) }
    });
    vm.runInContext(existingHelpers + lotReaders + handler + ";this.run=handleShip;", context);
    await context.run(db.read("wipList/A")); await Promise.all(confirmations);
    assert.equal(toasts.at(-1).type, "success");
  }
  const history = db.entries("shippingHistory/").map(([, row]) => row);
  assert.equal(history.length, 2); assert.equal(db.read("wipList/A"), undefined);
  for (const row of history) {
    assert.equal(row.lot, "26101425TUS501"); assert.equal(row.packLot, row.lot);
    assert.equal(row.productionLot, fixture("A").mixLot);
  }
  assert.equal(db.read("systemCounters/packLot-US5-261014").lastSeq, 1);
});
