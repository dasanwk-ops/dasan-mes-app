// Synthetic fixtures execute the real handlers; no Firebase client or network is used.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../src/App.js"), "utf8");
const handlerBlock = (component, firstHandler) => {
  const componentStart = source.indexOf(`function ${component}(`);
  assert.ok(componentStart >= 0, `missing component ${component}`);
  const begin = source.indexOf(`  const ${firstHandler} =`, componentStart);
  const end = source.indexOf("\n  return (", begin);
  assert.ok(begin > componentStart && end > begin, `missing handler body ${firstHandler}`);
  return source.slice(begin, end);
};
const inspectionHandlers = handlerBlock("Step6Inspection", "moveNext");
const dryingHandlers = handlerBlock("Step7Drying", "handleRoomConfig");
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const reference = (collection, id) => ({ path: `${collection}/${id}`, id });
const object = value => value && typeof value === "object" && !Array.isArray(value);
const deepMerge = (oldValue, patch) => {
  const result = { ...(oldValue || {}) };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = object(value) && Object.keys(value).length ? deepMerge(result[key], value) : clone(value);
  }
  return result;
};

function database(records) {
  const docs = new Map(Object.entries(clone(records)));
  const versions = new Map();
  let rejectCommit = false, beforeCommit = null, retries = 0;
  const commits = [];
  const read = key => clone(docs.get(key));
  const write = (key, value) => {
    docs.set(key, clone(value));
    versions.set(key, (versions.get(key) || 0) + 1);
  };
  const remove = key => { docs.delete(key); versions.set(key, (versions.get(key) || 0) + 1); };
  const apply = operations => {
    if (rejectCommit) throw new Error("Simulated atomic commit failure");
    for (const operation of operations) {
      if (operation.kind === "update" && !docs.has(operation.reference.path)) throw new Error("Update target does not exist");
    }
    for (const { kind, reference: ref, data, merge } of operations) {
      if (kind === "delete") remove(ref.path);
      else write(ref.path, kind === "update" ? { ...read(ref.path), ...data } : merge ? deepMerge(read(ref.path), data) : data);
    }
    commits.push(clone(operations));
  };
  const db = {
    read, write, remove, commits, retries: () => retries,
    rejectCommit: value => { rejectCommit = value; },
    beforeCommit: callback => { beforeCommit = callback; },
    snapshot: () => clone(Object.fromEntries(docs)),
    async setDoc(ref, data, options) { apply([{ kind: "set", reference: ref, data: clone(data), merge: !!options?.merge }]); },
    async runTransaction(_db, callback) {
      for (let attempt = 0; attempt < 20; attempt++) {
        const reads = new Map(), writes = [];
        const result = await callback({
          get: async ref => {
            assert.equal(writes.length, 0, "Firestore requires every transaction read before writes");
            const data = read(ref.path);
            reads.set(ref.path, versions.get(ref.path) || 0);
            return { exists: () => data !== undefined, data: () => clone(data), ref };
          },
          set: (ref, data, options) => writes.push({ kind: "set", reference: ref, data: clone(data), merge: !!options?.merge }),
          update: (ref, data) => writes.push({ kind: "update", reference: ref, data: clone(data) }),
          delete: ref => writes.push({ kind: "delete", reference: ref })
        });
        if (beforeCommit) { const callback = beforeCommit; beforeCommit = null; callback(db); }
        if ([...reads].some(([key, version]) => version !== (versions.get(key) || 0))) { retries++; continue; }
        apply(writes);
        return result;
      }
      throw new Error("Too many transaction retries");
    }
  };
  return db;
}

