// Synthetic execution of real process/admin handlers; never connects to Firebase.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/App.js"), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const ref = (collection, id) => ({ path: `${collection}/${id}`, id });
function section(start, end, from = 0) {
  const a = source.indexOf(start, from), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing source handler ${start}`);
  return source.slice(a, b);
}
const outboundCode = section("  const handleOutboundLot =", "\n  return (");
const mixingCode = section("  const handleCompleteMix =", "\n  return (");
const moldingCode = section("  const moveNext =", "\n  return (", source.indexOf("function Step3FirstMolding("));
const stepsCode = section("  const WIP_STEPS =", "  const handleSyncGoogleSheet =");
const saveCode = section("  const handleSaveWip =", "  const handleDeleteWip =");
const deleteCode = section("  const handleDeleteWip =", "  const handleSaveInv =");
const fixture = (currentStep = "step1") => ({
  id: "A", currentStep, mixLot: "MIX-261010-123", qty: 10, singleWeight: 650,
  type: "345 BL3", height: "25", weight: "6.500", details: "Original trace history",
  orderId: "ORDER-1", materials: [{ lot: "RAW-OLD", kg: 1 }]
});

function database(records, { failCommit = false } = {}) {
  const docs = new Map(Object.entries(clone(records)));
  let commits = 0;
  return {
    read: key => docs.has(key) ? clone(docs.get(key)) : undefined,
    write: (key, value) => docs.set(key, clone(value)),
    remove: key => docs.delete(key),
    all: () => clone([...docs]),
    commits: () => commits,
    runTransaction: async (_db, callback) => {
      const changes = [];
      const result = await callback({
        get: async reference => {
          assert.equal(changes.length, 0, "All reads must precede writes");
          const value = docs.get(reference.path);
          return { exists: () => value !== undefined, data: () => clone(value), ref: reference };
        },
        update: (reference, value) => changes.push({ reference, value: clone(value), merge: true }),
        set: (reference, value) => changes.push({ reference, value: clone(value) }),
        delete: reference => changes.push({ reference, remove: true })
      });
      if (failCommit) throw new Error("Simulated commit failure");
      for (const change of changes) {
        if (change.remove) docs.delete(change.reference.path);
        else docs.set(change.reference.path, change.merge ? { ...docs.get(change.reference.path), ...change.value } : change.value);
      }
      commits++;
      return result;
    }
  };
}

function screen(db, kind, { form = {}, edit = {} } = {}) {
  const original = db.read("wipList/A");
  const toasts = [], logs = [], confirmations = [];
  const noop = () => {};
  const context = vm.createContext({
    Date, db, console: { error: noop }, runTransaction: db.runTransaction, getDocRef: ref,
    getKST: () => "2026-10-14 18:00:00", serverTimestamp: () => "SERVER_TIME",
    wipList: [original], operators: { A: "tester" }, calcPartialBOM: () => ({ powder: 6.5 }),
    getExperimentalLabel: () => "experimental", getPowderWeightKg: (_wip, qty) => qty * 0.65,
    masterSettings: {}, getSeriesPressure: () => "250", calcAvg: () => "0.00",
    formData: { A: { operator: "tester", ...form } }, editData: { ...original, ...edit },
    activeJob: original, activeMaterials: ["powder"], selectedLots: { powder: "P" },
    operator: "tester", specialNote: "", isShortageMode: false, actualMixedTotalKg: 6.5,
    origTotalWeight: Number(original.weight), actualQty: original.qty, shortageQty: 0, ratios: { powder: 1 },
    inventory: db.read("inventory/P") ? [db.read("inventory/P")] : [],
    setOperator: noop, setSpecialNote: noop, setIsShortageMode: noop, setCompletedBatches: noop,
    setResidualGrams: noop, setSelectedLots: noop, setEditingId: noop, setEditData: noop,
    logProcessToGoogleSheet: (...args) => logs.push(clone(args)),
    ctx: { showToast: (message, type) => toasts.push({ message, type }),
      showConfirm: (_message, callback) => confirmations.push(callback) }
  });
  const handlers = {
    outbound: [outboundCode, "handleOutboundLot", original],
    mixing: [mixingCode, "handleCompleteMix", undefined],
    molding: [moldingCode, "moveNext", "A"],
    save: [stepsCode + saveCode, "handleSaveWip", original],
    remove: [deleteCode, "handleDeleteWip", "A"]
  };
  const [code, name, argument] = handlers[kind];
  vm.runInContext(code + `;this.run = ${name};`, context);
  return { run: () => context.run(argument), confirm: async () => {
    assert.equal(confirmations.length, 1, "Expected one explicit confirmation");
    await confirmations.shift()();
  }, toasts, logs };
}

for (const change of [{ currentStep: "step2" }, { currentStep: "step8", packLot: "26101425TUS501", labelPrintedAt: "printed" }, { qty: 9 }, null]) {
  test(`warehouse transfer rejects a changed or missing live WIP: ${JSON.stringify(change)}`, async () => {
    const original = fixture(), db = database({ "wipList/A": original });
    const view = screen(db, "outbound");
    if (change) db.write("wipList/A", { ...original, ...change }); else db.remove("wipList/A");
    const before = db.all();
    await view.run();
    assert.deepEqual(db.all(), before);
    assert.equal(db.commits(), 0);
    assert.equal(view.toasts.at(-1).type, "error");
    assert.equal(view.logs.length, 0);
  });
}

test("warehouse transfer preserves the current history and issued identity through a partial update", async () => {
  const original = { ...fixture(), packLot: "F260914018", labelPrintHistory: [{ jobId: "previous" }] };
  const db = database({ "wipList/A": original }), view = screen(db, "outbound");
  db.write("wipList/A", { ...original, details: "Concurrent nonstructural note", extraTrace: "keep" });
  await view.run();
  const after = db.read("wipList/A");
  assert.equal(after.currentStep, "step2");
  assert.equal(after.packLot, original.packLot);
  assert.deepEqual(after.labelPrintHistory, original.labelPrintHistory);
  assert.equal(after.extraTrace, "keep");
  assert.ok(after.details.startsWith("Concurrent nonstructural note"));
  assert.equal(view.toasts.at(-1).type, "success");
});

const powder = { id: "P", lot: "RAW-P", type: "powder", weight: 20 };
for (const change of [{ qty: 9 }, { weight: "5.850" }, { type: "234 A2" }, { includeShrinkageSpecimen: false }]) {
  test(`mixing refuses stale production input without consuming powder: ${JSON.stringify(change)}`, async () => {
    const original = fixture("step2"), db = database({ "wipList/A": original, "inventory/P": powder });
    const view = screen(db, "mixing");
    db.write("wipList/A", { ...original, ...change });
    const before = db.all();
    await view.run();
    assert.deepEqual(db.all(), before);
    assert.equal(db.commits(), 0);
    assert.equal(view.logs.length, 0);
    assert.equal(view.toasts.at(-1).type, "error");
  });
}

test("valid mixing commits powder, inventory history and WIP together while retaining trace", async () => {
  const original = fixture("step2"), db = database({ "wipList/A": original, "inventory/P": powder });
  const view = screen(db, "mixing");
  await view.run();
  assert.equal(view.toasts.at(-1).type, "success");
  assert.equal(db.read("inventory/P").weight, 13.5);
  const after = db.read("wipList/A");
  assert.equal(after.currentStep, "step3");
  assert.equal(after.qty, original.qty);
  assert.deepEqual(after.materials, original.materials);
  assert.ok(after.details.startsWith(original.details));
  assert.ok(after.details.includes(powder.lot));
  assert.equal(db.all().filter(([key]) => key.startsWith("inventoryHistory/")).length, 1);
});

test("failed mixing commit leaves inventory, WIP and history intact", async () => {
  const db = database({ "wipList/A": fixture("step2"), "inventory/P": powder }, { failCommit: true });
  const view = screen(db, "mixing"), before = db.all();
  await view.run();
  assert.deepEqual(db.all(), before);
  assert.equal(view.logs.length, 0);
  assert.equal(view.toasts.at(-1).type, "error");
});

for (const form of [{ actualQty: "10.5" }, { actualQty: "-1" }, { actualQty: "" }, { defects: "-1" }, { defects: "1.5" }, { defects: "11" }]) {
  test(`first molding refuses invalid counts ${JSON.stringify(form)}`, async () => {
    const db = database({ "wipList/A": fixture("step3") }), before = db.all();
    const view = screen(db, "molding", { form });
    await view.run();
    assert.deepEqual(db.all(), before);
    assert.equal(db.commits(), 0);
    assert.equal(view.toasts.at(-1).type, "error");
  });
}

test("first molding refuses a concurrent quantity correction", async () => {
  const original = fixture("step3"), db = database({ "wipList/A": original });
  const view = screen(db, "molding");
  db.write("wipList/A", { ...original, qty: 9 });
  const before = db.all();
  await view.run();
  assert.deepEqual(db.all(), before);
  assert.equal(view.toasts.at(-1).type, "error");
});

test("first molding retains the intentional actual-yield override and appends to live history", async () => {
  const original = fixture("step3"), db = database({ "wipList/A": original });
  const view = screen(db, "molding", { form: { actualQty: "12", defects: "1", defectReason: "crack" } });
  db.write("wipList/A", { ...original, details: "Current trace", extraTrace: "keep" });
  await view.run();
  const after = db.read("wipList/A");
  assert.equal(after.currentStep, "step4");
  assert.equal(after.qty, 11);
  assert.equal(after.extraTrace, "keep");
  assert.ok(after.details.startsWith("Current trace"));
  assert.equal(view.toasts.at(-1).type, "success");
});

for (const change of [{ qty: 9 }, { currentStep: "step7" }, { packLot: "26101425TUS501", labelPrintJobId: "new-print" }]) {
  test(`admin save cannot overwrite a concurrently changed WIP: ${JSON.stringify(change)}`, async () => {
    const original = fixture("step6"), db = database({ "wipList/A": original });
    const view = screen(db, "save");
    db.write("wipList/A", { ...original, ...change });
    const before = db.all();
    await view.run();
    assert.deepEqual(db.all(), before);
    assert.equal(db.commits(), 0);
    assert.equal(view.toasts.at(-1).type, "error");
  });
}

test("admin valid quantity correction keeps identity and existing history with an audit reason", async () => {
  const original = { ...fixture("step6"), packLot: "F260914018" }, db = database({ "wipList/A": original });
  const view = screen(db, "save", { edit: { qty: 9, correctionReason: "Recount" } });
  await view.run(); await view.confirm();
  const after = db.read("wipList/A");
  assert.equal(after.qty, 9);
  assert.equal(after.packLot, original.packLot);
  assert.ok(after.details.startsWith(original.details));
  assert.equal(after.lastQtyCorrection.reason, "Recount");
});

for (const change of [{ currentStep: "step2" }, { qty: 9 }, { packLot: "F260914018" }]) {
  test(`admin delete confirmation rechecks the live WIP: ${JSON.stringify(change)}`, async () => {
    const original = fixture(), db = database({ "wipList/A": original });
    const view = screen(db, "remove");
    await view.run();
    db.write("wipList/A", { ...original, ...change });
    const before = db.all();
    await view.confirm();
    assert.deepEqual(db.all(), before);
    assert.equal(db.commits(), 0);
    assert.equal(view.toasts.at(-1).type, "error");
  });
}

test("admin can still delete an unchanged material-waiting order after confirmation", async () => {
  const db = database({ "wipList/A": fixture() }), view = screen(db, "remove");
  await view.run();
  assert.ok(db.read("wipList/A"));
  await view.confirm();
  assert.equal(db.read("wipList/A"), undefined);
  assert.equal(view.toasts.at(-1).type, "success");
});
