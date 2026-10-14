// Run actual molding transitions against synthetic transactions; no Firebase access.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "src/App.js"), "utf8");
const helper = fs.readFileSync(path.join(root, "src/packagingLot.js"), "utf8").replaceAll("export const ", "const ");
const start = source.indexOf("  const moveNext =", source.indexOf("function Step4SecondMolding("));
const end = source.indexOf("\n  return (", start);
assert.ok(start >= 0 && end > start, "Actual second-molding handler must exist");
const handler = source.slice(start, end);
const clone = value => JSON.parse(JSON.stringify(value));
const ref = (collection, id) => ({ path: `${collection}/${id}`, id });
class FixedDate extends Date { static now() { return 1791972000000; } }

const fixture = id => ({
  id, mixLot: `MIX-261010-${id}`, currentStep: "step4", qty: 10, height: "25", type: "345 BL3",
  orderId: `order-${id}`, originalLot: `MIX-261010-${id}`, details: "Previous process history",
  materials: [{ lot: "POWDER-1", quantity: 6.5 }],
  heatTreatmentHistory: [{ completedAt: "2026-10-12 18:00:00", furnaceId: "1" }],
  shrinkageHistory: [{ completedAt: "2026-10-13 08:00:00", shrinkageRate: "19.5" }]
});

function database(records, { failCommit = false } = {}) {
  const docs = new Map(Object.entries(clone(records)));
  let serial = 0;
  let commits = 0;
  return {
    read: key => docs.has(key) ? clone(docs.get(key)) : undefined,
    entries: () => clone([...docs]),
    write: (key, value) => docs.set(key, clone(value)),
    newRef: collection => ref(collection.path || collection, `auto-${++serial}`),
    commits: () => commits,
    runTransaction: async (_db, callback) => {
      const changes = [];
      await callback({
        get: async reference => {
          assert.equal(changes.length, 0, "Reads must precede writes");
          const value = docs.get(reference.path);
          return { exists: () => value !== undefined, data: () => clone(value), ref: reference };
        },
        set: (reference, value) => changes.push({ reference, value: clone(value) }),
        update: (reference, value) => changes.push({ reference, value: clone(value), merge: true }),
        delete: reference => changes.push({ reference, remove: true })
      });
      if (failCommit) throw new Error("Simulated commit failure");
      for (const change of changes) {
        if (change.remove) docs.delete(change.reference.path);
        else docs.set(change.reference.path, change.merge ? { ...docs.get(change.reference.path), ...change.value } : change.value);
      }
      commits++;
    }
  };
}

function screen(db, id, form = { qtyA: "6", qtyB: "4" }) {
  const original = { ...db.read(`wipList/${id}`), id };
  const toasts = [], externalLogs = [];
  const context = vm.createContext({
    Date: FixedDate, db, wipList: [original], formData: { [id]: { operator: "담당", ...form } },
    masterSettings: {}, calcAvg: () => "0.00", getSeriesPressure: () => "250",
    getKST: () => "2026-10-14 18:00:00", getDocRef: ref, getColRef: path => ({ path }),
    doc: collection => db.newRef(collection), runTransaction: db.runTransaction,
    logProcessToGoogleSheet: (...args) => externalLogs.push(clone(args)),
    ctx: { showToast: (message, type) => toasts.push({ message, type }) }
  });
  vm.runInContext(helper + handler + ";this.run = moveNext;", context);
  return { run: () => context.run(id), toasts, externalLogs };
}

test("molding rejects a stale quantity before deleting or creating WIP", async () => {
  const original = fixture("A");
  const db = database({ "wipList/A": original });
  const view = screen(db, "A");
  db.write("wipList/A", { ...original, qty: 9, details: "Concurrent approved adjustment" });
  const before = db.entries();
  await view.run();
  assert.deepEqual(db.entries(), before);
  assert.equal(db.commits(), 0);
  assert.equal(view.toasts.at(-1).type, "error");
  assert.equal(view.externalLogs.length, 0);
});

for (const [description, form] of [
  ["negative defect", { qtyA: "11", defectA: "-1" }],
  ["negative good quantity", { qtyA: "11", qtyB: "-1" }],
  ["fractional good quantity", { qtyA: "6.5", qtyB: "4" }],
  ["fractional defect quantity", { qtyA: "9", defectA: "1.5" }],
  ["numeric text suffix", { qtyA: "10units" }],
  ["nonfinite quantity", { qtyA: "Infinity" }]
]) test(`molding rejects ${description} without changing any record`, async () => {
  const db = database({ "wipList/A": fixture("A") });
  const before = db.entries(), view = screen(db, "A", form);
  await view.run();
  assert.deepEqual(db.entries(), before);
  assert.equal(db.commits(), 0);
  assert.equal(view.toasts.at(-1).type, "error");
  assert.equal(view.externalLogs.length, 0);
});

test("different parents processed within the same millisecond retain all four children", async () => {
  const db = database({ "wipList/A": fixture("A"), "wipList/B": fixture("B") });
  const a = screen(db, "A"), b = screen(db, "B");
  await Promise.all([a.run(), b.run()]);
  const children = db.entries().map(([, value]) => value);
  assert.equal(children.length, 4);
  assert.equal(new Set(children.map(w => w.id)).size, 4);
  for (const id of ["A", "B"]) {
    const related = children.filter(w => w.orderId === `order-${id}`);
    assert.equal(related.length, 2);
    assert.equal(related.reduce((sum, w) => sum + w.qty, 0), 10);
  }
  assert.equal(a.toasts.at(-1).type, "success");
  assert.equal(b.toasts.at(-1).type, "success");
});