const wip = (stage = "step6", extra = {}) => ({
  id: "A", currentStep: stage, qty: 10, type: "345 BL3", height: "25",
  mixLot: "MIX-260901-123-A", productionLot: "MIX-260901-123", sourceLot: "POWDER-123",
  details: "기존 공정 이력", heatTreatmentHistory: [{ completedAt: "2026-09-14 18:00:00", furnaceId: "F1" }],
  shrinkageStatus: "measured", shrinkageRate: "19.5", extension: { preserve: "unknown future field" },
  ...extra
});
const room = (extra = {}) => ({
  temp: "60", humidity: "20", operator: "건조담당", completionData: {
    A: { defects: "2", reason: "미세균열", specialNote: "현장기록" },
    B: { defects: "1", reason: "다른 로트", specialNote: "보존" }
  }, extension: { calibration: "keep" }, ...extra
});
const records = (stage, wipExtra = {}, roomExtra = {}) => ({
  "wipList/A": wip(stage, wipExtra), "equipment/dryingRoom": room(roomExtra)
});
const defaultForm = { operator: "검수담당", defects: "2", defectReason: "외관", preMachiningOuterDia: "100.2", prodH: "25" };

function screen(db, { form = defaultForm, list, roomSnapshot } = {}) {
  const toasts = [], logs = [];
  const context = vm.createContext({
    console: { ...console, error: () => {} }, db, Date,
    wipList: clone(list || [db.read("wipList/A")]),
    room: clone(roomSnapshot || db.read("equipment/dryingRoom")),
    formData: { A: clone(form) }, getDocRef: reference,
    getKST: () => "2026-10-14 10:00:00", getFirestore: () => db,
    setDoc: db.setDoc, runTransaction: db.runTransaction,
    ctx: { showToast: (message, type) => toasts.push({ message, type }) },
    logProcessToGoogleSheet: (...args) => logs.push(clone(args))
  });
  vm.runInContext(inspectionHandlers + dryingHandlers + `
    this.inspect = moveNext; this.start = handleStartDrying; this.complete = handleCompleteItem;
    this.config = handleRoomConfig; this.input = handleCompData;`, context);
  return {
    inspect: () => context.inspect("A"), start: () => context.start("A"), complete: (id = "A") => context.complete(id),
    config: (field, value) => context.config(field, value), input: (field, value) => context.input("A", field, value),
    toasts, logs
  };
}

function expectRejected(db, h, before) {
  assert.deepEqual(db.snapshot(), before, "rejected operation must preserve every document");
  assert.equal(db.commits.length, 0, "rejected operation must not commit writes");
  assert.equal(h.logs.length, 0, "rejected operation must not emit a successful process log");
  assert.ok(h.toasts.some(t => t.type === "error"), "operator must see an actionable error");
  assert.ok(!h.toasts.some(t => t.type === "success"));
}

for (const [identity, fields] of [["unassigned legacy WIP", {}], ["existing F LOT", {
  packLot: "F260914018", labelPrintedPackLot: "F260914018", labelPrintHistory: [{ jobId: "old", lotNumber: "F260914018" }]
}]]) {
  test(`inspection preserves latest trace, history and ${identity}`, async () => {
    const db = database(records("step6", fields)), h = screen(db);
    const latest = { ...db.read("wipList/A"), details: "새로운 현장 이력", heatTreatmentHistory: [{ completedAt: "2026-09-14 18:00:00", confirmation: "latest" }], customAudit: ["preserve"] };
    db.write("wipList/A", latest);
    await h.inspect();
    const saved = db.read("wipList/A");
    assert.equal(saved.currentStep, "step7"); assert.equal(saved.qty, 8);
    assert.ok(saved.details.startsWith(latest.details));
    for (const key of Object.keys(latest).filter(key => !["qty", "currentStep", "details"].includes(key))) assert.deepEqual(saved[key], latest[key], key);
    assert.equal(saved.preMachiningDimensions.outerDia, "100.2");
    assert.equal(h.logs.length, 1); assert.equal(h.logs[0][1].qty, 8);
    assert.deepEqual(h.logs[0][1].customAudit, latest.customAudit);
    assert.equal(db.commits.length, 1);
    assert.equal(db.read("equipment/dryingRoom").completionData.A.defects, "2");
  });
}

