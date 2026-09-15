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
  'src/mesOperations.mjs',
  "      const r=ref('orderList',order.id),os=await tx.get(r);assertSame(os.data(),order,'생산 지시');invariant(os.data().status!=='취소','취소된 생산 지시입니다.');",
  "      const r=ref('orderList',order.id),os=await tx.get(r);const liveOrder=os.data();assertSame(liveOrder,order,'생산 지시');invariant(!['취소','잔량마감'].includes(liveOrder.status),'취소 또는 잔량마감된 생산 지시입니다.');",
  'release-close-guard'
);

const closeFn = `  async function closeOrderRemainder(expected,{operator,reason}) {\n    requiredText(operator,'마감 담당자');requiredText(reason,'마감 사유');\n    return transact('생산 지시 잔량 마감',operator,async tx=>{\n      const r=ref('orderList',expected.id),s=await tx.get(r),live=s.data();assertSame(live,expected,'생산 지시');\n      invariant(!['취소','잔량마감'].includes(live.status),'이미 취소 또는 잔량마감된 생산 지시입니다.');\n      const ws=await tx.list(col('wipList')),hs=await tx.list(col('shippingHistory'));\n      const linked=[...ws,...hs].map(x=>x.data()).filter(x=>String(x.orderId||'')===String(expected.id));\n      invariant(linked.length>0,'생산/출고 이력이 없는 지시는 잔량마감 대신 취소를 사용하세요.');\n      const covered=linked.reduce((n,x)=>n+Math.max(0,Number(x.qty)||0),0);\n      const total=quantity(live.qty,'지시 수량',false),remainder=Math.max(0,total-covered);\n      invariant(remainder>0,'현재 남은 생산 수량이 없습니다.');\n      tx.annotate({kind:'order-remainder-close',orderId:expected.id,orderNo:live.orderNo||'',totalQty:total,coveredQty:covered,remainderQty:remainder,operator,reason});\n      tx.update(r,{status:'잔량마감',remainderClosedQty:remainder,remainderCoveredQty:covered,remainderClosedAt:kst(),remainderClosedBy:operator,remainderCloseReason:reason});\n      return {total,covered,remainder};\n    });\n  }\n`;

replaceOnce(
  'src/mesOperations.mjs',
  "  async function cancelOrder(expected) {\n",
  closeFn + "  async function cancelOrder(expected) {\n",
  'insert-close-operation'
);

replaceOnce(
  'src/mesOperations.mjs',
  "return { finishShrink,advance,firstMolding,splitMolding,allocateSlot,furnaceField,startHeat,finishHeat,roomField,dryStart,dryField,dryComplete,ensurePack,cancelOrEdit,ship,release,cancelOrder,inbound,requestPrint,finishPack };",
  "return { finishShrink,advance,firstMolding,splitMolding,allocateSlot,furnaceField,startHeat,finishHeat,roomField,dryStart,dryField,dryComplete,ensurePack,cancelOrEdit,ship,release,closeOrderRemainder,cancelOrder,inbound,requestPrint,finishPack };",
  'export-close-operation'
);

replaceOnce(
  'src/App.js',
  `  const rawCoveredQty = legacyClosed ? orderQty : wipQty + shippedQty;\n  const coveredQty = Math.min(orderQty, rawCoveredQty);\n  const remainingQty = Math.max(0, orderQty - coveredQty);\n  const overQty = Math.max(0, rawCoveredQty - orderQty);\n\n  let status = "대기중";\n  if (order?.status === "취소") status = "취소";\n  else if (legacyClosed || (orderQty > 0 && shippedQty >= orderQty)) status = "출고완료";`,
  `  const remainderClosed = order?.status === "잔량마감";\n  const rawCoveredQty = (legacyClosed || remainderClosed) ? orderQty : wipQty + shippedQty;\n  const coveredQty = Math.min(orderQty, rawCoveredQty);\n  const remainingQty = Math.max(0, orderQty - coveredQty);\n  const overQty = Math.max(0, rawCoveredQty - orderQty);\n\n  let status = "대기중";\n  if (order?.status === "취소") status = "취소";\n  else if (remainderClosed) status = "잔량마감";\n  else if (legacyClosed || (orderQty > 0 && shippedQty >= orderQty)) status = "출고완료";`,
  'progress-close-status'
);

const closeHandler = `  const handleCloseRemainder = async order => {\n    const progress = getOrderProgress(order,wipList,shippingHistory);\n    if (progress.remainingQty <= 0) return ctx.showToast('남은 생산 수량이 없습니다.','error');\n    const audit = askAdmin('생산 단위상 잔량 미생산 마감');\n    if (!audit) return;\n    ctx.showConfirm(\`\${order.orderNo}\\n지시수량: \${progress.orderQty}EA\\n현재 반영: \${progress.rawCoveredQty}EA\\n남은 수량: \${progress.remainingQty}EA\\n\\n남은 수량만 미생산 마감하고 기존 생산/출고 이력은 그대로 보관할까요?\`, async () => {\n      try {\n        const result = await safeOps.closeOrderRemainder(order,audit);\n        ctx.showToast(\`잔량 \${result.remainder}EA 마감 완료\`,'success');\n      } catch(e) { ctx.showToast(e.message || String(e),'error'); }\n    });\n  };\n\n`;

replaceOnce(
  'src/App.js',
  "  const activeOrders = orderList.filter((o) => {",
  closeHandler + "  const activeOrders = orderList.filter((o) => {",
  'insert-close-handler'
);

replaceOnce(
  'src/App.js',
  `                      <div className="flex justify-center gap-2"><button onClick={() => handleDel(order.id)} className="text-red-300 hover:text-red-600"><Trash2 className="w-4 h-4" /></button></div>`,
  `                      <div className="flex justify-center gap-2 items-center">\n                        <button onClick={() => handleCloseRemainder(order)} className="text-[10px] px-2 py-1.5 rounded font-black bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 whitespace-nowrap">잔량마감</button>\n                        <button title="생산/출고 이력이 없는 지시 취소" onClick={() => handleDel(order.id)} className="text-red-300 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>\n                      </div>`,
  'add-close-button'
);
