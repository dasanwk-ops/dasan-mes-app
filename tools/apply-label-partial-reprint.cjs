const fs = require('fs');

const APP_PATH = 'src/App.js';
const MARKER = '// label-partial-reprint-v1';

function replaceOnce(text, oldText, newText, label) {
  const first = text.indexOf(oldText);
  const last = text.lastIndexOf(oldText);
  if (first < 0) throw new Error(`${label}: target not found`);
  if (first !== last) throw new Error(`${label}: target is not unique`);
  return text.slice(0, first) + newText + text.slice(first + oldText.length);
}

let text = fs.readFileSync(APP_PATH, 'utf8');

if (text.includes(MARKER)) {
  console.log('label-partial-reprint: already applied');
  process.exit(0);
}

const sectionStart = text.indexOf('  const handlePrintLabel =');
const sectionEnd = text.indexOf(
  '\n  return (\n    <div className="bg-white rounded-xl shadow-sm border border-slate-100 p-6">',
  sectionStart
);

if (sectionStart < 0 || sectionEnd < 0) {
  throw new Error('label-partial-reprint: Step8 print section not found');
}

let section = text.slice(sectionStart, sectionEnd);

section = replaceOnce(
  section,
  `  const handlePrintLabel =\n    async (wipId) => {`,
  `  ${MARKER}\n  const handlePrintLabel =\n    async (wipId, printOptions = {}) => {`,
  'label-print-signature'
);

section = replaceOnce(
  section,
  `      const finalQty =\n        Math.max(\n          0,\n          Number(wip.qty) - defectQty\n        );\n\n      const finalLot =`,
  `      const finalQty =\n        Math.max(\n          0,\n          Number(wip.qty) - defectQty\n        );\n\n      if (finalQty <= 0) {\n        return ctx.showToast(\n          "출력할 정상 제품 수량이 없습니다.",\n          "error"\n        );\n      }\n\n      const isReprint =\n        Boolean(printOptions.isReprint);\n\n      const reprintReason =\n        String(\n          printOptions.reprintReason || ""\n        ).trim();\n\n      const printQuantity =\n        isReprint\n          ? Number(printOptions.quantity)\n          : finalQty;\n\n      if (\n        !Number.isInteger(printQuantity) ||\n        printQuantity <= 0 ||\n        printQuantity > finalQty\n      ) {\n        return ctx.showToast(\n          \`재출력 수량은 1~\${finalQty}개 사이의 정수여야 합니다.\`,\n          "error"\n        );\n      }\n\n      if (isReprint && !reprintReason) {\n        return ctx.showToast(\n          "재출력 사유를 입력해주세요.",\n          "error"\n        );\n      }\n\n      const finalLot =`,
  'label-print-options'
);

section = replaceOnce(
  section,
  `  // 실제 출력할 라벨 수량\n  quantity: finalQty,`,
  `  // 실제 출력할 라벨 수량\n  quantity: printQuantity,\n\n  // 재출력 추적용 메타데이터\n  printType: isReprint ? "reprint" : "initial",\n  isReprint,\n  reprintReason: isReprint ? reprintReason : "",\n  originalQuantity: finalQty,`,
  'label-queue-quantity'
);

section = replaceOnce(
  section,
  `        // 출력 이력 저장\n        try {`,
  `        // 출력 이력 저장\n        // 최초 출력 조건은 포장완료 검증 기준으로 유지하고,\n        // 부분 재출력은 별도 이력으로만 기록합니다.\n        const labelHistoryUpdate =\n          isReprint\n            ? {\n                labelReprintCount:\n                  (Number(wip.labelReprintCount) || 0) + 1,\n                labelReprintTotalQty:\n                  (Number(wip.labelReprintTotalQty) || 0) +\n                  printQuantity,\n                labelLastReprintedAt: now,\n                labelLastReprintQty: printQuantity,\n                labelLastReprintReason: reprintReason,\n              }\n            : {\n                labelPrintedAt: now,\n                labelPrintedQty: finalQty,\n                labelPrintedDefectQty: defectQty,\n                labelPrintedPackLot: finalLot,\n                labelPrintedShrinkage: wip.shrinkageRate,\n                labelPrintCount:\n                  (Number(wip.labelPrintCount) || 0) + 1,\n              };\n\n        try {`,
  'label-history-definition'
);

const historyObjectStart = `           {\n  labelPrintedAt: now,\n\n  // 라벨 출력 당시 확정값 저장\n  labelPrintedQty: finalQty,\n\n  labelPrintedDefectQty:\n    defectQty,\n\n  labelPrintedPackLot:\n    finalLot,\n\n  labelPrintedShrinkage:\n    wip.shrinkageRate,\n\n  labelPrintCount:\n    (\n      Number(\n        wip.labelPrintCount\n      ) || 0\n    ) + 1,\n},`;