test("inspection rejects stale quantity, stale process and deleted WIP without resurrection", async () => {
  for (const mutation of [d => d.write("wipList/A", wip("step6", { qty: 9 })), d => d.write("wipList/A", wip("step8")), d => d.remove("wipList/A")]) {
    const db = database(records("step6")), h = screen(db); mutation(db);
    const before = db.snapshot(); await h.inspect(); expectRejected(db, h, before);
  }
});

test("inspection rejects negative, fractional, malformed and excessive defects", async () => {
  for (const defects of ["-1", "1.5", "abc", "11", "Infinity"]) {
    const db = database(records("step6")), h = screen(db, { form: { ...defaultForm, defects } });
    const before = db.snapshot(); await h.inspect(); expectRejected(db, h, before);
  }
});

test("inspection accepts blank defects as zero and whole-lot defects without inventing quantity", async () => {
  for (const [defects, expected] of [["", 10], ["10", 0]]) {
    const db = database(records("step6")), h = screen(db, { form: { ...defaultForm, defects } });
    await h.inspect(); assert.equal(db.read("wipList/A").qty, expected); assert.equal(h.logs.length, 1);
  }
});

test("inspection commit failure preserves all data and emits no success log", async () => {
  const db = database(records("step6")), h = screen(db), before = db.snapshot();
  db.rejectCommit(true); await h.inspect(); expectRejected(db, h, before);
});

test("two inspection completions cannot deduct the same defects twice", async () => {
  const db = database(records("step6")), a = screen(db), b = screen(db);
  await Promise.all([a.inspect(), b.inspect()]);
  assert.equal(db.read("wipList/A").qty, 8); assert.equal(db.commits.length, 1);
  assert.equal(a.logs.length + b.logs.length, 1); assert.ok(db.retries() > 0);
  assert.equal([...a.toasts, ...b.toasts].filter(t => t.type === "error").length, 1);
});

test("drying start changes only the process and preserves fresh LOT and history fields", async () => {
  const db = database(records("step7")), h = screen(db);
  const latest = { ...db.read("wipList/A"), packLot: "F260914018", details: "fresh history", labelPrintHistory: [{ lotNumber: "F260914018" }] };
  db.write("wipList/A", latest); await h.start();
  assert.deepEqual(db.read("wipList/A"), { ...latest, currentStep: "step7_drying" });
  assert.equal(db.commits.length, 1);
});

test("drying start rejects progressed or deleted WIP", async () => {
  for (const mutation of [d => d.write("wipList/A", wip("step8")), d => d.remove("wipList/A")]) {
    const db = database(records("step7")), h = screen(db); mutation(db);
    const before = db.snapshot(); await h.start(); expectRejected(db, h, before);
  }
});

test("drying start commit failure keeps the WIP waiting", async () => {
  const db = database(records("step7")), h = screen(db), before = db.snapshot();
  db.rejectCommit(true); await h.start(); expectRejected(db, h, before);
});

test("room configuration edits preserve newer operators, other fields and completion inputs", async () => {
  const db = database(records("step7_drying")), h = screen(db);
  const latest = room({ operator: "다른 작업자", humidity: "30", completionData: { A: { defects: "4" }, C: { specialNote: "new" } }, anotherField: "preserve" });
  db.write("equipment/dryingRoom", latest); await h.config("temp", "65");
  assert.deepEqual(db.read("equipment/dryingRoom"), { ...latest, temp: "65" });
  assert.deepEqual(db.read("wipList/A"), wip("step7_drying"));
});

test("drying input edits merge a single field and retain newer inputs for this and other lots", async () => {
  const db = database(records("step7_drying")), h = screen(db);
  const latest = room({ operator: "최신 담당", completionData: { A: { defects: "4", reason: "fresh reason", specialNote: "fresh note" }, C: { specialNote: "new other lot" } } });
  db.write("equipment/dryingRoom", latest); await h.input("defects", "3");
  assert.deepEqual(db.read("equipment/dryingRoom"), deepMerge(latest, { completionData: { A: { defects: "3" } } }));
  assert.deepEqual(db.read("wipList/A"), wip("step7_drying"));
});

