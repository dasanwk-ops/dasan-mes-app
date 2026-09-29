// DOM smoke tests with synthetic data and mocked Firebase only.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const babel = require("@babel/core");
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://test.invalid/" });
global.window = dom.window; global.document = dom.window.document;
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });
global.HTMLElement = dom.window.HTMLElement; global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require("react");
const { createRoot } = require("react-dom/client");
const { act, Simulate } = require("react-dom/test-utils");
let reads = 0, unsubscribed = 0, auditListener, auditError, transactionCalls = 0, writes = [];
let live, audit = {}, seq = 0;
const firebase = {
  doc: col => ({ id: `synthetic-${++seq}`, path: `${col}/synthetic-${seq}` }),
  onSnapshot: (_col, success, error) => { reads++; auditListener = success; auditError = error; success({ docs: [] }); return () => { unsubscribed++; }; },
  serverTimestamp: () => "synthetic-server-time",
  runTransaction: async (_db, callback) => {
    transactionCalls++;
    const pending = [];
    const result = await callback({
      get: async ref => {
        const data = String(ref.path || ref).startsWith("wipList/") ? live : audit[ref.id];
        return { exists: () => !!data, data: () => structuredClone(data) };
      },
      update: (ref, value) => pending.push(["update", ref, value]),
      set: (ref, value) => pending.push(["set", ref, value])
    });
    pending.forEach(([op, ref, value]) => {
      if (op === "update") live = { ...live, ...value };
      else audit[ref.id] = structuredClone(value);
      writes.push(op);
    });
    auditListener({ docs: Object.entries(audit).map(([id, value]) => ({ id, data: () => value })) });
    return result;
  }
};
const cache = new Map();
function load(file) {
  const full = path.resolve(__dirname, "../src", file);
  if (cache.has(full)) return cache.get(full).exports;
  const m = new Module(full, module); cache.set(full, m); m.filename = full; m.paths = module.paths;
  m.require = id => id === "firebase/firestore" ? firebase :
    id === "./finishedGoodsMaster" ? load("finishedGoodsMaster.js") : require(id);
  const { code } = babel.transformSync(fs.readFileSync(full, "utf8"), {
    filename: full, babelrc: false, configFile: false,
    presets: [require.resolve("@babel/preset-react")],
    plugins: [require.resolve("@babel/plugin-transform-modules-commonjs")]
  });
  m._compile(code, full);
  return m.exports;
}
const Finished = load("FinishedGoodsMaster.jsx").default;
const fixture = {
  id: "ui-fixture", packLot: "F260928001", mixLot: "MIX-260907-696-B", currentStep: "done",
  type: "345 B1", height: "30", qty: 56, packagedAt: "2026-09-28 10:00:00", labelPrintedQty: 56,
  details: "original production record"
};
live = structuredClone(fixture);
const shipped = { id: "old", sourceWipId: "old-wip", packLot: "F260901001", productionLot: "MIX-old",
  type: "345 B1", height: "30", qty: 10, stockBeforeQty: 10, remainingQty: 0, date: "2026-09-02 10:00", operator: "Tester" };
