const fs = require('fs');

function replaceOnce(path, oldText, newText, label) {
  let text = fs.readFileSync(path, 'utf8');
  const first = text.indexOf(oldText);
  const last = text.lastIndexOf(oldText);
  if (first < 0) {
    if (text.includes(newText)) {
      console.log(`${label}: already applied`);
      return;
    }
    throw new Error(`${label}: target not found`);
  }
  if (first !== last) throw new Error(`${label}: target is not unique`);
  text = text.slice(0, first) + newText + text.slice(first + oldText.length);
  fs.writeFileSync(path, text, 'utf8');
  console.log(`${label}: applied`);
}

replaceOnce(
  'src/App.js',
  `  const prevSyncCount = useRef({ finished: 0, shipped: 0 });`,
  `  const prevSyncCount = useRef({ finished: 0, shipped: 0 });\n  const orderReconcileInFlightRef = useRef(false);\n  const [orderReconcileReady, setOrderReconcileReady] = useState({ wip: false, orders: false, shipping: false });`,
  'order-reconcile-state'
);

replaceOnce(
  'src/App.js',
  `    setupListener("inventory", setInventory);\n    setupListener("inventoryHistory", (d) => setInventoryHistory(d.sort((a, b) => b.id - a.id)));\n    setupListener("wipList", setWipList);\n    setupListener("orderList", (d) => setOrderList(d.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate))));\n    setupListener("shippingHistory", (d) => setShippingHistory(d.sort((a, b) => b.id - a.id)));`,
  `    setupListener("inventory", setInventory);\n    setupListener("inventoryHistory", (d) => setInventoryHistory(d.sort((a, b) => b.id - a.id)));\n    setupListener("wipList", (d) => {\n      setWipList(d);\n      setOrderReconcileReady((prev) => prev.wip ? prev : { ...prev, wip: true });\n    });\n    setupListener("orderList", (d) => {\n      setOrderList(d.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate)));\n      setOrderReconcileReady((prev) => prev.orders ? prev : { ...prev, orders: true });\n    });\n    setupListener("shippingHistory", (d) => {\n      setShippingHistory(d.sort((a, b) => b.id - a.id));\n      setOrderReconcileReady((prev) => prev.shipping ? prev : { ...prev, shipping: true });\n    });`,
  'order-reconcile-readiness'
);