test("late drying input cannot recreate completion data after the WIP advances or is deleted", async () => {
  for (const mutation of [d => d.write("wipList/A", wip("step8")), d => d.remove("wipList/A")]) {
    const db = database(records("step7_drying")), h = screen(db); mutation(db);
    const latest = room(); delete latest.completionData.A; db.write("equipment/dryingRoom", latest);
    const before = db.snapshot(); await h.input("specialNote", "late edit"); expectRejected(db, h, before);
  }
});

for (const [identity, fields] of [["unassigned legacy WIP", {}], ["existing F LOT", {
  packLot: "F260914018", labelPrintJobId: "old-job", labelPrintedAt: "2026-09-14 19:00:00", labelPrintHistory: [{ lotNumber: "F260914018" }]
}]]) {
  test(`drying completion atomically preserves ${identity}, fresh history and other lot inputs`, async () => {
    const db = database(records("step7_drying", fields)), h = screen(db);
    const latestWip = { ...db.read("wipList/A"), details: "fresh trace", customAudit: ["latest"] };
    const latestRoom = room(); latestRoom.completionData.B.specialNote = "다른 담당자의 최신 입력"; latestRoom.completionData.C = { defects: "4" };
    db.write("wipList/A", latestWip); db.write("equipment/dryingRoom", latestRoom);
    await h.complete();
    const saved = db.read("wipList/A"), savedRoom = db.read("equipment/dryingRoom");
    assert.equal(saved.currentStep, "step8"); assert.equal(saved.qty, 8); assert.ok(saved.details.startsWith("fresh trace"));
    for (const key of Object.keys(latestWip).filter(key => !["qty", "currentStep", "details"].includes(key))) assert.deepEqual(saved[key], latestWip[key], key);
    delete latestRoom.completionData.A; assert.deepEqual(savedRoom, latestRoom);
    assert.equal(db.commits.length, 1, "WIP advance and input removal must commit together");
    assert.equal(db.commits[0].length, 2);
    assert.equal(h.logs.length, 1); assert.deepEqual(h.logs[0][1].customAudit, ["latest"]);
    if (!fields.packLot) assert.equal(saved.packLot, undefined, "unassigned WIP receives its final LOT at first print, not drying");
  });
}

test("drying completion rejects another operator's changed defect quantity, reason or note", async () => {
  for (const field of ["defects", "reason", "specialNote"]) {
    const db = database(records("step7_drying")), h = screen(db), latest = room();
    latest.completionData.A[field] = field === "defects" ? "3" : "changed"; db.write("equipment/dryingRoom", latest);
    const before = db.snapshot(); await h.complete(); expectRejected(db, h, before);
  }
});

test("drying completion rejects changed room temperature, humidity or operator", async () => {
  for (const field of ["temp", "humidity", "operator"]) {
    const db = database(records("step7_drying")), h = screen(db), latest = room({ [field]: "changed" });
    db.write("equipment/dryingRoom", latest);
    const before = db.snapshot(); await h.complete(); expectRejected(db, h, before);
  }
});

test("drying completion rejects stale quantity, changed process and deleted WIP", async () => {
  for (const mutation of [d => d.write("wipList/A", wip("step7_drying", { qty: 9 })), d => d.write("wipList/A", wip("step8")), d => d.remove("wipList/A")]) {
    const db = database(records("step7_drying")), h = screen(db); mutation(db);
    const before = db.snapshot(); await h.complete(); expectRejected(db, h, before);
  }
});

test("drying completion rejects negative, fractional, malformed and excessive defects", async () => {
  for (const defects of ["-1", "1.5", "abc", "11", "Infinity"]) {
    const db = database(records("step7_drying", {}, { completionData: { A: { defects } } })), h = screen(db);
    const before = db.snapshot(); await h.complete(); expectRejected(db, h, before);
  }
});

test("drying completion failure preserves WIP, every completion input and external log count", async () => {
  const db = database(records("step7_drying")), h = screen(db), before = db.snapshot();
  db.rejectCommit(true); await h.complete(); expectRejected(db, h, before);
});

