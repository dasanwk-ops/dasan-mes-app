// Exercise the real shipping screen with synthetic stock and an in-memory DB.
// No Firebase initialization, production data, or network access.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const babel = require("@babel/core");
const { JSDOM } = require("jsdom");
const dom = new JSDOM("<div id='root'></div>", { url: "https://test.invalid" });
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, "navigator", { value: dom.window.navigator, configurable: true });
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require("react");
const { createRoot } = require("react-dom/client");
const { act, Simulate } = require("react-dom/test-utils");
const source = fs.readFileSync(path.join(__dirname, "../src/App.js"), "utf8");
const normalize = source.slice(source.indexOf("const normalizeProductType ="), source.indexOf("const getProductShade ="));
const lotReaders = source.slice(source.indexOf("const getTraceMixLot ="), source.indexOf("const getProductionLot ="));
const start = source.indexOf("const getFinishedStock =");
const end = source.indexOf("function StepTracking(", start);
assert.ok(start > 0 && end > start);
const fixture = (id, type, height, qty, extra = {}) => ({ id, type, height, qty, currentStep: "done", mixLot: `MIX-${id}`, packLot: `PACK-${id}`, details: "original history", ...extra });
let stock = [fixture("a", "BL3", 25, 40), fixture("b", "345 BL3", "25", 44),
  fixture("shade", "345 B1", 25, 50), fixture("series", "234 BL3", 25, 20),
  fixture("height", "345 BL3", 30, 10), fixture("zero", "345 BL3", 25, 0),
  fixture("pending", "345 BL3", 25, 999, { currentStep: "step8" }), fixture("shipped", "345 BL3", 25, 100)];
const history = [{ id: "past", sourceWipId: "shipped", remainingQty: 0, qty: 100 }];
const original = JSON.stringify(stock);
let confirmation, transactions = 0;
const writes = [], logs = [];
const ctx = { showConfirm: (_text, callback) => { confirmation = callback; }, showToast: () => {} };
const sandbox = { React, useState: React.useState, useRef: React.useRef, console,
  Archive: () => null, Truck: () => null, History: () => null, LotLink: ({ item }) => React.createElement("span", null, item.mixLot),
  getProductLabel: null, getPackagingLot: w => w.packLot || "", getTraceMixLot: w => w.mixLot || "",
  includesShrinkageSpecimen: () => false, getKST: () => "2026-10-26 12:00:00", serverTimestamp: () => "test-time",
  db: {}, getDocRef: (collection, id) => ({ collection, id }),
  logProcessToGoogleSheet: (...args) => logs.push(args),
  runTransaction: async (_db, callback) => {
    transactions++;
    const pending = [];
    await callback({
      get: async ref => ({ exists: () => stock.some(w => w.id === ref.id), data: () => ({ ...stock.find(w => w.id === ref.id) }) }),
      update: (ref, data) => pending.push({ kind: "update", ref, data }),
      delete: ref => pending.push({ kind: "delete", ref }),
      set: (ref, data) => pending.push({ kind: "set", ref, data })
    });
    for (const op of pending) {
      if (op.kind === "update") stock = stock.map(w => w.id === op.ref.id ? { ...w, ...op.data } : w);
      if (op.kind === "delete") stock = stock.filter(w => w.id !== op.ref.id);
      writes.push(op);
    }
  }
};
vm.createContext(sandbox);
const code = babel.transformSync(normalize + "\nconst getProductLabel = normalizeProductType;\n" + lotReaders + source.slice(start, end) + "\nthis.Screen = Step9FinishedGoods;", {
  babelrc: false, configFile: false, presets: [require.resolve("@babel/preset-react")]
}).code;
vm.runInContext(code, sandbox);
const previewSource = source.slice(source.indexOf("export function ShippingGroupsPreview("), source.indexOf("const getCurrentProcessLabel ="));
vm.runInContext(babel.transformSync(previewSource.replace("export function", "function") + "\nthis.Preview = ShippingGroupsPreview;", {
  babelrc: false, configFile: false, presets: [require.resolve("@babel/preset-react")]
}).code, sandbox);