let props = {
  wipList: [fixture, { id: "not-finished", currentStep: "step3", qty: 1000, mixLot: "MIX-progress" }],
  shippingHistory: [shipped], isAdmin: false, actorUid: "synthetic-user", db: {},
  getColRef: col => col, getDocRef: (col, id) => `${col}/${id}`,
  ctx: { showToast: () => {} }, getKST: () => "2026-09-29 15:00:00",
  getPackagingLot: item => item?.packLot || item?.lot || "",
  getTraceMixLot: item => item?.mixLot || item?.productionLot || "",
  getProductLabel: value => value
};
const root = createRoot(document.getElementById("root"));
const render = async changes => { props = { ...props, ...changes }; await act(async () => { root.render(React.createElement(Finished, props)); }); };
const click = async element => { assert.ok(element); await act(async () => element.click()); };
const change = async (element, value) => { assert.ok(element); await act(async () => Simulate.change(element, { target: { value } })); };
const lotRow = lot => document.querySelector(`[data-testid="finished-lot-${lot}"]`);
const editButton = () => [...lotRow("F260928001").querySelectorAll("button")].find(b => b.textContent === "수량 정정");
const closeDialog = () => document.querySelector('[role="dialog"] button[aria-label="닫기"]');
(async () => {
  await render({});
  assert.equal(document.querySelector("[data-testid='finished-goods-master']"), null); assert.equal(reads, 0);
  console.log("PASS UI worker mode has no master panel or ledger subscription");

  await render({ isAdmin: true });
  assert.ok(lotRow("F260928001")); assert.equal(lotRow("F260901001"), null);
  assert.equal(document.body.textContent.includes("MIX-progress"), false);
  assert.equal(editButton().disabled, false); assert.equal(transactionCalls, 0);
  console.log("PASS UI shows same 56 finished stock without mount-time writes");

  await change(document.querySelector('input[aria-label="완제품 LOT 또는 제품 검색"]'), "not-present");
  assert.equal(lotRow("F260928001"), null);
  await change(document.querySelector('input[aria-label="완제품 LOT 또는 제품 검색"]'), "mix-260907");
  assert.ok(lotRow("F260928001"));
  await change(document.querySelector('input[aria-label="완제품 LOT 또는 제품 검색"]'), "");
  await click(document.querySelector('input[type="checkbox"]'));
  assert.ok(lotRow("F260901001")); assert.equal(lotRow("F260901001").querySelector("button").disabled, true);
  console.log("PASS UI LOT search and zero-stock history filter");

  await click(editButton());
  assert.ok(document.querySelector('[role="dialog"]'));
  await click(closeDialog()); assert.equal(transactionCalls, 0);
  console.log("PASS UI cancel makes no database writes");

  await click(editButton());
  await change(document.querySelector('[role="dialog"] input[type="number"]'), "57");
  await change(document.querySelector('[role="dialog"] textarea'), "Physical count checked");
  await change(document.querySelector('[role="dialog"] input:not([type="number"])'), "Tester");
  assert.ok(document.querySelector('[role="dialog"]').textContent.includes("+1개"));
  await act(async () => Simulate.submit(document.querySelector('[role="dialog"] form')));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(live.qty, 57); assert.equal(live.labelPrintedQty, 56);
  assert.equal(live.details, fixture.details); assert.deepEqual(writes, ["update", "set"]);
  await render({ wipList: [live] });
  assert.ok(lotRow("F260928001").textContent.includes("57"));
  console.log("PASS UI 56 -> 57 saves one stock update and one audit, no label/process changes");

  await click([...lotRow("F260928001").querySelectorAll("button")].find(b => b.textContent.includes("이력")));
  assert.ok(document.querySelector('[role="dialog"]').textContent.includes("Physical count checked"));
  assert.ok(document.querySelector('[role="dialog"]').textContent.includes("Tester"));
  await click(closeDialog());
  console.log("PASS UI history shows correction reason and operator");

  await click(editButton());
  live = { ...live, qty: 55 };
  await render({ wipList: [live] });
  assert.equal(document.querySelector('[role="dialog"] button[type="submit"]').disabled, true);
  assert.ok(document.querySelector('[role="dialog"]').textContent.includes("재고가 변경"));
  await click(closeDialog());
  assert.equal(transactionCalls, 1);
  console.log("PASS UI blocks stale edit after concurrent stock change");

  await act(async () => auditError(new Error("synthetic permission error")));
  assert.equal(editButton().disabled, true);
  assert.ok(document.querySelector('[role="alert"]'));
  console.log("PASS UI history read errors disable correction and show an error");

  await act(async () => root.unmount()); assert.equal(unsubscribed, 1);
  console.log("PASS UI ledger listener is cleaned up on unmount");
  dom.window.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
