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

const effect = [
  "  useEffect(() => {",
  "    if (!user || !isUnlocked) return;",
  "",
  "    const apply667ShrinkageCorrection = async () => {",
  "      const targetRef = getDocRef(\"wipList\", \"stocktake-recovery-260724-667\");",
  "",
  "      try {",
  "        await runTransaction(db, async (transaction) => {",
  "          const snap = await transaction.get(targetRef);",
  "          if (!snap.exists()) throw new Error(\"667 복구 WIP가 존재하지 않습니다.\");",
  "",
  "          const live = snap.data();",
  "          const recovery = live.stocktakeRecovery || {};",
  "",
  "          if (Number(live.qty) !== 94) throw new Error(\"667 수량이 94EA가 아닙니다.\");",
  "          if (String(live.mixLot || \"\") !== \"MIX-260724-667\") throw new Error(\"667 MIX LOT 불일치\");",
  "          if (String(live.currentStep || \"\") !== \"step8\") throw new Error(\"667 공정 단계 불일치\");",
  "          if (String(recovery.sourceLot || \"\") !== \"MIX-260724-667\") throw new Error(\"667 복구 원본 LOT 불일치\");",
  "          if (recovery.needsHeatHistory !== true) throw new Error(\"667 열처리 원기록 상태가 예상과 다릅니다.\");",
  "",
  "          const currentRate = String(live.shrinkageRate || \"\").trim();",
  "          const alreadyCorrect =",
  "            currentRate === \"19.7665\" &&",
  "            recovery.needsShrinkageData === false &&",
  "            String(recovery.shrinkageRemeasuredRate || \"\") === \"19.7665\";",
  "",
  "          if (alreadyCorrect) return;",
  "",
  "          if (![\"\", \"0\", \"19.7665\"].includes(currentRate)) {",
  "            throw new Error(\"667 기존 수축률이 예상과 다릅니다: \" + currentRate);",
  "          }",
  "",
  "          const now = getKST();",
  "          const oldDetails = String(live.details || \"\");",
  "          const audit = \"[\" + now + \"] [수축률 재측정] 실측 수축률 19.7665% 반영 | 기존 열처리 원기록 미확인 상태 유지\";",
  "          const nextDetails = oldDetails.includes(\"[수축률 재측정] 실측 수축률 19.7665%\")",
  "            ? oldDetails",
  "            : oldDetails + \"\\n\" + audit;",
  "",
  "          transaction.update(targetRef, {",
  "            shrinkageRate: \"19.7665\",",
  "            details: nextDetails,",
  "            \"stocktakeRecovery.needsShrinkageData\": false,",
  "            \"stocktakeRecovery.shrinkageRemeasuredRate\": \"19.7665\",",
  "            \"stocktakeRecovery.shrinkageRemeasuredAt\": now,",
  "            \"stocktakeRecovery.shrinkageRemeasureSource\": \"사용자 제공 실측값\",",
  "          });",
  "        });",
  "",
  "        console.info(\"[MES] 667 수축률 19.7665% 보정 완료\");",
  "      } catch (e) {",
  "        console.error(\"[MES] 667 수축률 보정 실패\", e);",
  "      }",
  "    };",
  "",
  "    apply667ShrinkageCorrection();",
  "  }, [user, isUnlocked]);",
  "",
  ""
].join("\n");

replaceOnce(
  "src/App.js",
  "  if (!isUnlocked) {",
  effect + "  if (!isUnlocked) {",
  "insert-667-shrinkage-runtime-fix"
);
