// Keep the existing guarded build-time integration convention used by this repo.
// This script changes source text only. It never connects to Firebase.
const fs = require("node:fs");
const path = require("node:path");

function applyFinishedGoodsMaster(source) {
  const marker = "{/* finished-goods-master:v1 */}";
  if (source.includes(marker)) {
    if (!source.includes('import FinishedGoodsMaster from "./FinishedGoodsMaster";') ||
        !source.includes("actorUid={user?.uid}")) {
      throw new Error("Incomplete finished goods master integration; refusing partial patch.");
    }
    return source;
  }
  const once = (from, to) => {
    if (source.split(from).length !== 2) throw new Error("Finished goods integration anchor missing or ambiguous: " + from.slice(0, 100));
    source = source.replace(from, to);
  };
  once('import React, { useState, useEffect, useRef } from "react";',
    'import React, { useState, useEffect, useRef } from "react";\nimport FinishedGoodsMaster from "./FinishedGoodsMaster";');
  once('const props = { inventory, wipList, orderList, inventoryHistory, shippingHistory, furnaces, dryingRoom, masterSettings, setActiveStep, ctx };',
    'const props = { inventory, wipList, orderList, inventoryHistory, shippingHistory, furnaces, dryingRoom, masterSettings, setActiveStep, ctx, isAdmin, user };');
  once('function DashboardView({ inventory, wipList, orderList = [], inventoryHistory, shippingHistory, furnaces, setActiveStep, ctx, masterSettings }) {',
    'function DashboardView({ inventory, wipList, orderList = [], inventoryHistory, shippingHistory, furnaces, setActiveStep, ctx, masterSettings, isAdmin, user }) {');
  const start = source.indexOf("function DashboardView(");
  const end = source.indexOf("function Step0OrderManagement(", start);
  if (start < 0 || end < 0) throw new Error("Dashboard boundaries not found.");
  const dashboard = source.slice(start, end);
  const closing = "    </div>\n  );\n}";
  const insertion = dashboard.lastIndexOf(closing);
  if (insertion < 0 || !dashboard.includes("activeWipList.map")) throw new Error("Dashboard process table anchor not found.");
  const jsx = `      ${marker}
      <FinishedGoodsMaster
        wipList={wipList} shippingHistory={shippingHistory}
        db={db} getColRef={getColRef} getDocRef={getDocRef} ctx={ctx}
        isAdmin={isAdmin} actorUid={user?.uid}
        getPackagingLot={getPackagingLot} getTraceMixLot={getTraceMixLot}
        getProductLabel={getProductLabel} getKST={getKST}
      />
`;
  return source.slice(0, start + insertion) + jsx + source.slice(start + insertion);
}

module.exports = { applyFinishedGoodsMaster };
if (require.main === module) {
  const file = path.join(__dirname, "..", "src", "App.js");
  const before = fs.readFileSync(file, "utf8");
  const after = applyFinishedGoodsMaster(before);
  if (after !== before) fs.writeFileSync(file, after);
  console.log(after === before ? "Finished goods master already integrated." : "Finished goods master integrated.");
}
