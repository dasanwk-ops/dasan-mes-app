import { doc, runTransaction } from './mesDatabase.mjs';
import { assertSame, invariant } from './mesSafetyCore.mjs';
import { reviewShrinkage } from './mesShrinkReview.mjs';

// Select an EXISTING queued batch; retain the active one intact in the queue.
// No WIP write, inferred measurement, archival deletion, or automatic repair.
export async function switchShrinkBatch(db, root, fid, expectedDesk, batchId, actor = 'operator') {
  fid=String(fid);
  invariant(['1','2'].includes(fid), 'Invalid furnace.');
  invariant(typeof batchId==='string' && batchId.trim(), 'Missing batch identity.');
  return runTransaction(db, async tx => {
    const ref=doc(db,`${root}/equipment/shrinkDesks`);
    const snap=await tx.get(ref), desks=snap.data()||{}, active=desks[fid];
    assertSame(active,expectedDesk,'\uce21\uc815 \uc791\uc5c5/\ub300\uae30\uc5f4');
    invariant(Array.isArray(active.queue),'\ub300\uae30\uc5f4 \ud655\uc778 \ud544\uc694');
    const matches=active.queue.filter(b=>b?.batchId===batchId);
    invariant(matches.length===1 && active.batchId!==batchId,'\ub300\uae30 \uc791\uc5c5 \ubc88\ud638\uac00 \ubcc0\uacbd\ub418\uc5c8\uac70\ub098 \uc911\ubcf5\ub429\ub2c8\ub2e4.');
    const chosen=matches[0], wips=[];
    for(const id of new Set(Object.values(chosen.slotData||{}).map(s=>String(s?.wipId||'')))) {
      invariant(id && !id.includes('/'),'Invalid WIP identity.');
      const s=await tx.get(doc(db,`${root}/wipList/${id}`));
      if(s.exists()) { invariant(String(s.data().id)===id,'WIP document identity mismatch.');wips.push(s.data()); }
    }
    const fs=await tx.get(doc(db,`${root}/equipment/furnaces`));
    const review=reviewShrinkage(wips,desks,fs.data()||{});
    const target=review.batches.find(r=>r.fid===fid&&!r.active&&r.batchId===batchId);
    invariant(target?.selectable, '\uc120\ud0dd\ud55c \uc791\uc5c5\uc740 \uc5f0\uacb0 \ud655\uc778\uc774 \ud544\uc694\ud569\ub2c8\ub2e4: '+(target?.issues.map(i=>i.message).join(', ')||'\uc791\uc5c5 \uc5c6\uc74c'));
    const queue=active.queue.filter(b=>b!==chosen);
    const {queue: ignored,...old}=active;
    if(Object.keys(old.slotData||{}).length) queue.unshift(old);
    const next={...chosen,queue};
    tx.annotate({kind:'select-shrink-batch',furnaceId:fid,fromBatchId:active.batchId||'',toBatchId:batchId,preservedOldBatch:true});
    tx.set(ref,{...desks,[fid]:next});
    return next;
  },{label:'\uc218\ucd95\ub960 \ub300\uae30 \uc791\uc5c5 \uc120\ud0dd (\uae30\uc874 \uc6d0\ubcf8 \ubcf4\uc874)',actor});
}