section = replaceOnce(
  section,
  historyObjectStart,
  `            labelHistoryUpdate,`,
  'label-history-object'
);

section = replaceOnce(
  section,
  `        ctx.showToast(\n          \`라벨 출력 명령 전송 완료 — \${finalLot} 🖨️\`,\n          "success"\n        );`,
  `        ctx.showToast(\n          isReprint\n            ? \`라벨 재출력 \${printQuantity}장 준비 완료 — \${finalLot} 🖨️\`\n            : \`라벨 출력 명령 전송 완료 — \${finalLot} 🖨️\`,\n          "success"\n        );`,
  'label-toast'
);

const handlePrintEnd = `      }\n    };`;
const handlePrintEndIndex = section.lastIndexOf(handlePrintEnd);
if (handlePrintEndIndex < 0) {
  throw new Error('label-partial-reprint: handlePrintLabel end not found');
}

const reprintHandler = `\n\n  const handleReprintLabel =\n    async (wipId) => {\n      const wip = wipList.find(\n        (w) => w.id === wipId\n      );\n\n      if (!wip) {\n        return ctx.showToast(\n          "재출력 대상 제품을 찾을 수 없습니다.",\n          "error"\n        );\n      }\n\n      const data = formData[wipId] || {};\n      const defectQty =\n        parseInt(data.defects) || 0;\n      const finalQty =\n        Math.max(\n          0,\n          Number(wip.qty) - defectQty\n        );\n\n      if (finalQty <= 0) {\n        return ctx.showToast(\n          "재출력할 정상 제품 수량이 없습니다.",\n          "error"\n        );\n      }\n\n      const finalLot =\n        getPackagingLot(wip);\n\n      // 부분 재출력은 인쇄 오류 보완용입니다.\n      // 최초 출력 이후 포장 조건이 바뀌었으면 기존 확정 조건을 덮어쓰지 않습니다.\n      const printedQty =\n        Number(wip.labelPrintedQty);\n      const printedDefectQty =\n        Number(wip.labelPrintedDefectQty) || 0;\n      const printedShrinkage =\n        Number(wip.labelPrintedShrinkage);\n\n      if (\n        !wip.labelPrintedAt ||\n        printedQty !== finalQty ||\n        printedDefectQty !== defectQty ||\n        String(wip.labelPrintedPackLot || "") !==\n          String(finalLot || "") ||\n        printedShrinkage !==\n          Number(wip.shrinkageRate)\n      ) {\n        return ctx.showToast(\n          "최초 출력 후 포장 조건이 변경되었습니다. 부분 재출력 전에 수량/불량/LOT/수축률을 확인해주세요.",\n          "error"\n        );\n      }\n\n      const qtyInput = window.prompt(\n        \`재출력 수량을 입력하세요. (1~\${finalQty})\`,\n        "1"\n      );\n\n      if (qtyInput === null) return;\n\n      const quantity =\n        Number(String(qtyInput).trim());\n\n      if (\n        !Number.isInteger(quantity) ||\n        quantity <= 0 ||\n        quantity > finalQty\n      ) {\n        return ctx.showToast(\n          \`재출력 수량은 1~\${finalQty}개 사이의 정수여야 합니다.\`,\n          "error"\n        );\n      }\n\n      const reasonInput = window.prompt(\n        "재출력 사유를 입력하세요.",\n        "인쇄 오류"\n      );\n\n      if (reasonInput === null) return;\n\n      const reprintReason =\n        String(reasonInput).trim();\n\n      if (!reprintReason) {\n        return ctx.showToast(\n          "재출력 사유를 입력해주세요.",\n          "error"\n        );\n      }\n\n      await handlePrintLabel(\n        wipId,\n        {\n          isReprint: true,\n          quantity,\n          reprintReason,\n        }\n      );\n    };`;

section =
  section.slice(0, handlePrintEndIndex + handlePrintEnd.length) +
  reprintHandler +
  section.slice(handlePrintEndIndex + handlePrintEnd.length);

text =
  text.slice(0, sectionStart) +
  section +
  text.slice(sectionEnd);

text = replaceOnce(
  text,
  `                          onClick={() =>\n                            handlePrintLabel(\n                              wip.id\n                            )\n                          }`,
  `                          onClick={() =>\n                            isPrinted\n                              ? handleReprintLabel(\n                                  wip.id\n                                )\n                              : handlePrintLabel(\n                                  wip.id\n                                )\n                          }`,
  'label-reprint-button'
);

fs.writeFileSync(APP_PATH, text, 'utf8');
console.log('label-partial-reprint: applied');
