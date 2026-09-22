const fs = require("fs");

function replaceOnce(path, oldText, newText, label) {
  let text = fs.readFileSync(path, "utf8");
  const first = text.indexOf(oldText);
  const last = text.lastIndexOf(oldText);
  if (first < 0) {
    if (text.includes(newText)) {
      console.log(label + ": already applied");
      return;
    }
    throw new Error(label + ": target not found");
  }
  if (first !== last) throw new Error(label + ": target is not unique");
  text = text.slice(0, first) + newText + text.slice(first + oldText.length);
  fs.writeFileSync(path, text, "utf8");
  console.log(label + ": applied");
}

replaceOnce(
  "src/App.js",
  'const manufacturedAt =\n  lastHeatRecord?.completedAt || "";',
  [
    'const is667RecoveredLot =',
    '  String(wip?.id || "") === "stocktake-recovery-260724-667" &&',
    '  String(wip?.mixLot || "") === "MIX-260724-667" &&',
    '  Number(wip?.qty) === 94 &&',
    '  String(wip?.shrinkageRate || "") === "19.7665" &&',
    '  String(wip?.stocktakeRecovery?.sourceLot || "") === "MIX-260724-667";',
    '',
    '// 667은 원 열처리 완료일 기록이 유실된 실사 복구 LOT.',
    '// 사용자가 지정한 2026-09-21을 라벨 제조일 대체값으로만 사용하며,',
    '// 실제 열처리 이력을 새로 만들어 기록하지 않는다.',
    'const manufacturedAt =',
    '  lastHeatRecord?.completedAt ||',
    '  (is667RecoveredLot ? "2026-09-21" : "");'
  ].join("\n"),
  "apply-667-label-date-fallback"
);
