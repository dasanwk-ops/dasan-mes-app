export const LEGACY_FINISHED_LOT_REPAIRS = Object.freeze([
  { documentId: "17846876767530.8783686089981537", finalLot: "F6090937", expectedQty: 40, productionLot: "MIX-260708-439" },
  { documentId: "17846876767540.3614818590143134", finalLot: "F6090934", expectedQty: 44, productionLot: "MIX-260708-439" },
  { documentId: "1788828431489hpzc8", finalLot: "F60908c8", expectedQty: 94, productionLot: "MIX-260820-886" },
  { documentId: "1788828431490bxbaw", finalLot: "F60908aw", expectedQty: 65, productionLot: "MIX-260820-886" },
]);

const normalize = value => String(value || "").trim();
const traceLots = data => [data.productionLot, data.sourceLot, data.originalLot]
  .map(normalize)
  .filter(value => /^MIX-/i.test(value));

export function validateLegacyFinishedLotRepair(repair, data) {
  const existing = traceLots(data);
  if (existing.includes(repair.productionLot)) return { alreadyLinked: true };
  if (existing.length) throw new Error(`${repair.finalLot}: 기존 생산 LOT 연결(${existing.join(", ")})과 충돌합니다.`);
  if (data.currentStep !== "done") throw new Error(`${repair.finalLot}: 완제품 상태가 아닙니다.`);
  if (Number(data.qty) !== repair.expectedQty) throw new Error(`${repair.finalLot}: 현재 수량 ${data.qty}EA가 예상 ${repair.expectedQty}EA와 다릅니다.`);
  if (String(data.height) !== "25") throw new Error(`${repair.finalLot}: 두께가 25T가 아닙니다.`);
  if (!normalize(data.type).toUpperCase().includes("BL3")) throw new Error(`${repair.finalLot}: BL3 제품이 아닙니다.`);
  const finalLots = [data.packLot, data.mixLot, data.lot].map(normalize).filter(Boolean);
  if (!finalLots.includes(repair.finalLot)) throw new Error(`${repair.finalLot}: 저장된 완제품 LOT 식별값이 일치하지 않습니다.`);
  return { alreadyLinked: false };
}

export async function repairLegacyFinishedLotLinks({ runTransaction, db, getDocRef, getKST }) {
  const result = [];
  for (const repair of LEGACY_FINISHED_LOT_REPAIRS) {
    let status = "linked";
    await runTransaction(db, async tx => {
      const ref = getDocRef("wipList", repair.documentId);
      const snap = await tx.get(ref);
      if (!snap.exists()) throw new Error(`${repair.finalLot}: 완제품 문서를 찾을 수 없습니다.`);
      const live = snap.data();
      const validation = validateLegacyFinishedLotRepair(repair, live);
      if (validation.alreadyLinked) {
        status = "already-linked";
        return;
      }
      const now = getKST();
      tx.update(ref, {
        productionLot: repair.productionLot,
        legacyLotRepair: {
          correctedAt: now,
          correctedBy: "MASTER",
          reason: "과거 포장 처리에서 유실된 생산 MIX LOT 연결정보 복구",
          finalLot: repair.finalLot,
          productionLot: repair.productionLot,
          qty: repair.expectedQty,
          before: {
            mixLot: live.mixLot || "",
            packLot: live.packLot || "",
            productionLot: live.productionLot || "",
            sourceLot: live.sourceLot || "",
            originalLot: live.originalLot || "",
          },
        },
      });
    });
    result.push({ ...repair, status });
  }
  return result;
}
