import React, { useEffect, useMemo, useRef, useState } from "react";
import { doc, onSnapshot, runTransaction, serverTimestamp } from "firebase/firestore";
import { Archive, History, X } from "lucide-react";
import {
  ADJUSTMENT_COLLECTION, stockNumber, buildFinishedRows, filterFinishedRows,
  finishedHistory, commitFinishedAdjustment
} from "./finishedGoodsMaster";

const quantityText = value => value === null ? "미기록" : value.toLocaleString();
const deltaText = value => value === null ? "미기록" : `${value > 0 ? "+" : ""}${value.toLocaleString()}`;

function MasterDialog({ title, onClose, busy = false, children }) {
  const panel = useRef(null);
  const busyRef = useRef(busy);
  const closeRef = useRef(onClose);
  busyRef.current = busy;
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const focusable = () => [...(panel.current?.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]'
    ) || [])];
    (panel.current?.querySelector("[data-autofocus]") || focusable()[0] || panel.current)?.focus();
    const onKey = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) closeRef.current();
      }
      if (event.key === "Tab") {
        const nodes = focusable();
        if (!nodes.length) { event.preventDefault(); panel.current?.focus(); return; }
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus?.(); };
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <section ref={panel} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
        className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3 className="text-lg font-black text-slate-800">{title}</h3>
          <button type="button" aria-label="닫기" disabled={busy} onClick={onClose}
            className="rounded border p-2 disabled:opacity-40"><X className="h-4 w-4" /></button>
        </div>
        {children}
      </section>
    </div>
  );
}