test("duplicate drying completion commits once and never deducts defects twice", async () => {
  const db = database(records("step7_drying")), a = screen(db), b = screen(db);
  await Promise.all([a.complete(), b.complete()]);
  assert.equal(db.read("wipList/A").qty, 8); assert.equal(db.commits.length, 1);
  assert.equal(a.logs.length + b.logs.length, 1); assert.ok(db.retries() > 0);
  assert.equal(db.read("equipment/dryingRoom").completionData.A, undefined);
  assert.deepEqual(db.read("equipment/dryingRoom").completionData.B, room().completionData.B);
});

test("drying completion retries a concurrent unrelated lot edit and retains that edit", async () => {
  const db = database(records("step7_drying")), h = screen(db);
  db.beforeCommit(d => {
    const latest = d.read("equipment/dryingRoom"); latest.completionData.B.defects = "6"; latest.completionData.C = { specialNote: "concurrent" };
    d.write("equipment/dryingRoom", latest);
  });
  await h.complete();
  assert.equal(db.read("wipList/A").currentStep, "step8"); assert.equal(db.read("wipList/A").qty, 8);
  assert.equal(db.read("equipment/dryingRoom").completionData.A, undefined);
  assert.equal(db.read("equipment/dryingRoom").completionData.B.defects, "6");
  assert.deepEqual(db.read("equipment/dryingRoom").completionData.C, { specialNote: "concurrent" });
  assert.equal(db.retries(), 1); assert.equal(db.commits.length, 1); assert.equal(h.logs.length, 1);
});

test("two different lots can complete concurrently without losing either quantity, history or another lot's input", async () => {
  const initial = records("step7_drying");
  initial["wipList/B"] = wip("step7_drying", { id: "B", qty: 20, mixLot: "MIX-260901-456-B", details: "B history" });
  initial["equipment/dryingRoom"].completionData.C = { defects: "5", specialNote: "still drying" };
  const db = database(initial), list = [db.read("wipList/A"), db.read("wipList/B")];
  const a = screen(db, { list }), b = screen(db, { list });
  await Promise.all([a.complete("A"), b.complete("B")]);
  assert.equal(db.read("wipList/A").qty, 8); assert.equal(db.read("wipList/A").currentStep, "step8");
  assert.equal(db.read("wipList/B").qty, 19); assert.equal(db.read("wipList/B").currentStep, "step8");
  assert.ok(db.read("wipList/B").details.startsWith("B history"));
  assert.deepEqual(db.read("equipment/dryingRoom").completionData, { C: { defects: "5", specialNote: "still drying" } });
  assert.equal(db.commits.length, 2); assert.equal(a.logs.length + b.logs.length, 2); assert.ok(db.retries() > 0);
});

test("an input racing with completion either remains pending or is rejected, never disappears silently", async () => {
  for (const inputFirst of [true, false]) {
    const db = database(records("step7_drying")), inputScreen = screen(db), completeScreen = screen(db);
    const input = () => inputScreen.input("specialNote", "concurrent note");
    const complete = () => completeScreen.complete();
    await Promise.all(inputFirst ? [input(), complete()] : [complete(), input()]);
    const saved = db.read("wipList/A"), savedInput = db.read("equipment/dryingRoom").completionData.A;
    assert.equal(db.commits.length, 1, "the conflict must stop one operation rather than silently discard input");
    if (saved.currentStep === "step8") {
      assert.equal(savedInput, undefined); assert.equal(saved.qty, 8);
      assert.ok(inputScreen.toasts.some(t => t.type === "error")); assert.equal(completeScreen.logs.length, 1);
    } else {
      assert.equal(saved.currentStep, "step7_drying"); assert.equal(saved.qty, 10);
      assert.equal(savedInput.specialNote, "concurrent note");
      assert.ok(completeScreen.toasts.some(t => t.type === "error")); assert.equal(completeScreen.logs.length, 0);
    }
    assert.deepEqual(db.read("equipment/dryingRoom").completionData.B, room().completionData.B);
  }
});
