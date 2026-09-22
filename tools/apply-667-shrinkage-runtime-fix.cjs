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
  "    const apply667RecoveryCorrection = async () => {",
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
  "",
  "          const currentRate = String(live.shrinkageRate || \"\").trim();",
  "          if (![\"\", \"0\", \"19.7665\"].includes(currentRate)) {",
  "            throw new Error(\"667 기존 수축률이 예상과 다릅니다: \" + currentRate);",
  "          }",
  "",
  "          const now = getKST();",
  "          const reason = \"수축률 및 열처리 완료일 원기록 확인 불가\";",
  "          const substituteCompletedAt = \"2026-09-21\";",
  "          const existingHeatHistory = Array.isArray(live.heatTreatmentHistory)",
  "            ? live.heatTreatmentHistory",
  "            : [];",
  "",
  "          const hasSubstituteHeatDate = existingHeatHistory.some((h) =>",
  "            h &&",
  "            String(h.completedAt || \"\").split(\" \")[0] === substituteCompletedAt &&",
  "            String(h.recoveryReason || \"\") === reason",
  "          );",
  "",
  "          const nextHeatHistory = hasSubstituteHeatDate",
  "            ? existingHeatHistory",
  "            : [",
  "                ...existingHeatHistory,",
  "                {",
  "                  furnaceId: \"\",",
  "                  startedAt: \"\",",
  "                  completedAt: substituteCompletedAt,",
  "                  temperature: \"\",",
  "                  operator: \"\",",
  "                  memo: \"\",",
  "                  recoverySubstitute: true,",
  "                  recoveryReason: reason,",
  "                },",
  "              ];",
  "",
  "          const oldDetails = String(live.details || \"\");",
  "          const shrinkAudit = \"[\" + now + \"] [수축률 재측정] 실측 수축률 19.7665% 반영\";",
  "          const heatAudit = \"[\" + now + \"] [열처리 완료일 대체 입력] 2026-09-21 | 사유:\" + reason;",
  "          let nextDetails = oldDetails;",
  "          if (!nextDetails.includes(\"[수축률 재측정] 실측 수축률 19.7665%\")) nextDetails += \"\\n\" + shrinkAudit;",
  "          if (!nextDetails.includes(\"[열처리 완료일 대체 입력] 2026-09-21\")) nextDetails += \"\\n\" + heatAudit;",
  "",
  "          const alreadyComplete =",
  "            currentRate === \"19.7665\" &&",
  "            recovery.needsShrinkageData === false &&",
  "            String(recovery.shrinkageRemeasuredRate || \"\") === \"19.7665\" &&",
  "            hasSubstituteHeatDate;",
  "",
  "          if (alreadyComplete) return;",
  "",
  "          transaction.update(targetRef, {",
  "            shrinkageRate: \"19.7665\",",
  "            heatTreatmentHistory: nextHeatHistory,",
  "            details: nextDetails,",
  "            \"stocktakeRecovery.needsShrinkageData\": false,",
  "            \"stocktakeRecovery.shrinkageRemeasuredRate\": \"19.7665\",",
  "            \"stocktakeRecovery.shrinkageRemeasuredAt\": recovery.shrinkageRemeasuredAt || now,",
  "            \"stocktakeRecovery.shrinkageRemeasureSource\": recovery.shrinkageRemeasureSource || \"사용자 제공 실측값\",",
  "            \"stocktakeRecovery.heatDateSubstitute\": substituteCompletedAt,",
  "            \"stocktakeRecovery.heatDateRecoveryReason\": reason,",
  "            \"stocktakeRecovery.heatDateSubstitutedAt\": now,",
  "          });",
  "        });",
  "",
  "        console.info(\"[MES] 667 수축률/열처리 완료일 보정 완료\");",
  "      } catch (e) {",
  "        console.error(\"[MES] 667 복구 보정 실패\", e);",
  "      }",
  "    };",
  "",
  "    apply667RecoveryCorrection();",
  "  }, [user, isUnlocked]);",
  "",
  ""
].join("\n");

replaceOnce(
  "src/App.js",
  "  if (!isUnlocked) {",
  effect + "  if (!isUnlocked) {",
  "insert-667-recovery-runtime-fix"
);
