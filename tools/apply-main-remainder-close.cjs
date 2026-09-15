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
  `  // 과거 데이터 중 이미 완전히 종료됐지만 WIP/출고 이력이 남아있지 않은 건 보호\n  const legacyClosed =\n    linkedWip.length === 0 &&\n    linkedShipping.length === 0 &&\n    ["완료", "출고완료"].includes(order?.status);`,
  `  // 과거 생산완료 건은 불량/폐기 처리로 최종 WIP 수량이 0이어도 다시 생산 잔량으로 만들지 않습니다.\n  // 단, 살아있는 공정 WIP가 하나라도 있으면 완료 상태를 신뢰하지 않고 현재 WIP 기준으로 계산합니다.\n  const legacyClosedStatus = ["완료", "출고완료", "생산완료"].includes(order?.status);\n  const hasActiveLinkedWip = linkedWip.some((w) => w.currentStep !== "done");\n  const hasLegacyCloseEvidence =\n    linkedWip.length > 0 ||\n    linkedShipping.length > 0 ||\n    Math.max(0, Number(order?.releasedQty) || 0) >= orderQty;\n  const legacyClosed =\n    legacyClosedStatus &&\n    !hasActiveLinkedWip &&\n    hasLegacyCloseEvidence;`,
  'legacy-completed-order-guard'
);

replaceOnce(
  'src/App.js',
  `  const rawCoveredQty = legacyClosed ? orderQty : wipQty + shippedQty;\n  const coveredQty = Math.min(orderQty, rawCoveredQty);\n  const remainingQty = Math.max(0, orderQty - coveredQty);\n  const overQty = Math.max(0, rawCoveredQty - orderQty);\n\n  let status = "대기중";\n  if (order?.status === "취소") status = "취소";\n  else if (legacyClosed || (orderQty > 0 && shippedQty >= orderQty)) status = "출고완료";`,
  `  const remainderClosed = order?.status === "잔량마감";\n  const rawCoveredQty = (legacyClosed || remainderClosed) ? orderQty : wipQty + shippedQty;\n  const coveredQty = Math.min(orderQty, rawCoveredQty);\n  const remainingQty = Math.max(0, orderQty - coveredQty);\n  const overQty = Math.max(0, rawCoveredQty - orderQty);\n\n  let status = "대기중";\n  if (order?.status === "취소") status = "취소";\n  else if (remainderClosed) status = "잔량마감";\n  else if (legacyClosed || (orderQty > 0 && shippedQty >= orderQty)) status = "출고완료";`,
  'progress-close-status'
);

replaceOnce(
  'src/App.js',
  `  const handleReleaseToWIP = async (order) => {\n    const inputQty = parseInt(releaseQtyMap[order.id]);`,
  `  const handleReleaseToWIP = async (order) => {\n    if (["취소", "잔량마감"].includes(order?.status)) {\n      return ctx.showToast("취소 또는 잔량마감된 생산 지시는 추가 투입할 수 없습니다.", "error");\n    }\n    const inputQty = parseInt(releaseQtyMap[order.id]);`,
  'release-close-guard'
);

const closeHandler = `  const handleCloseRemainder = async (order) => {\n    const progress = getOrderProgress(order, wipList, shippingHistory);\n    if (progress.remainingQty <= 0) {\n      return ctx.showToast("남은 생산 수량이 없습니다.", "error");\n    }\n    if (progress.rawCoveredQty <= 0) {\n      return ctx.showToast("생산/출고 이력이 없는 지시는 잔량마감 대신 삭제를 사용해주세요.", "error");\n    }\n\n    const operator = String(window.prompt("잔량마감 담당자 성명을 입력해주세요.") || "").trim();\n    if (!operator) return;\n    const reason = String(window.prompt("잔량마감 사유를 입력해주세요.", "생산 단위상 잔량 미생산 마감") || "").trim();\n    if (!reason) return;\n\n    ctx.showConfirm(\n      \`\${order.orderNo}\\n지시수량: \${progress.orderQty}EA\\n현재 반영: \${progress.rawCoveredQty}EA\\n남은 수량: \${progress.remainingQty}EA\\n\\n남은 수량만 미생산 마감하고 기존 생산/출고 이력은 그대로 보관할까요?\`,\n      async () => {\n        try {\n          await runTransaction(db, async (transaction) => {\n            const orderRef = getDocRef("orderList", order.id);\n            const snap = await transaction.get(orderRef);\n            if (!snap.exists()) throw new Error("생산 지시가 존재하지 않습니다.");\n            const live = snap.data();\n            if (["취소", "잔량마감"].includes(live.status)) throw new Error("이미 취소 또는 잔량마감된 생산 지시입니다.");\n            if (Number(live.qty) !== Number(order.qty)) throw new Error("생산 지시 수량이 변경되었습니다. 화면을 확인한 뒤 다시 시도해주세요.");\n            transaction.update(orderRef, {\n              status: "잔량마감",\n              remainderClosedQty: progress.remainingQty,\n              remainderCoveredQty: progress.rawCoveredQty,\n              remainderClosedAt: getKST(),\n              remainderClosedBy: operator,\n              remainderCloseReason: reason,\n            });\n          });\n          ctx.showToast(\`잔량 \${progress.remainingQty}EA 마감 완료\`, "success");\n        } catch (e) {\n          ctx.showToast(e?.message || "잔량마감 실패", "error");\n        }\n      }\n    );\n  };\n\n`;
replaceOnce(
  'src/App.js',
  '  const handleDel = async (id) => {',
  closeHandler + '  const handleDel = async (id) => {',
  'insert-close-handler'
);

replaceOnce(
  'src/App.js',
  `  const activeOrders = orderList.filter((o) => {\n    if (o.status === "취소") return false;`,
  `  const activeOrders = orderList.filter((o) => {\n    if (["취소", "잔량마감"].includes(o.status)) return false;`,
  'hide-closed-orders'
);

replaceOnce(
  'src/App.js',
  `                      <div className="flex justify-center gap-2"><button onClick={() => handleDel(order.id)} className="text-red-300 hover:text-red-600"><Trash2 className="w-4 h-4" /></button></div>`,
  `                      <div className="flex justify-center gap-2 items-center">\n                        <button onClick={() => handleCloseRemainder(order)} className="text-[10px] px-2 py-1.5 rounded font-black bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 whitespace-nowrap">잔량마감</button>\n                        <button title="생산/출고 이력이 없는 지시 삭제" onClick={() => handleDel(order.id)} className="text-red-300 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>\n                      </div>`,
  'add-close-button'
);
