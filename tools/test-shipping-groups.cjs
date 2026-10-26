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
const shipment = (id, date, qty, extra = {}) => ({ id, date, qty, type: "345 BL3", height: 25,
  packLot: `PACK-HISTORY-${id}`, productionLot: `MIX-HISTORY-${id}`, destination: "예시 출고처", operator: "예시 담당", ...extra });
const history = [
  shipment("past", "2024-06-20 12:00", 100, { sourceWipId: "shipped", remainingQty: 0 }),
  shipment("current-old", "2026-10-03 09:00", 8),
  shipment("previous-month", "2026-09-20 10:00", 9),
  shipment("invalid-day", "2026-02-30 10:00", 4),
  shipment("current-new", "2026-10-24 15:00", 12),
  shipment("previous-year", "2025-12-25 11:00", 7),
  shipment("invalid-month", "2026-13-01 10:00", 3),
  shipment("missing-date", "", 2),
];
const originalHistory = JSON.stringify(history);
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
const code = babel.transformSync(normalize + "\nconst getProductLabel = normalizeProductType;\n" + lotReaders + source.slice(start, end) + "\nthis.Screen = Step9FinishedGoods;this.historyPeriod = getShippingHistoryPeriod;this.compareGroups = compareFinishedProductGroups;", {
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
const historyRows = () => [...document.querySelectorAll('[data-testid^="shipping-history-row-"]')];
const historyIds = () => historyRows().map(row => row.getAttribute("data-testid").replace("shipping-history-row-", ""));
const historyYear = () => document.querySelector('select[aria-label="출고 연도"]');
const historyMonth = (year, month) => document.querySelector(`button[aria-label="${year}년 ${month}월 출고 이력"]`);
const historySummary = () => document.querySelector('[data-testid="shipping-history-summary"]');
(async () => {
  assert.equal(sandbox.historyPeriod("2026-10-26 12:34"), "2026-10");
  assert.equal(sandbox.historyPeriod("2024-02-29 09:00"), "2024-02");
  for (const value of ["2026-02-30 10:00", "2025-02-29", "2026-13-01", "2026-00-10", "2026-10-00", "", null, undefined]) {
    assert.equal(sandbox.historyPeriod(value), "", `invalid history date: ${value}`);
  }
  await render();
  assert.equal(rows().length, 4);
  assert.deepEqual(rows().map(row => row.querySelector("button").getAttribute("aria-label").replace(/ 로트 .*/, "")),
    ["345 BL3 25T", "345 BL3 30T", "345 B1 25T", "234 BL3 25T"]);
  assert.equal(document.querySelectorAll('[data-testid^="shipping-lot-"]').length, 0);
  assert.equal(group().querySelector('[data-testid="shipping-group-quantity"]').textContent, "84 EA");
  assert.match(group().textContent, /2개 로트/);
  assert.ok(rows().every(row => row.querySelector("button").getAttribute("aria-expanded") === "false"));
  assert.equal(historyYear().value, "2026");
  assert.equal(historyMonth(2026, 10).getAttribute("aria-pressed"), "true");
  assert.deepEqual(historyIds(), ["current-new", "current-old"]);
  assert.match(historySummary().textContent, /2\s*건/);
  assert.match(historySummary().textContent, /20\s*EA/);
  assert.ok([...historyYear().options].some(option => option.value === "2025"));
  assert.ok([...historyYear().options].some(option => option.value === "2024"));
  await click(historyMonth(2026, 9));
  assert.deepEqual(historyIds(), ["previous-month"]);
  assert.equal(historyMonth(2026, 9).getAttribute("aria-pressed"), "true");
  assert.equal(group().querySelector('[data-testid="shipping-group-quantity"]').textContent, "84 EA");
  assert.equal(lot("shipped"), null);
  await click(historyMonth(2026, 1));
  assert.deepEqual(historyIds(), []);
  assert.match(historySummary().textContent, /0\s*건/);
  await change(historyYear(), "2025");
  await click(historyMonth(2025, 12));
  assert.deepEqual(historyIds(), ["previous-year"]);
  const unknownDates = [...document.querySelectorAll("button")].find(button => /날짜 미확인/.test(button.textContent));
  assert.ok(unknownDates);
  assert.match(unknownDates.textContent, /3\s*건/);
  await click(unknownDates);
  assert.deepEqual(historyIds().sort(), ["invalid-day", "invalid-month", "missing-date"]);
  await change(historyYear(), "2026");
  await click(historyMonth(2026, 10));
  assert.deepEqual(historyIds(), ["current-new", "current-old"]);
  assert.equal(transactions, 0);
  assert.equal(writes.length, 0);
  assert.equal(logs.length, 0);
  assert.equal(JSON.stringify(history), originalHistory);
  console.log("PASS current Korean month, year/month selection, history totals/order, invalid dates, empty month, no writes, old shipped stock stays excluded");

  const priorStock = stock;
  const shades = ["BL1", "BL2", "BL3", "BL4", "B1", "A1", "A2"];
  stock = ["234", "345"].flatMap(series => [...shades].reverse().map((shade, index) => fixture(`sort-${series}-${index}`, `${series} ${shade}`, 25, 1)));
  stock.push(fixture("sort-thin", "BL1", 9, 1), fixture("sort-thick", "345 BL1", 100, 1));
  await render();
  const expectedProducts = ["345 BL1 9T", "345 BL1 25T", "345 BL1 100T", ...shades.slice(1).map(shade => `345 ${shade} 25T`), ...shades.map(shade => `234 ${shade} 25T`)];
  assert.deepEqual(rows().map(row => row.querySelector("button").getAttribute("aria-label").replace(/ 로트 .*/, "")), expectedProducts);
  assert.deepEqual(["25.5T", 100, "25.05", 9].map(height => ({ type: "345 BL1", height }))
    .sort(sandbox.compareGroups).map(item => item.height), [9, "25.05", "25.5T", 100]);
  stock = priorStock;
  await render();
  console.log("PASS all requested shades stay in 345/234 families and equal shades use numeric thickness order");

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
  const previewCounts = document.querySelector("main").textContent.match(/(\d+)개 제품 묶음,\s*(\d+)개 로트/);
  assert.ok(previewCounts, "demo describes the available sample groups and LOTs");
  assert.equal(rows().length, Number(previewCounts[1]));
  assert.equal(rows().reduce((sum, row) => sum + Number(row.querySelector("button").textContent.match(/(\d+)\s*개 로트/)[1]), 0), Number(previewCounts[2]));
  assert.equal(historyYear().value, "2026");
  assert.equal(historyMonth(2026, 10).getAttribute("aria-pressed"), "true");
  assert.equal(historyRows().length, 2);
  await click(historyMonth(2026, 9));
  assert.equal(historyRows().length, 1);
  await change(historyYear(), "2025");
  await click(historyMonth(2025, 12));
  assert.equal(historyRows().length, 1);
  await change(historyYear(), "2026");
  await click(historyMonth(2026, 10));
  const groupLotCount = Number(group().querySelector("button").textContent.match(/(\d+)\s*개 로트/)[1]);
  await click(group().querySelector("button"));
  assert.equal(document.querySelectorAll('[data-testid^="shipping-lot-"]').length, groupLotCount);
  const example = document.querySelector('[data-testid^="shipping-lot-"]');
  assert.match(example.textContent, /MIX-TEST-/);
  assert.doesNotMatch(example.textContent, /MIX LOT 확인 필요/);
  await change(example.querySelector('input[type="number"]'), "1");
  await change(example.querySelector("select"), "이엔씨");
  await change(example.querySelector('input[placeholder="담당자"]'), "예시 담당");
  await click(example.querySelector("button"));
  assert.match(document.querySelector('[role="status"]').textContent, /실제 출고가 저장되지 않습니다/);
  assert.deepEqual({ transactions, writes: writes.length, logs: logs.length }, beforePreview);
  console.log("PASS demo stock and cross-month/year history are populated and never transact or send Sheets logs, even with a valid shipment form");
  await act(async () => root.unmount());
  console.log("PASS exhausted groups disappear and empty stock remains readable");
})().catch(error => { console.error(error); process.exitCode = 1; });
