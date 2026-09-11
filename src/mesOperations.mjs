import { collection, doc, runTransaction, serverTimestamp } from './mesDatabase.mjs';
import { invariant, quantity, optionalQuantity, positiveNumber, requiredText, shrinkage, canonical, assertSame, assertWip, normalType, kst, uid, packDate, packNumber, invalidateLabel, defectsFor, allFurnaceSlots, allDeskSlots, validateAllocated, clonePlain, STEPS, printFingerprint, manufactureDate } from './mesSafetyCore.mjs';

export function createOperations(db, root, isAdmin = () => false) {
  const ref = (name,id) => doc(db, `${root}/${name}/${id}`);
  const col = name => collection(db, `${root}/${name}`);
  const transact = (label, actor, action) => runTransaction(db, action, {label, actor});
  const activeData = snap => snap.exists() ? snap.data() : null;
  async function readWip(tx, expected, step = expected?.currentStep) {
    invariant(expected?.id, '대상 로트를 다시 선택하세요.');
    const r = ref('wipList',expected.id); const snap = await tx.get(r);
    const w = activeData(snap); assertWip(w,expected,step); return {r,w};
  }
  async function equipment(tx) {
    const f = await tx.get(ref('equipment','furnaces'));
    const s = await tx.get(ref('equipment','shrinkDesks'));
    const d = await tx.get(ref('equipment','dryingRoom'));
    return {furnaces:f.data()||{}, desks:s.data()||{}, room:d.data()||{}};
  }
  function requireAdmin() { invariant(isAdmin(), '관리자 모드에서만 실행할 수 있습니다.'); }
  function append(w, text) { return `${w.details || ''}\n[${kst()}] ${text}`.trim(); }
  async function lookupAllocated(tx, furnaces) {
    const found = new Map();
    for (const s of allFurnaceSlots(furnaces)) if (!found.has(String(s.wipId))) { const snap = await tx.get(ref('wipList',s.wipId)); found.set(String(s.wipId),snap.data()); }
    return found;
  }
  function notAllocated(eq, w, label = '이동') {
    invariant(!allFurnaceSlots(eq.furnaces).some(s=>s.wipId===w.id), `전기로에 연결된 로트는 ${label}할 수 없습니다. 배정/가동 상태를 먼저 정리하세요.`);
    invariant(!allDeskSlots(eq.desks).some(s=>s.wipId===w.id), `수축률 작업에 연결된 로트는 ${label}할 수 없습니다. 측정 원본을 먼저 보관/정리하세요.`);
    invariant(![...(eq.room.dryingWipIds || []), ...(eq.room.cartItems||[]).map(x=>typeof x==='string'?x:x.wipId||x.id)].includes(w.id), `건조 작업에 연결된 로트는 ${label}할 수 없습니다.`);
  }
  async function advance(expected, nextStep, {defects=0, reason='', operator='', note='', patch={}} = {}) {
    requiredText(operator,'작업자');
    const pairs = {step1:'step2', step2:'step3', step3:'step4', step6:'step7'};
    invariant(pairs[expected.currentStep] === nextStep, '허용되지 않은 공정 이동입니다.');
    return transact(`공정 완료 ${expected.currentStep} -> ${nextStep}`,operator,async tx => {
      const {r,w} = await readWip(tx,expected); notAllocated(await equipment(tx),w); const bad = defectsFor(w,defects,reason);
      const n = quantity(w.qty)-bad;
      tx.annotate({kind:'process-complete',from:w.currentStep,to:nextStep,defects:bad,reason,note,operator});
      const next = {...patch, qty:n,currentStep:nextStep,details:append(w,note || `[공정 완료] ${nextStep} | 불량:${bad} | 사유:${reason} | 담당:${operator}`)};
      invariant(!('id' in patch) && !('mixLot' in patch), '식별자는 변경할 수 없습니다.');
      if (n === 0) tx.delete(r); else tx.update(r,next);
      return {...w,...next};
    });
  }
  async function firstMolding(expected, {actualQty, defects, defectReason, operator, note}) {
    const q = quantity(actualQty,'실 성형수량'); const bad = optionalQuantity(defects);
    requiredText(operator,'작업자'); if (q !== Number(expected.qty)) requiredText(note,'성형 수량이 달라진 사유/메모');
    invariant(bad<=q,'불량 수량이 성형 수량보다 많습니다.'); if (bad) requiredText(defectReason,'불량 사유');
    return transact('1차 성형 완료',operator,async tx=>{
      const {r,w}=await readWip(tx,expected,'step3'); notAllocated(await equipment(tx),w);
      tx.annotate({kind:'first-molding',beforeQty:w.qty,actualQty:q,defects:bad,reason:defectReason||'',operator,note:note||''});
      const details=append(w,`${note} | 성형수량:${q} | 이전수량:${w.qty} | 불량:${bad} (${defectReason||'-'}) | 담당:${operator}`);
      const patch={qty:q-bad,currentStep:'step4',details};
      if(q===bad) tx.delete(r); else tx.update(r,patch);
      return {...w,...patch};
    });
  }
  async function splitMolding(expected, data) {
    const a=optionalQuantity(data.qtyA,'A 정상'), b=optionalQuantity(data.qtyB,'B 정상'), da=optionalQuantity(data.defectA,'A 불량'), dbad=optionalQuantity(data.defectB,'B 불량');
    requiredText(data.operator,'작업자'); if(da) requiredText(data.defectReasonA,'A 불량 사유'); if(dbad) requiredText(data.defectReasonB,'B 불량 사유');
    const idA=uid('wipA'),idB=uid('wipB');
    return transact('2차 성형 분할 완료',data.operator,async tx=>{
      const {r,w}=await readWip(tx,expected,'step4'); notAllocated(await equipment(tx),w);
      invariant(a+b+da+dbad===quantity(w.qty),'A/B 정상+불량 합계가 최신 로트 수량과 다릅니다.');
      tx.annotate({kind:'second-molding',normalA:a,normalB:b,defectA:da,defectB:dbad,reasonA:data.defectReasonA||'',reasonB:data.defectReasonB||'',operator:data.operator});
      const children=[];
      for(const [suffix,q,id,note] of [['A',a,idA,data.noteA],['B',b,idB,data.noteB]]) if(q>0) {
        const child={...w,...invalidateLabel(),id,qty:q,mixLot:`${w.mixLot}-${suffix}`,parentWipIds:[w.id],productionLot:w.productionLot||w.mixLot,currentStep:'step5',shrinkageRate:'',details:append(w,note||`[2차성형 ${suffix}] 담당:${data.operator}`)};
        tx.set(ref('wipList',id),child);children.push(child);
      }
      tx.delete(r); return children;
    });
  }
  async function allocateSlot(fid,slotId,expectedSlot,wip,amount) {
    fid=String(fid); invariant(['1','2'].includes(fid)&&/^[LR][1-6]$/.test(slotId),'전기로 위치가 잘못되었습니다.');
    if(wip) quantity(amount,'배정 수량',false);
    return transact(wip?'전기로 배정':'전기로 배정 해제','현장',async tx=>{
      const r=ref('equipment','furnaces'),snap=await tx.get(r),all=snap.data()||{}; const f=all[fid];
      invariant(f&&!f.isHeating,'가동 중이거나 존재하지 않는 전기로입니다.');
      invariant(canonical(f.slotData?.[slotId]||null)===canonical(expectedSlot||null),'선택한 칸의 배정이 변경되었습니다.');
      const next=clonePlain(all);
      next[fid].slotData={...(f.slotData||{})};
      if(wip){
        invariant(!f.slotData?.[slotId],'이미 제품이 배정된 칸입니다.');
        const {w}=await readWip(tx,wip,'step5');
        next[fid].slotData[slotId]={wipId:w.id,mixLot:w.mixLot,type:w.type,height:w.height,qty:quantity(amount)};
      } else { invariant(f.slotData?.[slotId],'이미 비어 있는 칸입니다.'); delete next[fid].slotData[slotId]; }
      const wips=await lookupAllocated(tx,next); validateAllocated(next,wips);
      tx.set(r,next);
    });
  }
  async function furnaceField(fid,field,value,expectedValue) {
    invariant(['temp','operator','memo'].includes(field),'수정할 수 없는 전기로 항목입니다.');
    if(field==='temp') positiveNumber(value,'전기로 온도');
    return transact('전기로 설정 저장','현장',async tx=>{
      const r=ref('equipment','furnaces'),s=await tx.get(r),all=s.data()||{},f=all[fid];
      invariant(f,'전기로가 없습니다.'); invariant(!f.isHeating||field==='memo','가동 중에는 온도/담당자를 바꿀 수 없습니다.');
      invariant(canonical(f[field]??'')===canonical(expectedValue??''),'같은 설정이 다른 화면에서 변경되었습니다.');
      tx.update(r,{[`${fid}.${field}`]:value});
    });
  }
  async function startHeat(fid,expected) {
    return transact('열처리 시작',expected.operator,async tx=>{
      const r=ref('equipment','furnaces'),s=await tx.get(r),all=s.data()||{},f=all[fid];
      assertSame(f,expected,'전기로'); invariant(!f.isHeating,'이미 가동 중입니다.'); requiredText(f.operator,'작업자'); positiveNumber(f.temp,'가동 온도');
      const own=Object.values(f.slotData||{}); invariant(own.length,'배정된 제품이 없습니다.');
      const wips=await lookupAllocated(tx,all); validateAllocated(all,wips);
      const ids=new Set(own.map(x=>x.wipId));
      for(const id of ids){
        invariant(!allFurnaceSlots(all).some(s=>s.wipId===id&&s.fid!==String(fid)),'같은 로트를 여러 전기로에 나누어 가동할 수 없습니다. 로트를 먼저 분할하세요.');
        invariant(own.filter(s=>s.wipId===id).reduce((n,s)=>n+quantity(s.qty),0)===quantity(wips.get(id).qty),'로트 전체 수량을 배정한 뒤 가동하세요.');
      }
      tx.set(r,{...all,[fid]:{...f,isHeating:true,startedAt:kst(),runId:uid('heat')}});
    });
  }
  async function finishHeat(fid,expected) {
    const batchId=uid('heat-finished');
    return transact('열처리 완료',expected.operator,async tx=>{
      const r=ref('equipment','furnaces'),s=await tx.get(r),all=s.data()||{},f=all[fid];
      assertSame(f,expected,'전기로'); invariant(f.isHeating,'이미 종료된 가동입니다.');
      const sr=ref('equipment','shrinkDesks'),ss=await tx.get(sr),desks=ss.data()||{};
      const wips=await lookupAllocated(tx,all);validateAllocated(all,wips);
      const own=Object.entries(f.slotData||{}),ids=new Set(own.map(([,s])=>s.wipId)); invariant(own.length,'전기로가 비어 있습니다.');
      for(const id of ids){
        invariant(!allFurnaceSlots(all).some(s=>s.wipId===id&&s.fid!==String(fid)),'다른 전기로에도 같은 로트가 연결되어 있습니다.');
        invariant(!allDeskSlots(desks).some(s=>s.wipId===id),'수축률 작업에 이미 같은 로트가 등록되어 있습니다.');
        invariant(own.filter(([,s])=>s.wipId===id).reduce((n,[,s])=>n+quantity(s.qty),0)===quantity(wips.get(id).qty),'전기로 수량과 로트 수량이 다릅니다.');
      }
      const now=kst(),results=[];
      for(const id of ids){
        const w=wips.get(id),positions=own.filter(([,s])=>s.wipId===id).map(([slotId,s])=>({furnaceId:String(fid),slotId,slotLabel:slotId,qty:quantity(s.qty)}));
        const patch={currentStep:'step5_shrink',shrinkageRate:'',furnaceSlots:positions,heatTreatmentHistory:[...(w.heatTreatmentHistory||[]),{furnaceId:String(fid),startedAt:f.startedAt||'',completedAt:now,temperature:f.temp,operator:f.operator,memo:f.memo||'',slots:positions,runId:f.runId||''}],details:append(w,`[열처리완료] ${fid}호기 | 담당:${f.operator} | 위치:${positions.map(p=>`${p.slotId}(${p.qty})`).join(', ')} | 온도:${f.temp}`)};
        tx.update(ref('wipList',id),patch);results.push({...w,...patch});
      }
      const incoming={batchId,revision:0,createdAt:now,step:1,operator:f.operator||'',memo:f.memo||'',slotData:Object.fromEntries(own.map(([sid,s])=>[sid,{...s,furnaceId:String(fid),furnaceSlotId:sid,heatStartedAt:f.startedAt||'',heatCompletedAt:now,heatTemperature:f.temp,measurements:[{position:'',preArea:'',postArea:'',calcShrink:'',calcExpand:''}]}]))};
      const active=desks[fid]||{}, waiting=[...(active.queue||[])];
      const nd=Object.keys(active.slotData||{}).length?{...active,queue:[...waiting,incoming]}:(waiting.length?{...waiting.shift(),queue:[...waiting,incoming]}:{...incoming,queue:[]});
      tx.set(sr,{...desks,[fid]:nd});
      tx.set(r,{...all,[fid]:{isHeating:false,temp:f.temp,operator:'',memo:'',slotData:{},startedAt:''}});
      return results;
    });
  }
  async function roomField(field,value,expectedValue) {
    invariant(['temp','humidity','operator'].includes(field),'수정할 수 없는 건조 설정입니다.');
    if(field!=='operator'){ const n=positiveNumber(value,field==='temp'?'건조 온도':'습도',field==='humidity');if(field==='humidity') invariant(n<=100,'습도는 100 이하로 입력하세요.'); }
    return transact('건조실 설정','현장',async tx=>{
      const r=ref('equipment','dryingRoom'),s=await tx.get(r),room=s.data()||{};
      invariant(canonical(room[field]??'')===canonical(expectedValue??''),'건조실 설정이 다른 화면에서 변경되었습니다.');
      tx.set(r,{...room,[field]:value});
    });
  }
  async function dryStart(expected) {
    return transact('건조 시작','현장',async tx=>{
      const {r,w}=await readWip(tx,expected,'step7'),rr=ref('equipment','dryingRoom'),s=await tx.get(rr),room=s.data()||{};
      requiredText(room.operator,'건조 작업자');positiveNumber(room.temp,'건조 온도');
      tx.update(r,{currentStep:'step7_drying',details:append(w,`[건조시작] 담당:${room.operator}`)});
      tx.set(rr,{...room,dryingWipIds:[...new Set([...(room.dryingWipIds||[]),w.id])]});
    });
  }
  async function dryField(id,field,value,expectedValue) {
    invariant(['defects','reason','specialNote'].includes(field),'수정할 수 없는 항목입니다.');
    if(field==='defects')optionalQuantity(value);
    return transact('건조 입력 저장','현장',async tx=>{
      const ws=await tx.get(ref('wipList',id)),w=ws.data();invariant(w?.currentStep==='step7_drying','현재 건조 중인 로트가 아닙니다.');
      const rr=ref('equipment','dryingRoom'),s=await tx.get(rr),room=s.data()||{},d=room.completionData?.[id]||{};
      invariant(canonical(d[field]??'')===canonical(expectedValue??''),'해당 건조 입력값이 다른 화면에서 변경되었습니다.');
      tx.set(rr,{...room,completionData:{...(room.completionData||{}),[id]:{...d,[field]:value}}});
    });
  }
  async function dryComplete(expected,expectedData) {
    const date=packDate();
    return transact('건조 완료 및 포장 이관','현장',async tx=>{
      const {r,w}=await readWip(tx,expected,'step7_drying'),rr=ref('equipment','dryingRoom'),s=await tx.get(rr),room=s.data()||{},d=room.completionData?.[w.id]||{};
      invariant(canonical(d)===canonical(expectedData||{}),'건조 입력값이 변경되었습니다. 화면을 확인하세요.');
      requiredText(room.operator,'건조 작업자');const bad=defectsFor(w,d.defects,d.reason),nextQty=quantity(w.qty)-bad;
      const cr=ref('systemCounters',`packLot-${date}`),cs=await tx.get(cr);const seq=quantity(cs.data()?.lastSeq??0,'포장 번호')+1;
      tx.annotate({kind:'drying-complete',defects:bad,reason:d.reason||'',operator:room.operator});
      const pack=w.packLot||packNumber(date,seq),now=kst();
      const next={...invalidateLabel(),qty:nextQty,currentStep:'step8',packLot:pack,packLotCreatedAt:w.packLotCreatedAt||now,details:append(w,`[건조완료] 온도:${room.temp} | 습도:${room.humidity} | 담당:${room.operator} | 불량:${bad} (${d.reason||'-'}) | ${d.specialNote||''}`)};
      const completionData={...(room.completionData||{})};delete completionData[w.id];
      if(nextQty===0)tx.delete(r);else { if(!w.packLot)tx.set(cr,{dateKey:date,lastSeq:seq,updatedAt:now},{merge:true});tx.update(r,next); }
      tx.set(rr,{...room,completionData,dryingWipIds:(room.dryingWipIds||[]).filter(x=>x!==w.id),cartItems:(room.cartItems||[]).filter(x=>(typeof x==='string'?x:x.wipId||x.id)!==w.id)});
      return {...w,...next};
    });
  }
  async function ensurePack(id) {
    const date=packDate();
    return transact('포장 LOT 발급','현장',async tx=>{
      const wr=ref('wipList',id),ws=await tx.get(wr),w=ws.data();
      invariant(w&&['step8','step7_drying'].includes(w.currentStep),'포장 LOT 발급 대상 공정이 아닙니다.');
      if(w.packLot)return w.packLot;
      const cr=ref('systemCounters',`packLot-${date}`),cs=await tx.get(cr),seq=quantity(cs.data()?.lastSeq??0,'포장 번호')+1,pack=packNumber(date,seq);
      tx.set(cr,{dateKey:date,lastSeq:seq,updatedAt:kst()},{merge:true});tx.update(wr,{packLot:pack,packLotCreatedAt:kst()});return pack;
    });
  }
  async function cancelOrEdit(expected,{cancel=false,qty=expected.qty,step=expected.currentStep,reason,operator,notes='',shrinkageRate=expected.shrinkageRate??''}) {
    requireAdmin();requiredText(reason,'관리자 변경 사유');requiredText(operator,'관리자 성명');
    const q=quantity(qty);invariant(STEPS.includes(step),'선택한 공정이 올바르지 않습니다.');
    return transact(cancel?'관리자 취소 (원본 보관)':'관리자 수량/공정 보정',operator,async tx=>{
      const {r,w}=await readWip(tx,expected);const eq=await equipment(tx);
      const shipments=await tx.list(col('shippingHistory'));
      const linkedShipments=shipments.filter(s=>{const h=s.data();return h.sourceWipId===w.id||[h.productionLot,h.originalLot,h.lot].includes(w.mixLot);});
      tx.annotate({kind:cancel?'cancel':'admin-correction',operator,reason,from:w.currentStep,to:step,beforeQty:w.qty,afterQty:cancel?0:q});
      const structural=cancel||q!==Number(w.qty)||step!==w.currentStep;
      if ((structural || shrinkageRate!==(w.shrinkageRate??'')) && w.labelJobId && !w.physicalLabelConfirmedAt) {
        const js=await tx.get(doc(db,`print-queue/${w.labelJobId}`));
        invariant(js.exists() && ['completed','done','printed'].includes(js.data().status), '라벨 출력 요청이 남아 있습니다. 프린터 처리 결과와 기출력 라벨 회수를 먼저 확인하세요.');
        invariant(reason.includes('라벨'), '라벨 회수 확인 내용을 변경 사유에 기록하세요.');
      }
      if(cancel)invariant(!linkedShipments.length,'출고 이력이 있는 로트는 취소할 수 없습니다. 잔여 재고를 보정하고 출고 원본은 보존하세요.');
      if(!cancel){
        invariant(STEPS.indexOf(step)<=STEPS.indexOf(w.currentStep),'관리자 보정으로 미완료 공정을 건너뛸 수 없습니다.');
        invariant(!(STEPS.indexOf(w.currentStep)>=2&&STEPS.indexOf(step)<2),'원재료를 이미 사용한 로트를 배합 이전으로 되돌릴 수 없습니다. 원재료가 이중 차감될 수 있습니다. 1차 성형 이후로 되돌리세요.');
        if(shrinkageRate!=='')shrinkage(shrinkageRate);
      }
      const ownF=allFurnaceSlots(eq.furnaces).filter(s=>s.wipId===w.id);
      if(structural)invariant(!ownF.some(s=>s.isHeating)&&w.currentStep!=='step7_drying','실제 가동/건조 중인 로트입니다. 장비 작업 종료를 확인한 다음 보정하세요.');
      // Quantities of already-measured slots must not be redistributed by guesswork.
      const ownS=allDeskSlots(eq.desks).filter(s=>s.wipId===w.id);
      if(!cancel&&q!==Number(w.qty)&&step===w.currentStep)invariant(!ownF.length&&!ownS.length,'장비에 배정된 로트 수량은 단독 변경할 수 없습니다. 배정 해제 또는 이전 공정으로 되돌린 후 수정하세요.');
      let nextF=clonePlain(eq.furnaces),nextS=clonePlain(eq.desks),nextR=clonePlain(eq.room);
      if(structural&&(cancel||step!==w.currentStep)){
        for(const f of Object.values(nextF))if(f&&typeof f==='object')for(const [sid,s]of Object.entries(f.slotData||{}))if(s.wipId===w.id)delete f.slotData[sid];
        for(const [fid,d]of Object.entries(nextS)){
          if(!d||typeof d!=='object'||![d,...(d.queue||[])].some(b=>Object.values(b.slotData||{}).some(x=>x.wipId===w.id)))continue;
          const batches=[d,...(d.queue||[])].map(b=>{
            const {queue:ignored,...rest}=b;const slots=Object.fromEntries(Object.entries(b.slotData||{}).filter(([,s])=>s.wipId!==w.id));
            const changed=Object.keys(slots).length!==Object.keys(b.slotData||{}).length;
            return changed?{...rest,slotData:slots,revision:(b.revision||0)+1,stageIssues:(b.stageIssues||[]).filter(x=>x.wipId!==w.id),savedAt:kst()}:rest;
          }).filter(b=>Object.keys(b.slotData).length);
          nextS[fid]=batches.length?{...batches[0],queue:batches.slice(1)}:{step:0,slotData:{},queue:[],memo:'',operator:'',revision:(d.revision||0)+1};
        }
        nextR.dryingWipIds=(nextR.dryingWipIds||[]).filter(x=>x!==w.id);
        nextR.cartItems=(nextR.cartItems||[]).filter(x=>(typeof x==='string'?x:x.wipId||x.id)!==w.id);
        nextR.completionData={...(nextR.completionData||{})};delete nextR.completionData[w.id];
      }
      if(cancel)tx.delete(r);
      else {
        const rollback=step!==w.currentStep;
        let patch={qty:q,currentStep:step,shrinkageRate,details:append(w,`[관리자 보정] ${w.qty} -> ${q}EA | ${w.currentStep} -> ${step} | 사유:${reason} | 담당:${operator}${notes&&notes!==w.details?` | 정정 의견:${notes}`:''}`),lastQtyCorrection:{before:Number(w.qty),after:q,reason,correctedAt:kst(),correctedBy:operator}};
        if(structural||shrinkageRate!==(w.shrinkageRate??''))Object.assign(patch,invalidateLabel());
        if(rollback){
          patch.furnaceSlots=[];patch.slotAllocationNeedsReview=false;
          if(STEPS.indexOf(step)<=STEPS.indexOf('step5_shrink'))patch.shrinkageRate='';
          patch.rework={from:w.currentStep,to:step,at:kst(),reason,operator};
        } else if(q!==Number(w.qty)&&(w.furnaceSlots||[]).length)patch.slotAllocationNeedsReview=true;
        if(q!==Number(w.qty)&&['step1','step2'].includes(w.currentStep))patch.weight=q?((Number(w.singleWeight)*q/1000)*1.01+0.2).toFixed(3):'0.000';
        tx.update(r,patch);
      }
      if(canonical(nextF)!==canonical(eq.furnaces))tx.set(ref('equipment','furnaces'),nextF);
      if(canonical(nextS)!==canonical(eq.desks))tx.set(ref('equipment','shrinkDesks'),nextS);
      if(canonical(nextR)!==canonical(eq.room))tx.set(ref('equipment','dryingRoom'),nextR);
    });
  }
  async function ship(expected,{qty,operator,destination,sample=false}) {
    const amount=quantity(qty,'출고 수량',false);requiredText(operator,'작업자');requiredText(destination,'출고처');
    const hid=uid(sample?'sample':'ship');
    return transact(sample?'샘플 출고':'완제품 출고',operator,async tx=>{
      const {r,w}=await readWip(tx,expected);const eq=await equipment(tx);notAllocated(eq,w,'출고');
      invariant(sample?['step6','step7','step8','done'].includes(w.currentStep):w.currentStep==='done',sample?'검수 이후 보관 중인 제품만 샘플 출고할 수 있습니다.':'완제품만 일반 출고할 수 있습니다.');
      invariant(amount<=quantity(w.qty),'출고 수량이 최신 재고보다 많습니다.');
      const remaining=Number(w.qty)-amount,now=kst(),pack=w.packLot||(/^F/i.test(w.mixLot)?w.mixLot:'');
      tx.set(ref('shippingHistory',hid),{id:hid,sourceWipId:w.id,stockBeforeQty:Number(w.qty),remainingQty:remaining,orderId:w.orderId||'',lot:pack||w.mixLot,packLot:pack,originalLot:w.mixLot,productionLot:w.productionLot||(/^MIX-/.test(w.mixLot)?w.mixLot:''),type:w.type,height:w.height,weight:w.weight||'',qty:amount,destination,operator,date:now.slice(0,16),actualShipmentAt:now,shipmentKind:sample?'sample':'finished',sourceStep:w.currentStep,details:append(w,`[${sample?'샘플발송':'출고'}] ${amount}EA | 담당:${operator} | 출고처:${destination}`),createdAt:serverTimestamp()});
      if(remaining===0)tx.delete(r);else tx.update(r,{qty:remaining,details:append(w,`[${sample?'샘플발송':'출고'}] ${amount}EA | 잔량:${remaining}EA | 담당:${operator}`),...invalidateLabel()});
      return hid;
    });
  }
  async function release(order,qty) {
    const amount=quantity(qty,'투입 수량',false),id=uid('wip'),date=packDate();
    return transact('생산 지시 투입','현장',async tx=>{
      const r=ref('orderList',order.id),os=await tx.get(r);assertSame(os.data(),order,'생산 지시');invariant(os.data().status!=='취소','취소된 생산 지시입니다.');
      const ws=await tx.list(col('wipList')),hs=await tx.list(col('shippingHistory'));
      const covered=[...ws,...hs].map(s=>s.data()).filter(x=>x.orderId===order.id).reduce((n,x)=>n+quantity(x.qty),0);
      invariant(amount<=Math.max(0,quantity(order.qty)-covered),'추가 생산 필요 수량이 변경되었습니다. 중복 투입을 중단합니다.');
      const cr=ref('systemCounters',`mixLot-${date}`),cs=await tx.get(cr);let seq=quantity(cs.data()?.lastSeq??0,'MIX 번호');
      const used=new Set([...ws,...hs].flatMap(s=>{const w=s.data();return[w.mixLot,w.productionLot,w.originalLot,w.lot].filter(Boolean);}));
      const archives=await tx.list(col('wipArchive'));archives.forEach(s=>used.add(s.data().mixLot));
      let lot;do{seq+=1;lot=`MIX-${date}-${String(seq).padStart(3,'0')}`;}while([...used].some(x=>x===lot||x.startsWith(lot+'-')));
      const w={id,orderId:order.id,mixLot:lot,type:normalType(order.color),height:order.height,singleWeight:order.singleWeight,qty:amount,currentStep:'step1',details:`[${kst()}] 지시분할투입 (원본:${order.orderNo})`};
      tx.set(cr,{lastSeq:seq,dateKey:date},{merge:true});tx.set(ref('wipList',id),w);return w;
    });
  }
  async function cancelOrder(expected) {
    return transact('생산 지시 취소','현장',async tx=>{
      const r=ref('orderList',expected.id),s=await tx.get(r);assertSame(s.data(),expected,'생산 지시');
      const ws=await tx.list(col('wipList')),hs=await tx.list(col('shippingHistory'));
      invariant(![...ws,...hs].some(s=>s.data().orderId===expected.id),'현재 생산/출고가 연결된 지시는 취소할 수 없습니다.');
      tx.update(r,{status:'취소',cancelledAt:kst()});
    });
  }
  async function inbound(items) {
    invariant(items.length>0&&items.length<=70,'입고 항목 수를 확인하세요.');
    const prepared=items.map(i=>({...i,lot:requiredText(i.lot,'원료 LOT'),weight:positiveNumber(i.weight,'입고 중량'),id:uid('inv'),hid:uid('inh')}));
    return transact('원재료 일괄 입고','현장',async tx=>{
      const now=kst();
      for(const i of prepared){
        tx.set(ref('inventory',i.id),{id:i.id,lot:i.lot,type:i.type,weight:i.weight,date:now.slice(0,10),status:'입고완료',createdAt:serverTimestamp()});
        tx.set(ref('inventoryHistory',i.hid),{id:i.hid,date:now.slice(0,16),type:'IN',materialType:i.type,lot:i.lot,qty:i.weight,note:'일괄입고',createdAt:serverTimestamp()});
      }
    });
  }
  async function requestPrint(expected,{defects=0,payload}) {
    const jobId=uid('label');
    return transact('라벨 출력 요청','현장',async tx=>{
      const {r,w}=await readWip(tx,expected,'step8');
      invariant(!w.stocktakeRecovery?.needsHeatHistory&&!w.stocktakeRecovery?.needsShrinkageData,'실사 복구된 로트의 열처리/수축률 원기록 확인이 먼저 필요합니다.');
      const fingerprint=printFingerprint(w,optionalQuantity(defects));
      invariant(!(w.labelPrintFingerprint===fingerprint&&w.labelJobId),'동일 조건의 라벨 요청이 이미 저장되어 있습니다. 프린터 대기열을 먼저 확인하세요.');
      invariant(payload.sourceLot===w.mixLot&&payload.lotNumber===w.packLot&&Number(payload.quantity)===Number(w.qty)-optionalQuantity(defects)&&Number(payload.shrinkage)===Number(w.shrinkageRate)&&payload.mfgDate===manufactureDate(w),'라벨 내용과 최신 재고가 다릅니다. 다시 출력 요청하세요.');
      tx.set(doc(db,`print-queue/${jobId}`),{...payload,status:'pending',createdAt:serverTimestamp(),requestId:jobId,safetyFingerprint:fingerprint,sourceWipId:w.id});
      tx.update(r,{labelPrintedAt:kst(),labelPrintedQty:Number(w.qty)-optionalQuantity(defects),labelPrintedDefectQty:optionalQuantity(defects),labelPrintedPackLot:w.packLot,labelPrintedShrinkage:w.shrinkageRate,labelPrintedMfgDate:manufactureDate(w),labelPrintFingerprint:fingerprint,labelJobId:jobId,labelRequestState:'requested'});
      return jobId;
    });
  }
  async function finishPack(expected,{defects,reason,operator,physicalLabelConfirmed=false}) {
    requiredText(operator,'작업자');invariant(physicalLabelConfirmed,'실물 라벨 출력 완료를 확인하세요.');
    return transact('포장 완료',operator,async tx=>{
      const {r,w}=await readWip(tx,expected,'step8');
      invariant(!w.stocktakeRecovery?.needsHeatHistory&&!w.stocktakeRecovery?.needsShrinkageData,'원기록 미확인 로트는 포장 완료할 수 없습니다.');
      const d=defectsFor(w,defects,reason),fp=printFingerprint(w,d);
      invariant(w.labelJobId&&w.labelPrintFingerprint===fp,'현재 조건의 라벨 출력 요청이 없습니다. 수량/제품/수축률/제조일을 확인하세요.');
      const js=await tx.get(doc(db,`print-queue/${w.labelJobId}`));const job=js.data();
      invariant(job&&job.safetyFingerprint===fp&&!['error','failed','cancelled'].includes(job.status),'라벨 대기열을 확인하세요. 실패/취소된 요청은 완료 처리할 수 없습니다.');
      tx.update(r,{qty:Number(w.qty)-d,currentStep:'done',packagedAt:kst(),productionLot:w.productionLot||w.mixLot,physicalLabelConfirmedAt:kst(),physicalLabelConfirmedBy:operator,details:append(w,`[포장완료] 포장LOT:${w.packLot} | 생산LOT:${w.mixLot} | 담당:${operator} | 불량:${d} (${reason||'-'}) | 실물 라벨 확인`)});
    });
  }
  async function finishShrink(fid, expectedDesk, mergedLots, splitLots) {
    const plans=[];
    for(const g of mergedLots)plans.push({source:g.wipId,slots:g.slots,requested:g.finalShrink,suffix:'',id:uid('wip-shrink')});
    for(const g of splitLots){
      const groups={};for(const s of g.slots){invariant(/^[A-Z][A-Z0-9_]{0,11}$/.test(s.group||''),'수축률 그룹은 A, B 등 영문으로 입력하세요.');(groups[s.group]??=[]).push(s);}
      for(const [group,slots]of Object.entries(groups))plans.push({source:g.wipId,slots,suffix:Object.keys(groups).length>1?`-${group}`:'',id:uid('wip-shrink')});
    }
    return transact('수축률 확정',expectedDesk.operator,async tx=>{
      const sr=ref('equipment','shrinkDesks'),ss=await tx.get(sr),desks=ss.data()||{},live=desks[fid];
      const clean=d=>{const {queue:ignored,...rest}=d||{};return rest;};
      assertSame(clean(live),clean(expectedDesk),'수축률 측정 회차');invariant(live?.step===2,'소결 후 측정 단계가 아닙니다.');requiredText(live.operator,'작업자');
      const sources=new Set(plans.map(x=>x.source)),wips=new Map();
      for(const id of sources){const ws=await tx.get(ref('wipList',id));const w=ws.data();invariant(w?.currentStep==='step5_shrink','원본 로트가 삭제되었거나 이동되었습니다.');wips.set(id,w);}
      const fsnap=await tx.get(ref('equipment','furnaces'));const furnaces=fsnap.data()||{};
      const ar=ref('shrinkArchives',String(live.batchId||''));invariant(live.batchId,'측정 회차 번호가 없습니다.');const as=await tx.get(ar);invariant(!as.exists()||as.data().kind!=='completed','이미 확정된 측정 회차입니다.');
      const expectedSlots=Object.keys(live.slotData||{}), seen=new Set();
      invariant(plans.length>0,'수축률 분석 결과가 없습니다.');
      const children=[];
      for(const plan of plans){
        invariant(plan.slots.length>0,'빈 그룹은 확정할 수 없습니다.');let total=0,shrinkTotal=0;
        for(const item of plan.slots){
          const slot=live.slotData[item.sId];
          invariant(slot&&!seen.has(item.sId),'측정 위치가 중복되거나 누락되었습니다.');seen.add(item.sId);
          invariant(slot.wipId===plan.source&&quantity(item.qty)===quantity(slot.qty),'측정 위치의 로트 또는 수량이 다릅니다.');
          invariant(slot.measurements?.length,'시편 측정값이 없습니다.');
          const values=slot.measurements.map(m=>{requiredText(m.position,'시편 위치');const pre=positiveNumber(m.preArea),post=positiveNumber(m.postArea);invariant(pre>post,'소결 후 면적은 양수이며 소결 전보다 작아야 합니다.');return Number(((1-Math.sqrt(post/pre))*100).toFixed(2));});
          const value=Number((values.reduce((a,b)=>a+b,0)/values.length).toFixed(2));shrinkage(value);
          invariant(Math.abs(value-Number(item.shrinkVal))<0.011,'계산된 수축률이 달라졌습니다. 다시 분석하세요.');total+=quantity(slot.qty);shrinkTotal+=value;
        }
        const rate=(shrinkTotal/plan.slots.length).toFixed(2);if(plan.requested!==undefined)invariant(Math.abs(Number(plan.requested)-Number(rate))<0.011,'통합 수축률이 달라졌습니다.');
        const w=wips.get(plan.source);
        children.push({...w,...invalidateLabel(),id:plan.id,qty:total,currentStep:'step6',mixLot:w.mixLot+plan.suffix,parentWipIds:[w.id],productionLot:w.productionLot||w.mixLot,shrinkageRate:rate,slotAllocationNeedsReview:false,
          furnaceSlots:plan.slots.map(x=>({furnaceId:String(fid),slotId:x.sId,qty:quantity(live.slotData[x.sId].qty)})),details:append(w,`[\uC218\uCD95\uB960\uD655\uC815] ${rate}% | ${plan.slots.map(x=>x.sId).join(',')} | \uB2F4\uB2F9:${live.operator}`)});
      }
      invariant(seen.size===expectedSlots.length&&expectedSlots.every(s=>seen.has(s)),'모든 측정 위치가 포함되지 않았습니다.');
      for(const [id,w]of wips){
        invariant(children.filter(c=>c.parentWipIds.includes(id)).reduce((n,c)=>n+c.qty,0)===quantity(w.qty),'분할 합계와 최신 원본 수량이 다릅니다.');
        invariant(!allFurnaceSlots(furnaces).some(s=>s.wipId===id),'아직 전기로에 배정된 로트입니다.');
        for(const [other,d]of Object.entries(desks)){const batches=[...(d.queue||[]),...(String(other)!==String(fid)?[d]:[])];invariant(!batches.some(b=>Object.values(b.slotData||{}).some(x=>x.wipId===id)),'다른 대기 측정 회차에도 같은 로트가 연결되어 있습니다.');}
      }
      for(const id of sources)tx.delete(ref('wipList',id));
      for(const c of children)tx.set(ref('wipList',c.id),c);
      const {queue:ignored,...archived}=live;
      tx.set(ar,{...archived,furnaceId:String(fid),completedAt:kst(),kind:'completed',results:children.map(c=>({wipId:c.id,mixLot:c.mixLot,qty:c.qty,shrinkageRate:c.shrinkageRate}))});
      const waiting=[...(live.queue||[])];const first=waiting.shift();tx.set(sr,{...desks,[fid]:first?{...first,queue:waiting}:{step:0,slotData:{},queue:[],memo:'',operator:''}});
      return children;
    });
  }

  return { finishShrink,advance,firstMolding,splitMolding,allocateSlot,furnaceField,startHeat,finishHeat,roomField,dryStart,dryField,dryComplete,ensurePack,cancelOrEdit,ship,release,cancelOrder,inbound,requestPrint,finishPack };
}
