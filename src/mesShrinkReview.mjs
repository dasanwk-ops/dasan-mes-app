// Read-only structural diagnosis. A valid link is NOT quality approval.
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => String(v ?? '').trim();
const qty = v => ((typeof v === 'number' || typeof v === 'string') && text(v) !== '' && Number.isSafeInteger(Number(v)) && Number(v) >= 0) ? Number(v) : null;
const type = v => /^(345|234)\s/.test(text(v)) ? text(v) : `345 ${text(v)}`;
const msg = {
  empty: '\ube48 \uc791\uc5c5', identity: '\uc791\uc5c5 \ubc88\ud638 \ud655\uc778 \ud544\uc694',
  malformed: '\uc791\uc5c5 \uc790\ub8cc \ud615\uc2dd \ud655\uc778 \ud544\uc694',
  missing: '\uc5f0\uacb0\ub41c \ud604\uc7ac \ub85c\ud2b8 \uc5c6\uc74c', step: '\uc218\ucd95\ub960 \uce21\uc815 \ub300\uae30\uac00 \uc544\ub2cc \ub85c\ud2b8',
  quantity: '\ub85c\ud2b8\uc640 \uc704\uce58\ubcc4 \uc218\ub7c9 \ubd88\uc77c\uce58', product: '\ub85c\ud2b8/\uc81c\ud488 \uc5f0\uacb0 \ubd88\uc77c\uce58',
  duplicate: '\ub2e4\ub978 \uce21\uc815 \uc791\uc5c5\uc5d0\ub3c4 \ub3d9\uc77c \ub85c\ud2b8 \uc5f0\uacb0',
  furnace: '\uc804\uae30\ub85c\uc5d0 \uc544\uc9c1 \uc5f0\uacb0\ub41c \ub85c\ud2b8', position: '\uc5f4\ucc98\ub9ac \uc704\uce58 \uae30\ub85d \ubd88\uc77c\uce58'
};
export function reviewShrinkage(wipList = [], desks = {}, furnaces = {}) {
  if (!Array.isArray(wipList) || !record(desks) || !record(furnaces)) throw new Error(msg.malformed);
  const wips = new Map();
  for (const w of wipList) {
    if (!record(w) || !text(w.id) || wips.has(text(w.id))) throw new Error(msg.identity);
    wips.set(text(w.id), w);
  }
  const batches = [], references = new Map(), ids = new Map();
  for (const [fid, desk] of Object.entries(desks)) {
    if (!['1','2'].includes(fid) || !record(desk) || (desk.queue !== undefined && !Array.isArray(desk.queue))) throw new Error(msg.malformed);
    for (const [index, batch] of [desk, ...(desk.queue || [])].entries()) {
      if (!record(batch) || !record(batch.slotData) || (index > 0 && batch.queue !== undefined)) throw new Error(msg.malformed);
      const slots = Object.entries(batch.slotData);
      const key = `${fid}:${index}`;
      const r = {key, fid, index, batchId:text(batch.batchId), active:index === 0, quantity:0, slotCount:slots.length, issues:[], preMissing:0, postMissing:0, lots:[], selectable:false};
      const issue = (code, id='') => { if (!r.issues.some(i=>i.code===code && i.wipId===id)) r.issues.push({code,wipId:id,message:msg[code]}); };
      r.addIssue = issue;
      if (!slots.length) issue('empty');
      if (slots.length && (!r.batchId || ![1,2].includes(batch.step))) issue('identity');
      if (r.batchId) ids.set(r.batchId,[...(ids.get(r.batchId)||[]),r]);
      const grouped = new Map();
      for (const [sid,s] of slots) {
        if (!record(s)) { issue('malformed'); continue; }
        const id=text(s.wipId), n=qty(s.qty);
        if (!id) issue('identity');
        if (!/^[LR][1-6]$/.test(sid) || (s.furnaceId !== undefined && text(s.furnaceId)!==fid) || (s.furnaceSlotId !== undefined && text(s.furnaceSlotId)!==sid)) issue('position',id);
        if (n === null || n === 0) issue('quantity',id); else r.quantity += n;
        if (!grouped.has(id)) grouped.set(id,[]);
        grouped.get(id).push({sid,s});
        if (!references.has(id)) references.set(id,[]);
        references.get(id).push({key,fid,batchId:r.batchId,slotId:sid,qty:n});
        r.lots.push(text(s.mixLot)||id);
        const m=Array.isArray(s.measurements)?s.measurements:[];
        if (!m.length || m.some(v=>!record(v)||!text(v.position)||!Number.isFinite(Number(v.preArea))||Number(v.preArea)<=0)) r.preMissing++;
        if (!m.length || m.some(v=>!record(v)||!text(v.position)||!Number.isFinite(Number(v.postArea))||Number(v.postArea)<=0||Number(v.postArea)>=Number(v.preArea))) r.postMissing++;
      }
      for (const [id, entries] of grouped) {
        const w=wips.get(id);
        if (!w) { issue('missing',id); continue; }
        if (w.currentStep !== 'step5_shrink') issue('step',id);
        const sum=entries.reduce((a,e)=>a+(qty(e.s.qty)||0),0);
        if (qty(w.qty)===null || qty(w.qty)===0 || sum!==qty(w.qty)) issue('quantity',id);
        if (entries.some(({s})=>text(s.mixLot)!==text(w.mixLot)||type(s.type)!==type(w.type)||text(s.height)!==text(w.height))) issue('product',id);
        if (Array.isArray(w.furnaceSlots) && w.furnaceSlots.length) {
          const positions=w.furnaceSlots;
          if (w.slotAllocationNeedsReview || positions.length!==entries.length || new Set(positions.map(p=>p?.slotId)).size!==positions.length || positions.some(p=>!p||text(p.furnaceId??p.fid)!==fid||!entries.some(e=>e.sid===p.slotId && qty(e.s.qty)===qty(p.qty)))) issue('position',id);
        }
        if (Object.values(furnaces).some(f=>record(f)&&Object.values(f.slotData||{}).some(s=>s&&text(s.wipId)===id))) issue('furnace',id);
      }
      r.lots=[...new Set(r.lots)]; batches.push(r);
    }
  }
  for (const group of ids.values()) if(group.length>1) group.forEach(r=>r.addIssue('identity'));
  for (const [id,refs] of references) if(new Set(refs.map(s=>s.key)).size>1) for(const r of batches) if(refs.some(s=>s.key===r.key)) r.addIssue('duplicate',id);
  for (const r of batches) { r.selectable=r.issues.length===0; delete r.addIssue; }
  const pending=[...wips.values()].filter(w=>w.currentStep==='step5_shrink').map(w=>{
    const refs=references.get(text(w.id))||[], total=qty(w.qty);
    const linkedQty=refs.reduce((a,r)=>a+(r.qty||0),0);
    return {wipId:text(w.id),mixLot:text(w.mixLot),quantity:total,linkedQty,unlinkedQty:total===null?null:Math.max(0,total-linkedQty),status:!refs.length?'unregistered':total===null||refs.some(r=>r.qty===null)||linkedQty!==total?'quantity-mismatch':new Set(refs.map(r=>r.key)).size>1?'multiple-batches':'linked'};
  });
  const orphanSlots=[...references.entries()].filter(([id])=>!wips.has(id)).flatMap(([wipId,refs])=>refs.map(r=>({...r,wipId})));
  return {batches,pending,orphanSlotCount:orphanSlots.length,orphanSlotQty:orphanSlots.reduce((a,s)=>a+(s.qty||0),0)};
}
