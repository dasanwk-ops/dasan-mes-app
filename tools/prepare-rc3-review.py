from pathlib import Path
import hashlib

def load(name, expected):
    p=Path(name); b=p.read_bytes()
    actual=hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()
    if actual!=expected: raise SystemExit('Unexpected source baseline: '+name+' '+actual)
    return p,b.decode('utf-8')
def once(s,a,b):
    if s.count(a)!=1: raise SystemExit('Non-unique source anchor: '+a[:100])
    return s.replace(a,b)

p,s=load('src/App.js','9de6ee055c8b20e7e41519d90e14e743fd5bd00c')
s=once(s,'import { getWipProcessStatus } from "./mesProcessStatus.mjs";', 'import { getWipProcessStatus } from "./mesProcessStatus.mjs";\nimport { reviewShrinkage } from "./mesShrinkReview.mjs";\nimport { switchShrinkBatch } from "./mesShrinkQueue.mjs";')
s=once(s,'function Step5_5Shrinkage({ wipList, ctx }) {','function Step5_5Shrinkage({ wipList, furnaces, ctx }) {')
a='  const selectBatch = (fid, batchId) => guarded(async () => {'
b='  const isolateStale = fid => guarded(async () => {'
start=s.index(a);end=s.index(b,start)
s=s[:start]+'''  const selectBatch = (fid, batchId) => guarded(async () => {
    if (!loaded) throw new Error("\uce21\uc815 \uc790\ub8cc\ub97c \ub2e4\uc2dc \ubd88\ub7ec\uc640\uc8fc\uc138\uc694.");
    if (dirty.current[fid]) await saveDesk(fid);
    const next = await switchShrinkBatch(db, ROOT, fid, serverDesks.current[fid], batchId,
      ctx.isAdmin ? "\uad00\ub9ac\uc790(\uc791\uc5c5 \uc120\ud0dd)" : "\ud604\uc7a5(\uc791\uc5c5 \uc120\ud0dd)");
    analyzedBatch.current = null;
    draftBase.current[fid] = cloneDeep(next);
    serverDesks.current = { ...serverDesks.current, [fid]: next };
    shrinkDesksRef.current = { ...shrinkDesksRef.current, [fid]: next };
    setShrinkDesks(shrinkDesksRef.current);
    setSaveMessage("\uc791\uc5c5 \uc120\ud0dd \uc644\ub8cc. \uc774\uc804 \uc791\uc5c5\uacfc \uc785\ub825\uac12\uc740 \ub300\uae30\uc5f4\uc5d0 \uadf8\ub300\ub85c \ubcf4\uc874\ub429\ub2c8\ub2e4.");
  });
''' + s[end:]
a='  const emptyDesk = () => ({ step: 0, operator: "", memo: "", slotData: {}, queue: [] });'
s=once(s,a,a+'''
  let connectionReview;
  try { connectionReview = reviewShrinkage(wipList, shrinkDesks, furnaces || {}); }
  catch (error) { connectionReview = { batches: [], pending: [], error: error.message, orphanSlotCount: 0, orphanSlotQty: 0 }; }
''')
a='        <fieldset disabled={busy || !loaded || lotSplitModal.isOpen} className="grid grid-cols-1 gap-8">'
panel='''        {loaded && <div className="mb-4 p-4 border rounded-xl bg-amber-50 text-sm space-y-2">
          <h3 className="font-bold">\uc218\ucd95\ub960 \uc791\uc5c5 \uc5f0\uacb0 \uc810\uac80 (\uc870\ud68c \uc804\uc6a9)</h3>
          <p>\uc218\ub7c9 \ud569\uacc4\uac00 \ub9de\uc544\ub3c4 \uc704\uce58 \uc5f0\uacb0\uacfc \uc2e4\uce21 \uae30\ub85d\uc740 \ubcc4\ub3c4 \ud655\uc778\uc774 \ud544\uc694\ud569\ub2c8\ub2e4. \uc5f0\uacb0 \uc815\uc0c1\uc740 \uc2e4\uce21/\ud488\uc9c8 \uc2b9\uc778\uc774 \uc544\ub2d9\ub2c8\ub2e4.</p>
          {connectionReview.error ? <p role="alert">{connectionReview.error}</p> : <>
            <p>\ud604\uc7ac \ub85c\ud2b8 \uc5c6\ub294 \uc704\uce58: {connectionReview.orphanSlotCount}\uacf3 / \uae30\ub85d\uc0c1 {connectionReview.orphanSlotQty}EA (\uc2e4\uc81c \uc7ac\uace0\uc5d0 \ub354\ud558\uc9c0 \uc54a\uc74c)</p>
            {connectionReview.pending.filter(w => w.status !== "linked").map(w => <p key={w.wipId}>{w.mixLot}: \ub85c\ud2b8 {w.quantity ?? "\ud655\uc778 \ud544\uc694"}EA / \uc791\uc5c5 \uc5f0\uacb0 {w.linkedQty}EA / \ud655\uc778 \ud544\uc694</p>)}
            {connectionReview.batches.filter(b => b.slotCount > 0).map(b => <div key={b.key} className="border-t pt-2">
              <strong>{b.fid}\ud638\uae30 {b.active ? "\ud604\uc7ac" : "\ub300\uae30"} / {b.lots.join(", ")} / {b.quantity}EA</strong>
              <p>{b.issues.length ? [...new Set(b.issues.map(i => i.message))].join(" / ") : "\uc704\uce58\uc640 \uc218\ub7c9 \uc5f0\uacb0 \uc815\uc0c1"}</p>
              <p>\uc18c\uacb0 \uc804 \uc2e4\uce21 \ud655\uc778 \ud544\uc694: {b.preMissing}\uacf3 / \uc18c\uacb0 \ud6c4: {b.postMissing}\uacf3</p>
            </div>)}
          </>}
          <p className="font-bold">\uc624\ub798\ub41c \uc791\uc5c5\uc744 \uc0ad\uc81c\ud558\uc9c0 \ub9d0\uace0, \uc544\ub798 \ub300\uae30\uc5f4\uc5d0\uc11c \uc5f0\uacb0\uc774 \ub9de\ub294 \uc0c8 \uc791\uc5c5\uc744 \uc120\ud0dd\ud558\uc138\uc694. \uae30\uc874 \uc791\uc5c5\uacfc \uce21\uc815\uac12\uc740 \ubcf4\uc874\ub429\ub2c8\ub2e4.</p>
        </div>}
'''
s=once(s,a,panel+a)
a='key={b.batchId} onClick={() => selectBatch(id, b.batchId)}'
s=once(s,a,'key={b.batchId} disabled={!connectionReview.batches.some(r => r.fid === String(id) && !r.active && r.batchId === b.batchId && r.selectable)} onClick={() => selectBatch(id, b.batchId)}')
p.write_text(s,encoding='utf-8')
p,s=load('tools/render-smoke.mjs','fe0ce35b344df2853097e380476f30c16a33a5a3')
s=once(s,"import * as status from '../src/mesProcessStatus.mjs';","import * as status from '../src/mesProcessStatus.mjs';\nimport * as shrinkReview from '../src/mesShrinkReview.mjs';\nimport * as shrinkQueue from '../src/mesShrinkQueue.mjs';")
s=once(s,"'./mesProcessStatus.mjs':status,","'./mesProcessStatus.mjs':status,'./mesShrinkReview.mjs':shrinkReview,'./mesShrinkQueue.mjs':shrinkQueue,")
p.write_text(s,encoding='utf-8')
