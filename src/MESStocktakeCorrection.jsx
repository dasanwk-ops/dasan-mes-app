import React, { useState } from "react";
import { runTransaction } from "firebase/firestore";

const LOT_138_ID = "1786694340867B";
const LOT_977_B_ID = "1788851924370B";
const LOT_667_ID = "stocktake-recovery-260724-667";

function getKSTNow() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(new Date())
    .replace(" ", " ");
}

export default function MESStocktakeCorrection({
  db,
  getDocRef,
  onSuccess,
  onError,
}) {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);

  const applyCorrection = async () => {
    if (confirmText.trim() !== "실사보정") {
      onError?.("확인란에 실사보정 이라고 정확히 입력해주세요.");
      return;
    }

    const ok = window.confirm(
      [
        "실제 Firebase 데이터를 수정합니다.",
        "",
        "1) 260724-667 : 94EA 포장 대기로 복구",
        "2) 260814-138 : 20EA -> 12EA",
        "3) 260826-977 : 100EA -> 98EA",
        "",
        "실행하시겠습니까?",
      ].join("\n")
    );

    if (!ok) return;

    setBusy(true);

    try {
      await runTransaction(db, async (tx) => {
        const ref138 = getDocRef("wipList", LOT_138_ID);
        const ref977B = getDocRef("wipList", LOT_977_B_ID);
        const ref667 = getDocRef("wipList", LOT_667_ID);
        const furnaceRef = getDocRef("equipment", "furnaces");
        const shrinkRef = getDocRef("equipment", "shrinkDesks");

        // -----------------------------
        // 모든 현재값을 먼저 읽음
        // -----------------------------
        const snap138 = await tx.get(ref138);
        const snap977B = await tx.get(ref977B);
        const snap667 = await tx.get(ref667);
        const furnaceSnap = await tx.get(furnaceRef);
        const shrinkSnap = await tx.get(shrinkRef);

        if (!snap138.exists()) {
          throw new Error("260814-138 현재 WIP를 찾을 수 없습니다.");
        }

        if (!snap977B.exists()) {
          throw new Error("260826-977-B 현재 WIP를 찾을 수 없습니다.");
        }

        if (snap667.exists()) {
          throw new Error(
            "260724-667 복구 문서가 이미 존재합니다. 중복 복구를 중단합니다."
          );
        }

        const w138 = snap138.data();
        const w977B = snap977B.data();
        const furnaces = furnaceSnap.exists() ? furnaceSnap.data() : {};
        const shrinkDesks = shrinkSnap.exists() ? shrinkSnap.data() : {};

        // -----------------------------
        // 138 안전확인
        // -----------------------------
        if (
          w138.mixLot !== "MIX-260814-138-B" ||
          w138.currentStep !== "step5_shrink" ||
          Number(w138.qty) !== 20
        ) {
          throw new Error(
            "260814-138 상태가 확인 당시와 달라졌습니다. 보정을 중단합니다."
          );
        }

        const slots138 = Array.isArray(w138.furnaceSlots)
          ? w138.furnaceSlots
          : [];

        if (
          slots138.length !== 1 ||
          slots138[0].slotId !== "R4" ||
          Number(slots138[0].qty) !== 20
        ) {
          throw new Error(
            "260814-138 열처리 위치 기록이 예상과 다릅니다. 보정을 중단합니다."
          );
        }

        // 현재 수축률 측정대에 138이 등록되어 있으면 중단
        let shrink138Qty = 0;

        Object.values(shrinkDesks || {}).forEach((desk) => {
          [desk, ...(desk?.queue || [])].forEach((batch) => {
            Object.values(batch?.slotData || {}).forEach((slot) => {
              if (String(slot?.wipId || "") === LOT_138_ID) {
                shrink138Qty += Number(slot?.qty) || 0;
              }
            });
          });
        });

        if (shrink138Qty > 0) {
          throw new Error(
            `260814-138이 현재 수축률 측정대에 ${shrink138Qty}EA 등록되어 있습니다. 보정을 중단합니다.`
          );
        }

        // -----------------------------
        // 977 안전확인
        // -----------------------------
        if (
          w977B.mixLot !== "MIX-260826-977-B" ||
          w977B.currentStep !== "step5" ||
          Number(w977B.qty) !== 52
        ) {
          throw new Error(
            "260826-977-B 상태가 확인 당시와 달라졌습니다. 보정을 중단합니다."
          );
        }

        const furnace1 = furnaces?.["1"];

        if (!furnace1?.isHeating) {
          throw new Error(
            "1호 전기로가 현재 가동 상태가 아닙니다. 977 보정을 중단합니다."
          );
        }

        const r2 = furnace1?.slotData?.R2;
        const r3 = furnace1?.slotData?.R3;

        if (
          r2?.wipId !== LOT_977_B_ID ||
          r3?.wipId !== LOT_977_B_ID ||
          Number(r2?.qty) !== 26 ||
          Number(r3?.qty) !== 26
        ) {
          throw new Error(
            "260826-977 전기로 슬롯 상태가 확인 당시와 달라졌습니다. 보정을 중단합니다."
          );
        }

        const now = getKSTNow();

        // -----------------------------
        // 667 : 실사 복구
        // 건조까지 완료 -> 포장 대기
        // -----------------------------
        tx.set(ref667, {
          id: LOT_667_ID,
          mixLot: "MIX-260724-667",
          orderId: "",
          type: "BL3",
          height: "25",
          singleWeight: 650,
          qty: 94,
          currentStep: "step8",
          shrinkageRate: "",
          weight: "65.850",
          details:
            `[${now}] [실사 복구] ` +
            `실물 94EA 확인. 기존 MES WIP 누락으로 복구. ` +
            `검수/가공 및 건조 완료 확인. 수축률 원기록 확인 불가. ` +
            `원재료 재차감 없음.`,
          stocktakeRecovery: {
            correctedAt: now,
            correctedBy: "MASTER",
            reason: "2026-09-11 실사 확인 - 기존 WIP 누락 복구",
            sourceLot: "MIX-260724-667",
            recoveredQty: 94,
          },
        });

        // -----------------------------
        // 138 : 실제 8EA 출고 미반영
        // 20 -> 12, 과거 열처리 위치도 12로 맞춤
        // -----------------------------
        tx.update(ref138, {
          qty: 12,
          furnaceSlots: [
            {
              ...slots138[0],
              qty: 12,
            },
          ],
          details:
            `${w138.details || ""}\n` +
            `[${now}] [실사 수량보정] 20EA → 12EA | ` +
            `사유: 실제 출고 8EA가 MES에 미반영된 사실 확인`,
          lastQtyCorrection: {
            before: 20,
            after: 12,
            reason: "실제 출고 8EA MES 미반영",
            correctedAt: now,
            correctedBy: "MASTER",
          },
        });

        // -----------------------------
        // 977 : 동일 생산 LOT
        // B 52 -> 50, R2 26 -> 24
        // 전체 100 -> 98
        // -----------------------------
        tx.update(ref977B, {
          qty: 50,
          details:
            `${w977B.details || ""}\n` +
            `[${now}] [실사 수량보정] 52EA → 50EA | ` +
            `사유: 260826-977 실물 총수량 98EA 확인`,
          lastQtyCorrection: {
            before: 52,
            after: 50,
            reason: "실사 결과 260826-977 총 2EA 부족 확인",
            correctedAt: now,
            correctedBy: "MASTER",
          },
        });

        tx.set(furnaceRef, {
          ...furnaces,
          "1": {
            ...furnace1,
            slotData: {
              ...furnace1.slotData,
              R2: {
                ...r2,
                qty: 24,
              },
            },
          },
        });
      });

      setConfirmText("");
      onSuccess?.(
        "실사 보정 완료: 667 복구 / 138 12EA / 977 98EA"
      );
    } catch (error) {
      onError?.(error?.message || String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-red-50 border-2 border-red-300 rounded-xl p-5 space-y-4">
      <div>
        <h3 className="font-black text-red-800 text-lg">
          2026-09-11 실사 확정 보정
        </h3>
        <p className="text-sm text-red-700 mt-1">
          실제 Firebase 데이터를 변경합니다. 이번 실사 3건만 처리합니다.
        </p>
      </div>

      <div className="bg-white rounded-lg border p-4 text-sm space-y-1">
        <div>260724-667 : 94EA 포장 대기로 복구</div>
        <div>260814-138 : 20EA → 12EA</div>
        <div>260826-977 : 전체 100EA → 98EA</div>
      </div>

      <div>
        <label className="text-sm font-bold text-slate-700">
          실행하려면 아래에 실사보정 입력
        </label>
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          className="mt-2 border rounded p-2 w-full bg-white"
          placeholder="실사보정"
          disabled={busy}
        />
      </div>

      <button
        type="button"
        disabled={busy || confirmText.trim() !== "실사보정"}
        onClick={applyCorrection}
        className="bg-red-600 disabled:bg-slate-300 text-white px-5 py-3 rounded-lg font-black"
      >
        {busy ? "보정 처리 중..." : "실사 확정 보정 실행"}
      </button>
    </div>
  );
}