test("unissued split WIPs preserve trace, quantity and previous process records", async () => {
  const original = fixture("A"), db = database({ "wipList/A": original });
  const view = screen(db, "A", { qtyA: "5", defectA: "1", defectReasonA: "균열", qtyB: "3", defectB: "1", defectReasonB: "치수 불량" });
  await view.run();
  const children = db.entries().map(([, value]) => value);
  assert.equal(db.read("wipList/A"), undefined);
  assert.deepEqual(children.map(w => w.qty).sort(), [3, 5]);
  assert.deepEqual(children.map(w => w.mixLot).sort(), [`${original.mixLot}-A`, `${original.mixLot}-B`]);
  for (const child of children) {
    assert.equal(child.currentStep, "step5");
    assert.equal(child.packLot, undefined);
    assert.equal(child.originalLot, original.originalLot);
    assert.equal(child.orderId, original.orderId);
    assert.deepEqual(child.materials, original.materials);
    assert.deepEqual(child.heatTreatmentHistory, original.heatTreatmentHistory);
    assert.deepEqual(child.shrinkageHistory, original.shrinkageHistory);
    assert.ok(child.details.startsWith(original.details));
    assert.match(child.details, /불량 1개/);
    assert.match(child.details, /A호기 정상:5개 \/ 불량:1개 \(균열\)/);
    assert.match(child.details, /B호기 정상:3개 \/ 불량:1개 \(치수 불량\)/);
  }
});

for (const side of ["A", "B"]) test(`all-defective ${side} line remains in the surviving child's history and process log`, async () => {
  const original = fixture("A"), db = database({ "wipList/A": original });
  const other = side === "A" ? "B" : "A";
  const view = screen(db, "A", { [`qty${side}`]: "0", [`defect${side}`]: "2", [`defectReason${side}`]: "전량 균열", [`qty${other}`]: "8" });
  await view.run();
  const children = db.entries().map(([, value]) => value);
  assert.equal(children.length, 1);
  assert.equal(children[0].qty, 8);
  assert.ok(children[0].details.includes(`${side}호기 정상:0개 / 불량:2개 (전량 균열)`));
  assert.ok(children[0].details.startsWith(original.details));
  const defectLog = view.externalLogs.find(args => args[3].equipment === `${side}호기`);
  assert.ok(defectLog);
  assert.equal(defectLog[1].qty, 0);
  assert.equal(defectLog[3].defects, 2);
  assert.equal(defectLog[3].defectReason, "전량 균열");
});

test("two physical children archive an issued legacy lot and print approval as lineage", async () => {
  const original = { ...fixture("A"), packLot: "F260914018", packLotCreatedAt: "2026-09-14 08:00:00",
    labelPrintedAt: "2026-09-14 09:00:00", labelPrintedPackLot: "F260914018", labelPrintHistory: [{ jobId: "old-job" }] };
  const db = database({ "wipList/A": original });
  await screen(db, "A").run();
  for (const [, child] of db.entries()) {
    assert.equal(child.packLot, undefined);
    assert.equal(child.labelPrintedAt, undefined);
    assert.equal(child.labelPrintHistory, undefined);
    assert.equal(child.packagingLotLineage[0].packLot, original.packLot);
    assert.equal(child.packagingLotLineage[0].sourceWipId, original.id);
    assert.deepEqual(child.packagingLotLineage[0].labelPrintHistory, original.labelPrintHistory);
  }
});

test("single-output molding retains an already issued F lot", async () => {
  const original = { ...fixture("A"), packLot: "F260914018", labelPrintedAt: "2026-09-14 09:00:00" };
  const db = database({ "wipList/A": original });
  await screen(db, "A", { qtyA: "10", qtyB: "", defectA: "", defectB: "" }).run();
  const children = db.entries().map(([, value]) => value);
  assert.equal(children.length, 1);
  assert.equal(children[0].qty, original.qty);
  assert.equal(children[0].packLot, original.packLot);
  assert.equal(children[0].labelPrintedAt, original.labelPrintedAt);
});

test("split lineage uses the document id when the stored parent has no embedded id", async () => {
  const original = { ...fixture("A"), packLot: "F260914018", labelPrintedAt: "2026-09-14 09:00:00" };
  delete original.id;
  const db = database({ "wipList/A": original });
  const view = screen(db, "A");
  await view.run();
  assert.equal(view.toasts.at(-1).type, "success");
  const children = db.entries().map(([, value]) => value);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.packagingLotLineage[0].sourceWipId, "A");
    assert.equal(child.packagingLotLineage[0].packLot, original.packLot);
  }
});

test("failed molding transaction retains the original parent and emits no process logs", async () => {
  const db = database({ "wipList/A": fixture("A") }, { failCommit: true });
  const before = db.entries(), view = screen(db, "A");
  await view.run();
  assert.deepEqual(db.entries(), before);
  assert.equal(db.commits(), 0);
  assert.equal(view.toasts.at(-1).type, "error");
  assert.equal(view.externalLogs.length, 0);
});