export default function FinishedGoodsMaster({
  wipList = [], shippingHistory = [], db, getColRef, getDocRef, ctx, isAdmin, actorUid,
  getPackagingLot, getTraceMixLot, getProductLabel, getKST
}) {
  const [adjustments, setAdjustments] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [search, setSearch] = useState("");
  const [product, setProduct] = useState("");
  const [includeZero, setIncludeZero] = useState(false);
  const [edit, setEdit] = useState(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [saveError, setSaveError] = useState("");
  const [historyKey, setHistoryKey] = useState(null);
  const helpers = useMemo(() => ({ getPackagingLot, getTraceMixLot, getProductLabel }),
    [getPackagingLot, getTraceMixLot, getProductLabel]);

  useEffect(() => {
    setAdjustments(null);
    setLoadError("");
    if (isAdmin !== true || !actorUid) return undefined;
    return onSnapshot(getColRef(ADJUSTMENT_COLLECTION), snapshot => {
      setAdjustments(snapshot.docs.map(item => ({ ...item.data(), id: item.id })));
      setLoadError("");
    }, () => {
      setAdjustments(null);
      setLoadError("정정 이력을 불러오지 못했습니다. 연결 또는 조회 권한을 확인해주세요. 이력 확인 전에는 수량 정정을 저장할 수 없습니다.");
    });
  }, [isAdmin, actorUid, getColRef]);

  const rows = useMemo(() => buildFinishedRows(wipList, shippingHistory, adjustments || [], helpers),
    [wipList, shippingHistory, adjustments, helpers]);
  const visibleRows = useMemo(() => filterFinishedRows(rows, { search, product, includeZero }),
    [rows, search, product, includeZero]);
  const products = useMemo(() => [...new Set(rows.flatMap(row => row.products))].sort(), [rows]);
  const historyRow = rows.find(row => row.key === historyKey);
  const historyEvents = useMemo(() => finishedHistory(historyRow), [historyRow]);
  const historyReady = adjustments !== null && !loadError;
  const currentEditRow = edit ? rows.find(row => row.key === edit.key) : null;
  const liveEdit = currentEditRow?.live?.[0];
  const staleEdit = !!edit && (!currentEditRow?.adjustable ||
    String(liveEdit?.id) !== String(edit.expected.id) ||
    stockNumber(liveEdit?.qty) !== stockNumber(edit.expected.qty) ||
    (liveEdit?.finishedGoodsAdjustmentRevision ?? 0) !== (edit.expected.finishedGoodsAdjustmentRevision ?? 0));
  const target = edit ? stockNumber(edit.targetQty) : null;
  const delta = edit && target !== null ? target - Number(edit.expected.qty) : null;

  if (isAdmin !== true) return null;

  const openEdit = row => {
    if (!historyReady || !row.adjustable || busy.current) return;
    setSaveError("");
    setEdit({
      key: row.key, expected: { ...row.live[0] },
      adjustmentRef: doc(getColRef(ADJUSTMENT_COLLECTION)),
      targetQty: String(row.qty), reason: "", operator: ""
    });
  };

  const save = async event => {
    event.preventDefault();
    if (!edit || busy.current) return;
    if (!historyReady || staleEdit) {
      setSaveError("최신 재고와 정정 이력을 확인한 뒤 다시 시도해주세요.");
      return;
    }
    busy.current = true;
    setSaving(true);
    setSaveError("");
    try {
      const result = await commitFinishedAdjustment({
        request: {
          expected: edit.expected, targetQty: edit.targetQty, reason: edit.reason,
          operator: edit.operator, isAdmin, actorUid, now: getKST()
        },
        helpers, db, runTransaction, getDocRef,
        adjustmentRef: edit.adjustmentRef, serverTimestamp
      });
      setEdit(null);
      ctx.showToast(`${result.packLot}: ${result.beforeQty} → ${result.afterQty}개로 정정했습니다.`, "success");
    } catch (error) {
      const message = error?.code === "permission-denied"
        ? "저장 권한이 없습니다. 재고와 정정 이력은 함께 저장되지 않았습니다. 관리자에게 확인해주세요."
        : error?.message || "저장하지 못했습니다. 연결 상태와 최신 재고를 확인해주세요.";
      setSaveError(message);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <section id="master-finished-goods" data-testid="finished-goods-master"
      className="rounded-xl border border-slate-100 bg-white p-6 shadow-sm scroll-mt-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center text-lg font-bold text-slate-800">
          <Archive className="mr-2 h-5 w-5 text-slate-400" /> 완제품 현황 상세 (마스터)
        </h3>
        <span className="rounded border border-red-100 bg-red-50 px-2 py-1 text-xs font-bold text-red-500">마스터 권한</span>
      </div>
      <p className="mb-4 text-sm text-slate-500">완제품 창고와 같은 현재고입니다. 수량 정정은 이전 공정 실적이나 라벨 출력을 다시 처리하지 않습니다.</p>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[220px] text-xs font-bold text-slate-600">
          LOT / 제품 검색
          <input aria-label="완제품 LOT 또는 제품 검색" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="포장 LOT, MIX LOT, 제품" className="mt-1 block w-full rounded border p-2.5 text-sm font-normal" />
        </label>
        <label className="min-w-[180px] text-xs font-bold text-slate-600">
          제품 필터
          <select aria-label="완제품 제품 필터" value={product} onChange={e => setProduct(e.target.value)}
            className="mt-1 block w-full rounded border bg-white p-2.5 text-sm">
            <option value="">전체 제품</option>
            {products.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 py-2.5 text-sm font-bold text-slate-600">
          <input type="checkbox" checked={includeZero} onChange={e => setIncludeZero(e.target.checked)} />
          재고 0 포함
        </label>
      </div>
      {loadError ? <p role="alert" className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{loadError}</p> :
        !historyReady && <p role="status" className="mb-3 text-sm text-slate-500">정정 이력을 불러오는 중입니다. 확인 후 수량을 정정할 수 있습니다.</p>}
      <div className="mb-2 text-right text-xs text-slate-500">
        {visibleRows.length}개 LOT · 조회 현재고 {visibleRows.reduce((sum, row) => sum + (row.invalidQty ? 0 : row.qty), 0).toLocaleString()}개
        {visibleRows.some(row => row.invalidQty) && " (수량 오류 LOT 제외)"}
      </div>
      <div className="max-h-[500px] overflow-auto rounded-lg border">
        <table className="w-full min-w-[800px] text-left text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs text-slate-500 shadow-sm">
            <tr><th className="px-4 py-3">최종 포장 LOT</th><th className="px-4 py-3">생산 MIX LOT</th>
              <th className="px-4 py-3">제품</th><th className="px-4 py-3 text-right">현재고</th><th className="px-4 py-3 text-center">관리</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleRows.map(row => (
              <tr key={row.key} data-testid={`finished-lot-${row.packLot || row.key}`} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-bold text-indigo-700">
                  {row.packLot || "포장 LOT 미기록"}
                  {row.inProcess.length > 0 && <div className="mt-1 text-xs font-normal text-amber-700">진행 중 공정 연결 확인 필요</div>}
                  {!row.live.length && <div className="mt-1 text-xs font-normal text-slate-500">이력 조회용</div>}
                </td>
                <td className="px-4 py-3 text-blue-600">{row.mixLots.join(", ") || "연결 정보 미기록"}</td>
                <td className="px-4 py-3 font-bold text-slate-800">{row.products.join(" / ")}</td>
                <td className="px-4 py-3 text-right text-lg font-black text-indigo-600">{row.invalidQty ? "확인 필요" : row.qty.toLocaleString()}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-center gap-2">
                    <button type="button" onClick={() => openEdit(row)} disabled={!historyReady || !row.adjustable || saving}
                      title={row.blockedReason || (!historyReady ? "정정 이력을 먼저 확인해야 합니다." : "완제품 현재고 정정")}
                      className="whitespace-nowrap rounded border px-2.5 py-1.5 font-bold text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40">수량 정정</button>
                    <button type="button" onClick={() => setHistoryKey(row.key)}
                      className="flex items-center gap-1 whitespace-nowrap rounded border px-2.5 py-1.5 text-slate-600">
                      <History className="h-3.5 w-3.5" /> 이력
                    </button>
                  </div>
                  {row.live.length > 0 && row.blockedReason && <p className="mt-1 max-w-xs text-xs text-amber-700">{row.blockedReason}</p>}
                </td>
              </tr>
            ))}
            {!visibleRows.length && <tr><td colSpan={5} className="py-10 text-center text-slate-400">조건에 맞는 완제품 LOT가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>

      {edit && <MasterDialog title="완제품 재고 수량 정정" busy={saving} onClose={() => setEdit(null)}>
        <form onSubmit={save} className="space-y-4">
          <div className="rounded-lg bg-slate-50 p-4 text-sm leading-7">
            <div>최종 포장 LOT: <strong>{getPackagingLot(edit.expected)}</strong></div>
            <div>생산 MIX LOT: <strong>{getTraceMixLot(edit.expected) || "미기록"}</strong></div>
            <div>제품: <strong>{getProductLabel(edit.expected.type)} {edit.expected.height}T</strong></div>
            <div>변경 전 현재고: <strong>{Number(edit.expected.qty).toLocaleString()}개</strong></div>
          </div>
          {staleEdit && <p role="alert" className="rounded bg-amber-50 p-3 text-sm text-amber-800">편집 중 재고가 변경되었거나 출고되었습니다. 창을 닫고 최신 수량을 확인해주세요.</p>}
          <label className="block text-sm font-bold text-slate-700">변경할 현재고 (개)
            <input data-autofocus type="number" min="0" step="1" required disabled={saving}
              value={edit.targetQty} onChange={e => setEdit({ ...edit, targetQty: e.target.value })}
              className="mt-1 block w-full rounded border p-2.5 text-lg" />
          </label>
          <p className="font-bold text-indigo-700">조정 차이: {delta === null ? "수량을 입력해주세요." : `${deltaText(delta)}개`}</p>
          <label className="block text-sm font-bold text-slate-700">정정 사유 (필수)
            <textarea required maxLength={500} disabled={saving} value={edit.reason}
              onChange={e => setEdit({ ...edit, reason: e.target.value })} rows={2}
              placeholder="예: 실물 재고 확인에 따른 수량 정정" className="mt-1 block w-full rounded border p-2.5 font-normal" />
          </label>
          <label className="block text-sm font-bold text-slate-700">처리자 이름 (필수)
            <input required maxLength={80} disabled={saving} value={edit.operator}
              onChange={e => setEdit({ ...edit, operator: e.target.value })} className="mt-1 block w-full rounded border p-2.5 font-normal" />
          </label>
          <p className="text-xs leading-5 text-slate-500">
            공용 PIN으로 접속하므로 처리자 이름은 직접 입력합니다. 처리일시와 접속 식별자는 자동 기록됩니다.
            수량을 0으로 정정해도 LOT 문서를 삭제하지 않습니다. 라벨은 추가 출력되지 않습니다.
          </p>
          {saveError && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{saveError}</p>}
          <div className="flex justify-end gap-3">
            <button type="button" disabled={saving} onClick={() => setEdit(null)} className="rounded-lg bg-slate-100 px-5 py-2.5 font-bold disabled:opacity-40">취소</button>
            <button type="submit" disabled={saving || staleEdit || !historyReady || target === null || delta === 0 || !edit.reason.trim() || !edit.operator.trim()}
              className="rounded-lg bg-indigo-600 px-5 py-2.5 font-bold text-white disabled:opacity-40">
              {saving ? "저장 중..." : "정정 저장"}
            </button>
          </div>
        </form>
      </MasterDialog>}

      {historyKey && <MasterDialog title={`완제품 이력 · ${historyRow?.packLot || "LOT"}`} onClose={() => setHistoryKey(null)}>
        {!historyReady && <p role="alert" className="mb-3 text-sm text-amber-800">{loadError || "정정 이력을 불러오는 중입니다."}</p>}
        <p className="mb-4 text-sm text-slate-600">현재고: <strong>{historyRow?.invalidQty ? "확인 필요" : (historyRow?.qty ?? 0).toLocaleString()}개</strong> · 시간은 한국 시간 기준입니다.</p>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full min-w-[600px] text-left text-xs">
            <thead className="bg-slate-50 text-slate-500"><tr><th className="p-3">일시</th><th className="p-3">구분</th>
              <th className="p-3">증감</th><th className="p-3">변경 전 → 후</th><th className="p-3">처리자</th><th className="p-3">사유 / 출고처</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {historyEvents.map(event => <tr key={event.id}>
                <td className="p-3 whitespace-nowrap">{event.date || "미기록"}</td><td className="p-3 whitespace-nowrap font-bold">{event.kind}</td>
                <td className="p-3 font-bold">{deltaText(event.delta)}</td>
                <td className="p-3 whitespace-nowrap">{quantityText(event.before)} → {quantityText(event.after)}</td>
                <td className="p-3">{event.operator || "미기록"}</td><td className="p-3 break-words">{event.note}</td>
              </tr>)}
              {!historyEvents.length && <tr><td colSpan={6} className="p-6 text-center text-slate-400">저장된 입고·출고·정정 이력이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-500">기존 기록에 없는 당시 수량은 추정하지 않고 ‘미기록’으로 표시합니다. 이 화면에서 기존 이력을 수정하거나 삭제하지 않습니다.</p>
      </MasterDialog>}
    </section>
  );
}
