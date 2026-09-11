import React, { useRef, useState } from 'react';
import { getDocsFromServer } from 'firebase/firestore';
import { buildMesExport } from './mesStocktakeExportCore.mjs';

// Mount only inside the existing administrator DashboardView.
// The existing app supplies getColRef; this component does not initialize Firebase.
export default function MESStocktakeExport({ getCollectionRef, onError }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const busyRef = useRef(false);
  const exportSnapshot = async () => {
    if (!acknowledged || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    let objectUrl;
    try {
      const result = await buildMesExport({
        getCollectionRef,
        readCollection: getDocsFromServer,
        onProgress: ({ pass, name, index, total }) => setMessage(`${pass}/2 - ${name} (${index}/${total})`)
      });
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json;charset=utf-8' });
      objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = `MES_current_data_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(anchor);
      try { anchor.click(); } finally { anchor.remove(); }
      setMessage(`추출 파일 생성 완료. DB 변경 없음. WIP ${result.counts.wipList}개 문서.`);
    } catch (error) {
      const text = `추출 중단: ${error?.message || String(error)}`;
      setMessage(text);
      if (typeof onError === 'function') onError(text);
    } finally {
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
      busyRef.current = false;
      setBusy(false);
      setAcknowledged(false);
    }
  };
  return (
    <section className="bg-white border border-indigo-200 rounded-xl p-4 space-y-3">
      <h3 className="font-bold">{'실사 대조용 현재 MES 데이터 추출'}</h3>
      <p className="text-sm text-slate-600">{'DB를 수정하거나 삭제하지 않습니다. 전체 DB 백업을 대체하지 않습니다.'}</p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={acknowledged} disabled={busy} onChange={e => setAcknowledged(e.target.checked)} />
        {'태블릿의 입력과 저장을 마쳤으며, 추출 중에는 입력하지 않습니다.'}
      </label>
      <button type="button" disabled={!acknowledged || busy} onClick={exportSnapshot} className="bg-indigo-600 text-white px-4 py-2 rounded disabled:opacity-40">
        {busy ? '서버 데이터 확인 중' : '현재 데이터 JSON 내보내기'}
      </button>
      <p role="status" className="text-sm whitespace-pre-wrap break-words">{message}</p>
    </section>
  );
}