const reconcileEffect = `  useEffect(() => {\n    const ready = orderReconcileReady.wip && orderReconcileReady.orders && orderReconcileReady.shipping;\n    if (!user || !isUnlocked || !ready || orderReconcileInFlightRef.current) return;\n\n    const corrections = [];\n\n    (orderList || []).forEach((order) => {\n      if (["취소", "잔량마감"].includes(order?.status)) return;\n\n      const orderId = String(order?.id || "");\n      if (!orderId) return;\n\n      const linkedWip = (wipList || []).filter((w) => String(w.orderId || "") === orderId);\n      const linkedShipping = (shippingHistory || []).filter((h) => String(h.orderId || "") === orderId);\n      if (linkedWip.length === 0 && linkedShipping.length === 0) return;\n\n      const hasActiveWip = linkedWip.some((w) => w.currentStep !== "done");\n      const historicalTerminal = ["완료", "생산완료", "출고완료"].includes(order?.status) && !hasActiveWip;\n      if (historicalTerminal) return;\n\n      const orderQty = Math.max(0, Number(order.qty) || 0);\n      const wipQty = linkedWip.reduce((sum, w) => sum + Math.max(0, Number(w.qty) || 0), 0);\n      const finishedStockQty = linkedWip\n        .filter((w) => w.currentStep === "done")\n        .reduce((sum, w) => sum + Math.max(0, Number(w.qty) || 0), 0);\n      const shippedQty = linkedShipping.reduce((sum, h) => sum + Math.max(0, Number(h.qty) || 0), 0);\n      const liveCoveredQty = wipQty + shippedQty;\n\n      let targetStatus = "대기중";\n      if (orderQty > 0 && shippedQty >= orderQty) targetStatus = "출고완료";\n      else if (orderQty > 0 && finishedStockQty + shippedQty >= orderQty) targetStatus = "생산완료";\n      else if (orderQty > 0 && liveCoveredQty >= orderQty) targetStatus = "생산중";\n      else if (liveCoveredQty > 0) targetStatus = "부분투입";\n\n      const currentReleasedQty = Math.max(0, Number(order.releasedQty) || 0);\n      const targetReleasedQty = Math.max(currentReleasedQty, Math.min(orderQty, liveCoveredQty));\n\n      if (order.status === targetStatus && currentReleasedQty === targetReleasedQty) return;\n\n      corrections.push({\n        id: orderId,\n        beforeStatus: order.status || "",\n        afterStatus: targetStatus,\n        beforeReleasedQty: currentReleasedQty,\n        afterReleasedQty: targetReleasedQty,\n        liveCoveredQty,\n      });\n    });\n\n    if (corrections.length === 0) return;\n\n    orderReconcileInFlightRef.current = true;\n    (async () => {\n      try {\n        for (const item of corrections) {\n          await setDoc(\n            getDocRef("orderList", item.id),\n            {\n              status: item.afterStatus,\n              releasedQty: item.afterReleasedQty,\n              lastOrderReconciliation: {\n                correctedAt: getKST(),\n                source: "WIP+shipping",\n                beforeStatus: item.beforeStatus,\n                afterStatus: item.afterStatus,\n                beforeReleasedQty: item.beforeReleasedQty,\n                afterReleasedQty: item.afterReleasedQty,\n                liveCoveredQty: item.liveCoveredQty,\n              },\n            },\n            { merge: true }\n          );\n        }\n        console.info("[MES] 발주 상태 정합성 보정: " + corrections.length + "건");\n      } catch (e) {\n        console.error("[MES] 발주 상태 정합성 보정 실패", e);\n      } finally {\n        orderReconcileInFlightRef.current = false;\n      }\n    })();\n  }, [\n    user,\n    isUnlocked,\n    orderList,\n    wipList,\n    shippingHistory,\n    orderReconcileReady.wip,\n    orderReconcileReady.orders,\n    orderReconcileReady.shipping,\n  ]);\n\n`;

replaceOnce(
  'src/App.js',
  `  }, [user, isUnlocked]);\n\n  if (!isUnlocked) {`,
  `  }, [user, isUnlocked]);\n\n${reconcileEffect}  if (!isUnlocked) {`,
  'insert-order-reconcile-effect'
);

replaceOnce(
  'src/App.js',
  `            qty: inputQty,\n            currentStep: "step1",\n            details: \`[\${getKST()}] 지시분할투입 (원본:\${order.orderNo})\`,\n          });\n\n          setReleaseQtyMap({ ...releaseQtyMap, [order.id]: "" });`,
  `            qty: inputQty,\n            currentStep: "step1",\n            details: \`[\${getKST()}] 지시분할투입 (원본:\${order.orderNo})\`,\n          });\n\n          const coveredAfterRelease = Math.min(\n            Math.max(0, Number(order.qty) || 0),\n            Math.max(0, Number(progress.rawCoveredQty) || 0) + inputQty\n          );\n          const releasedAfter = Math.max(\n            Math.max(0, Number(order.releasedQty) || 0),\n            coveredAfterRelease\n          );\n          await setDoc(\n            getDocRef("orderList", order.id),\n            {\n              releasedQty: releasedAfter,\n              status: coveredAfterRelease >= Math.max(0, Number(order.qty) || 0)\n                ? "생산중"\n                : "부분투입",\n              lastOrderStateUpdate: {\n                updatedAt: getKST(),\n                source: "공정투입",\n                releasedQty: releasedAfter,\n              },\n            },\n            { merge: true }\n          );\n\n          setReleaseQtyMap({ ...releaseQtyMap, [order.id]: "" });`,
  'persist-order-state-on-release'
);