// The demo URL must bypass SDK initialization and the entire production App.
const initSource = source.slice(source.indexOf("export const isShippingGroupsPreview ="), source.indexOf("const appId ="));
const indexSource = fs.readFileSync(path.join(__dirname, "../src/index.js"), "utf8").replace(/^import .*;$/gm, "");
for (const search of ["?preview=shipping-groups", "?step=step9"]) {
  let sdkCalls = 0, rendered;
  const appStub = () => null;
  const bootstrap = { URLSearchParams, process: { env: {} }, window: { location: { search } }, document,
    initializeApp: () => { sdkCalls++; return {}; }, getAuth: () => { sdkCalls++; return {}; }, getFirestore: () => { sdkCalls++; return {}; },
    React, App: appStub, ShippingGroupsPreview: sandbox.Preview, createRoot: () => ({ render: element => { rendered = element; } }) };
  vm.createContext(bootstrap);
  vm.runInContext(initSource.replace("export const", "const") + babel.transformSync(indexSource, {
    babelrc: false, configFile: false, presets: [require.resolve("@babel/preset-react")]
  }).code, bootstrap);
  assert.equal(sdkCalls, search.includes("preview=") ? 0 : 3);
  assert.equal(rendered.type, search.includes("preview=") ? sandbox.Preview : appStub);
}
console.log("PASS demo entry skips all Firebase initialization and production App effects; ordinary entry is unchanged");
const root = createRoot(document.getElementById("root"));
const render = async () => { await act(async () => root.render(React.createElement(sandbox.Screen, { wipList: stock, shippingHistory: history, orderList: [], ctx }))); };
const rows = () => [...document.querySelectorAll('[data-testid="shipping-product-group"]')];
const group = () => rows().find(row => row.querySelector("button").getAttribute("aria-label").startsWith("345 BL3 25T"));
const lot = id => document.querySelector(`[data-testid="shipping-lot-${id}"]`);
const click = async el => { assert.ok(el); await act(async () => el.click()); };
const change = async (el, value) => { assert.ok(el); await act(async () => Simulate.change(el, { target: { value } })); };
(async () => {
  await render();
  assert.equal(rows().length, 4);
  assert.equal(document.querySelectorAll('[data-testid^="shipping-lot-"]').length, 0);
  assert.equal(group().querySelector('[data-testid="shipping-group-quantity"]').textContent, "84 EA");
  assert.match(group().textContent, /2개 로트/);
  assert.ok(rows().every(row => row.querySelector("button").getAttribute("aria-expanded") === "false"));
  await click(group().querySelector("button"));
  assert.ok(lot("a") && lot("b"));
  assert.equal(document.querySelectorAll('[data-testid^="shipping-lot-"]').length, 2);
  await change(lot("b").querySelector('input[type="number"]'), "4");
  await change(lot("b").querySelector("select"), "이엔씨");
  await change(lot("b").querySelector('input[placeholder="담당자"]'), "테스트 담당");
  await click(group().querySelector("button"));
  assert.equal(lot("b"), null);
  await click(group().querySelector("button"));
  assert.equal(lot("b").querySelector('input[type="number"]').value, "4");
  assert.equal(lot("b").querySelector("select").value, "이엔씨");
  assert.equal(lot("b").querySelector('input[placeholder="담당자"]').value, "테스트 담당");
  assert.equal(transactions, 0);
  assert.equal(JSON.stringify(stock), original);
  console.log("PASS grouped totals, legacy product normalization, distinct variants, collapsed default, input retention, no writes on toggling");
  stock = [...stock].reverse();
  await render();
  await click(lot("b").querySelector("button"));
  assert.equal(transactions, 0);
  await act(async () => confirmation());
  assert.equal(transactions, 1);
  assert.equal(stock.find(w => w.id === "a").qty, 40);
  assert.equal(stock.find(w => w.id === "b").qty, 40);
  const shipment = writes.find(op => op.kind === "set").data;
  assert.equal(shipment.sourceWipId, "b");
  assert.equal(shipment.packLot, "PACK-b");
  assert.equal(shipment.qty, 4);
  assert.equal(logs.length, 1);
  await render();
  assert.equal(group().querySelector('[data-testid="shipping-group-quantity"]').textContent, "80 EA");
  assert.equal(lot("b").querySelector('input[type="number"]').value, "");
  console.log("PASS shipping after toggling/reordering still targets only the selected LOT and updates its group total");
  stock = stock.filter(w => w.id !== "a" && w.id !== "b");
  await render();
  assert.equal(group(), undefined);
  stock = [];
  await render();
  assert.equal(rows().length, 0);
  assert.match(document.body.textContent, /대기 물량 없음/);
  const beforePreview = { transactions, writes: writes.length, logs: logs.length };
  await act(async () => root.render(React.createElement(sandbox.Preview)));
  assert.equal(rows().length, 4);
  assert.match(document.body.textContent, /10개 로트/);
  assert.equal(group().querySelector('[data-testid="shipping-group-quantity"]').textContent, "243 EA");
  await click(group().querySelector("button"));
  assert.equal(document.querySelectorAll('[data-testid^="shipping-lot-"]').length, 4);
  const example = lot("preview-0-0");
  assert.match(example.textContent, /MIX-TEST-1-1/);
  assert.doesNotMatch(example.textContent, /MIX LOT 확인 필요/);
  await change(example.querySelector('input[type="number"]'), "1");
  await change(example.querySelector("select"), "이엔씨");
  await change(example.querySelector('input[placeholder="담당자"]'), "예시 담당");
  await click(example.querySelector("button"));
  assert.match(document.querySelector('[role="status"]').textContent, /실제 출고가 저장되지 않습니다/);
  assert.deepEqual({ transactions, writes: writes.length, logs: logs.length }, beforePreview);
  console.log("PASS demo has four groups/ten LOTs and never transacts or sends Sheets logs, even with a valid shipment form");
  await act(async () => root.unmount());
  console.log("PASS exhausted groups disappear and empty stock remains readable");
})().catch(error => { console.error(error); process.exitCode = 1; });
