import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryDatabase,configureDatabase,collection,doc,getDocFromServer,getDocsFromServer,runTransaction,setDoc,deleteDoc,onSnapshot,pendingWrites,limitedQuery,serverTimestamp} from '../src/mesDatabase.mjs';
import {createOperations} from '../src/mesOperations.mjs';
import {quantity,positiveNumber,shrinkage,canonical,kst,printFingerprint,manufactureDate} from '../src/mesSafetyCore.mjs';
import {modePolicy} from '../src/mesModePolicy.mjs';
import {makeDemoData} from '../src/mesDemoData.mjs';
const root='artifacts/demo-mes/public/data';
const wip=(id='w1',step='step6',qty=10)=>({id,mixLot:`MIX-DEMO-${id}`,type:'345 BL3',height:'25',singleWeight:650,weight:'6.765',qty,currentStep:step,details:'ORIGINAL HISTORY',orderId:'o1'});
const slot=(w,qty=w.qty)=>({wipId:w.id,mixLot:w.mixLot,type:w.type,height:w.height,qty});
function setup(wips=[],extra={},admin=true){
 const seed={
  [`${root}/equipment/furnaces`]:{'1':{isHeating:false,temp:'1050',operator:'TEST',slotData:{},memo:''},'2':{isHeating:false,temp:'1050',operator:'TEST',slotData:{},memo:''}},
  [`${root}/equipment/shrinkDesks`]:{'1':{step:0,slotData:{},queue:[],memo:'',operator:''},'2':{step:0,slotData:{},queue:[],memo:'',operator:''}},
  [`${root}/equipment/dryingRoom`]:{operator:'TEST',temp:'40',humidity:'15',completionData:{},dryingWipIds:[],cartItems:[]},
 };
 for(const w of wips)seed[`${root}/wipList/${w.id}`]=w;
 for(const [path,data]of Object.entries(extra))seed[path.startsWith('print-queue/')?path:`${root}/${path}`]=data;
 const db=createMemoryDatabase(seed);configureDatabase(db,{root,canWrite:()=>true,actor:()=> 'TEST'});
 const ref=(c,id)=>doc(db,`${root}/${c}/${id}`);
 const get=(c,id)=>db.docs.get(`${root}/${c}/${id}`);
 const list=c=>[...db.docs].filter(([p])=>p.startsWith(`${root}/${c}/`)).map(([,d])=>d);
 return {db,ref,get,list,ops:createOperations(db,root,()=>admin)};
}
const admin={operator:'TEST ADMIN',reason:'PHYSICAL STOCK CHECK'};
function printable(){return {...wip('p','step8'),packLot:'FDEMO001',shrinkageRate:'20',heatTreatmentHistory:[{completedAt:'2026-09-02 08:00:00'}]};}
const payload=w=>({sourceLot:w.mixLot,lotNumber:w.packLot,quantity:w.qty,shrinkage:w.shrinkageRate,mfgDate:'2026-09-02',sku:'DEMO'});
function shrinkSetup(){
 const w=wip('s','step5_shrink');
 const s=q=>({...slot(w,q),measurements:[{position:'front',preArea:'100',postArea:'64'}]});
 const desk={batchId:'b1',revision:1,operator:'TEST',step:2,slotData:{L1:s(4),R1:s(6)},queue:[]};
 const a=setup([w],{'equipment/shrinkDesks':{'1':desk,'2':{step:0,slotData:{},queue:[]}}});
 return {...a,w,desk,plan:[{wipId:w.id,finalShrink:'20.00',slots:[{sId:'L1',qty:4,shrinkVal:20},{sId:'R1',qty:6,shrinkVal:20}]}]};
}

test('numeric validation rejects blank, boolean, fractional, negative, NaN and unsafe integers',()=>{
 for(const x of ['', ' ',null,undefined,true,false,-1,1.2,'1.5',NaN,Infinity,2**54])assert.throws(()=>quantity(x));
 assert.equal(quantity('12'),12);assert.equal(quantity(0),0);assert.throws(()=>quantity(0,'qty',false));
 for(const x of ['',null,NaN,Infinity,-1,0])assert.throws(()=>positiveNumber(x));
 for(const x of ['',0,'0',100,101,NaN])assert.throws(()=>shrinkage(x));
 assert.equal(shrinkage('19.58'),19.58);
});
test('KST formatting does not depend on host timezone',()=>assert.equal(kst(new Date('2026-09-11T11:41:53Z')),'2026-09-11 20:41:53'));
test('missing or unknown deployment settings never select production',()=>{
 assert.equal(modePolicy({}).mode,'demo');assert.equal(modePolicy({mode:'invalid'}).mode,'blocked');
 assert.equal(modePolicy({mode:'production',hostname:'preview.vercel.app',allowedHost:'factory.example'}).mode,'blocked');
 assert.equal(modePolicy({mode:'production',hostname:'factory.example',allowedHost:'factory.example'}).mode,'blocked');
});
test('production writes need explicit flag, required config and exact host',()=>{
 const p={mode:'production',hostname:'factory.example',allowedHost:'factory.example',apiKey:'a',authDomain:'dasanind-mes.firebaseapp.com',projectId:'dasanind-mes'};
 assert.equal(modePolicy(p).liveWrites,false);assert.equal(modePolicy({...p,allowWrites:true}).liveWrites,true);
 assert.equal(modePolicy({...p,projectId:'wrong'}).mode,'blocked');
});
test('emulator is accepted only on localhost and demo remains demo on any host',()=>{
 assert.equal(modePolicy({mode:'emulator',hostname:'localhost'}).mode,'emulator');
 assert.equal(modePolicy({mode:'emulator',hostname:'preview'}).mode,'blocked');
 assert.equal(modePolicy({mode:'demo',hostname:'factory.example',allowWrites:true}).liveWrites,false);
});
test('synthetic fixtures contain no real lots and reset independently',()=>{
 const d=makeDemoData(root);assert.equal(Object.values(d).filter(x=>x.currentStep).length,10);
 assert.ok(Object.values(d).filter(x=>x.mixLot).every(x=>x.mixLot.startsWith('MIX-DEMO-')));
 const a=createMemoryDatabase(d),b=createMemoryDatabase(d);a.docs.clear();assert.ok(b.docs.size>0);
});
test('advance updates only current WIP and creates atomic before/after audit',async()=>{
 const w=wip(),s=setup([w]);await s.ops.advance(w,'step7',{operator:'TEST',defects:1,reason:'broken'});
 assert.equal(s.get('wipList',w.id).qty,9);assert.equal(s.get('wipList',w.id).currentStep,'step7');
 const a=s.list('mesAudit');assert.equal(a.length,1);assert.equal(a[0].changes[0].before.qty,10);assert.equal(a[0].changes[0].after.qty,9);
});
test('stale advance is rejected even when the process name has not changed',async()=>{
 const w=wip(),s=setup([w]);s.db.docs.set(`${root}/wipList/w1`,{...w,qty:12});const before=canonical([...s.db.docs]);
 await assert.rejects(s.ops.advance(w,'step7',{operator:'TEST'}));assert.equal(canonical([...s.db.docs]),before);
});
test('deleted WIP is never resurrected by a stale completion',async()=>{
 const w=wip(),s=setup([w]);await s.ops.cancelOrEdit(w,{...admin,cancel:true});
 await assert.rejects(s.ops.advance(w,'step7',{operator:'TEST'}));assert.equal(s.get('wipList',w.id),undefined);
 assert.equal(s.get('wipArchive',w.id).qty,10);
});
test('simultaneous duplicate completions have exactly one winner',async()=>{
 const w=wip(),s=setup([w]);const r=await Promise.allSettled([s.ops.advance(w,'step7',{operator:'T'}),s.ops.advance(w,'step7',{operator:'T'})]);
 assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(s.list('mesAudit').length,1);
});
test('injected commit failure leaves WIP, audit and control all unchanged',async()=>{
 const w=wip(),s=setup([w]),before=canonical([...s.db.docs]);s.db.failNextCommit=true;
 await assert.rejects(s.ops.advance(w,'step7',{operator:'T'}));assert.equal(canonical([...s.db.docs]),before);assert.equal(pendingWrites(),0);
});
test('defect overflow and absent reasons do not reduce inventory',async()=>{
 const w=wip(),s=setup([w]);await assert.rejects(s.ops.advance(w,'step7',{operator:'T',defects:11,reason:'bad'}));
 await assert.rejects(s.ops.advance(w,'step7',{operator:'T',defects:1}));assert.equal(s.get('wipList',w.id).qty,10);
});
test('all-defective completion archives original instead of invisible zero active WIP',async()=>{
 const w=wip(),s=setup([w]);await s.ops.advance(w,'step7',{operator:'T',defects:10,reason:'bad'});
 assert.equal(s.get('wipList',w.id),undefined);assert.equal(s.get('wipArchive',w.id).details,w.details);
});
test('admin cancellation needs admin access, reason and actor',async()=>{
 const w=wip(),s=setup([w],{},false);await assert.rejects(s.ops.cancelOrEdit(w,{...admin,cancel:true}));
 const a=setup([w]);await assert.rejects(a.ops.cancelOrEdit(w,{cancel:true,operator:'T',reason:''}));
 await assert.rejects(a.ops.cancelOrEdit(w,{cancel:true,operator:'',reason:'a'}));assert.equal(a.list('mesAudit').length,0);
});
test('admin cancel archives full source and forbids reuse of archived ID',async()=>{
 const w=wip(),s=setup([w]);await s.ops.cancelOrEdit(w,{...admin,cancel:true});
 assert.equal(s.get('wipArchive',w.id).mixLot,w.mixLot);
 await assert.rejects(setDoc(s.ref('wipList',w.id),w));assert.equal(s.get('wipList',w.id),undefined);
});
test('linked shipping history blocks cancellation and history itself is immutable',async()=>{
 const w=wip(),s=setup([w],{'shippingHistory/h1':{id:'h1',sourceWipId:w.id,qty:1}});
 await assert.rejects(s.ops.cancelOrEdit(w,{...admin,cancel:true}));
 await assert.rejects(deleteDoc(s.ref('shippingHistory','h1')));await assert.rejects(setDoc(s.ref('shippingHistory','h1'),{id:'h1',qty:0}));
});
test('forward skip and double raw-material debit rollback are blocked',async()=>{
 const w=wip(),s=setup([w]);await assert.rejects(s.ops.cancelOrEdit(w,{...admin,step:'done'}));
 await assert.rejects(s.ops.cancelOrEdit(w,{...admin,step:'step2'}));
 await s.ops.cancelOrEdit(w,{...admin,step:'step3'});assert.equal(s.get('wipList',w.id).currentStep,'step3');
});
test('rollback detaches only target from idle furnace and preserves unrelated slot',async()=>{
 const w=wip('w1','step5'),b=wip('w2','step5');const s=setup([w,b]);const f=s.get('equipment','furnaces');f['1'].slotData={L1:slot(w),R1:slot(b)};
 await s.ops.cancelOrEdit(w,{...admin,step:'step4'});
 assert.deepEqual(Object.keys(s.get('equipment','furnaces')['1'].slotData),['R1']);assert.equal(s.get('wipList','w2').qty,10);
});
test('rollback removes target from shrink queues without touching other batches',async()=>{
 const w=wip('w1','step5_shrink'),b=wip('w2','step5_shrink'),s=setup([w,b]);
 const other={batchId:'other',step:2,revision:7,slotData:{R1:slot(b)},stageIssues:[{wipId:b.id,reason:'x'}]};
 s.db.docs.set(`${root}/equipment/shrinkDesks`,{'1':{batchId:'a',step:1,slotData:{L1:slot(w)},queue:[other]},'2':{step:0,slotData:{},queue:[]}});
 await s.ops.cancelOrEdit(w,{...admin,step:'step5'});const d=s.get('equipment','shrinkDesks')['1'];assert.equal(d.batchId,'other');assert.equal(d.revision,7);assert.deepEqual(d.stageIssues,other.stageIssues);
});
test('running furnace and drying WIP cannot be structurally changed',async()=>{
 const w=wip('w1','step5'),s=setup([w]);const f=s.get('equipment','furnaces');f['1'].isHeating=true;f['1'].slotData={L1:slot(w)};
 await assert.rejects(s.ops.cancelOrEdit(w,{...admin,qty:9}));await assert.rejects(s.ops.cancelOrEdit(w,{...admin,cancel:true}));
 const d=wip('d','step7_drying'),t=setup([d]);await assert.rejects(t.ops.cancelOrEdit(d,{...admin,step:'step7'}));
});
test('allocated quantity cannot be changed without cleanup',async()=>{
 const w=wip('w1','step5'),s=setup([w]);s.get('equipment','furnaces')['1'].slotData={L1:slot(w)};
 await assert.rejects(s.ops.cancelOrEdit(w,{...admin,qty:9}));assert.equal(s.get('wipList',w.id).qty,10);
});
test('historical furnace slots are preserved on quantity correction with review flag',async()=>{
 const w={...wip('w1','step6'),furnaceSlots:[{fid:1,slotId:'R4',qty:10}]},s=setup([w]);
 await s.ops.cancelOrEdit(w,{...admin,qty:9});const live=s.get('wipList',w.id);assert.equal(live.furnaceSlots[0].qty,10);assert.equal(live.slotAllocationNeedsReview,true);
});
test('first molding validates actual count and preserves correction in audit',async()=>{
 const w=wip('w1','step3'),s=setup([w]);await s.ops.firstMolding(w,{actualQty:11,defects:1,defectReason:'broken',operator:'T',note:'verified actual eleven'});
 assert.equal(s.get('wipList',w.id).qty,10);assert.equal(s.get('wipList',w.id).currentStep,'step4');
});
test('second molding conserves normal plus defects, archives parent, tracks children',async()=>{
 const w=wip('w1','step4'),s=setup([w]);const children=await s.ops.splitMolding(w,{qtyA:4,qtyB:5,defectA:1,defectB:0,defectReasonA:'broken',operator:'T'});
 assert.equal(children.reduce((n,c)=>n+c.qty,0),9);assert.equal(s.list('wipList').length,2);assert.equal(s.get('wipArchive','w1').successorWipIds.length,2);
 assert.ok(children.every(c=>c.parentWipIds[0]==='w1'&&c.productionLot===w.mixLot));
});
test('second molding mismatch does not delete parent',async()=>{
 const w=wip('w1','step4'),s=setup([w]);await assert.rejects(s.ops.splitMolding(w,{qtyA:4,qtyB:7,operator:'T'}));assert.equal(s.list('wipList').length,1);
});
test('cross-furnace allocation cannot exceed source quantity',async()=>{
 const w=wip('w1','step5'),s=setup([w]);await s.ops.allocateSlot(1,'L1',null,w,6);
 await assert.rejects(s.ops.allocateSlot(2,'R1',null,w,5));assert.equal(s.get('equipment','furnaces')['2'].slotData.R1,undefined);
});
test('occupied slot and running furnace reject allocation',async()=>{
 const w=wip('w1','step5'),s=setup([w]);await s.ops.allocateSlot(1,'L1',null,w,10);
 await assert.rejects(s.ops.allocateSlot(1,'L1',null,w,1));s.get('equipment','furnaces')['1'].isHeating=true;
 await assert.rejects(s.ops.allocateSlot(1,'L1',slot(w),null,0));
});
test('different furnace fields save without overwriting fresh slots',async()=>{
 const w=wip('w1','step5'),s=setup([w]);await s.ops.allocateSlot(1,'L1',null,w,10);
 await s.ops.furnaceField(1,'memo','new memo','');assert.equal(s.get('equipment','furnaces')['1'].slotData.L1.qty,10);
 await assert.rejects(s.ops.furnaceField(1,'memo','stale memo',''));
});
test('start heat refuses partial or multi-furnace source allocation',async()=>{
 const w=wip('w1','step5'),s=setup([w]);await s.ops.allocateSlot(1,'L1',null,w,6);
 await assert.rejects(s.ops.startHeat(1,s.get('equipment','furnaces')['1']));await s.ops.allocateSlot(2,'R1',null,w,4);
 await assert.rejects(s.ops.startHeat(1,s.get('equipment','furnaces')['1']));
});
test('heat completion moves WIP with quantity, history and queued desk in one commit',async()=>{
 const w=wip('w1','step5'),s=setup([w]);await s.ops.allocateSlot(1,'L1',null,w,10);await s.ops.startHeat(1,s.get('equipment','furnaces')['1']);
 const old={batchId:'old',step:2,slotData:{R6:{wipId:'old',qty:1}},queue:[]};s.get('equipment','shrinkDesks')['1']=old;
 await s.ops.finishHeat(1,s.get('equipment','furnaces')['1']);
 assert.equal(s.get('wipList','w1').currentStep,'step5_shrink');assert.equal(s.get('wipList','w1').heatTreatmentHistory.length,1);
 const d=s.get('equipment','shrinkDesks')['1'];assert.equal(d.batchId,'old');assert.equal(d.queue[0].slotData.L1.qty,10);assert.equal(s.get('equipment','furnaces')['1'].isHeating,false);
});
test('heat finish failed commit does not empty furnace or move product',async()=>{
 const w=wip('w1','step5'),s=setup([w]);await s.ops.allocateSlot(1,'L1',null,w,10);await s.ops.startHeat(1,s.get('equipment','furnaces')['1']);
 const before=canonical([...s.db.docs]);s.db.failNextCommit=true;await assert.rejects(s.ops.finishHeat(1,s.get('equipment','furnaces')['1']));assert.equal(canonical([...s.db.docs]),before);
});
test('drying start, keyed edits and completion allocate pack once',async()=>{
 const w=wip('legacy.123','step7'),s=setup([w]);await s.ops.dryStart(w);let live=s.get('wipList',w.id);
 await s.ops.dryField(w.id,'defects','1','');await s.ops.dryField(w.id,'reason','broken','');
 const data=s.get('equipment','dryingRoom').completionData[w.id];await s.ops.dryComplete(live,data);
 assert.equal(s.get('wipList',w.id).qty,9);assert.ok(s.get('wipList',w.id).packLot);assert.equal(s.get('equipment','dryingRoom').dryingWipIds.length,0);
 await assert.rejects(s.ops.dryComplete(live,data));assert.equal(s.list('systemCounters')[0].lastSeq,1);
});
test('drying rejects stale completion data and atomic failure preserves room',async()=>{
 const w=wip('w1','step7_drying'),s=setup([w]);await s.ops.dryField(w.id,'defects','2','');
 await assert.rejects(s.ops.dryComplete(w,{}));await s.ops.dryField(w.id,'reason','broken','');
 const before=canonical([...s.db.docs]);s.db.failNextCommit=true;await assert.rejects(s.ops.dryComplete(w,s.get('equipment','dryingRoom').completionData[w.id]));assert.equal(canonical([...s.db.docs]),before);
});
test('partial shipment atomically appends shipment and adjusts balance',async()=>{
 const w=wip('w1','done'),s=setup([w]);await s.ops.ship(w,{qty:4,operator:'T',destination:'DEMO'});
 assert.equal(s.get('wipList','w1').qty,6);assert.equal(s.list('shippingHistory')[0].remainingQty,6);assert.equal(s.list('shippingHistory')[0].stockBeforeQty,10);
});
test('complete shipment archives source and duplicate shipment is rejected',async()=>{
 const w=wip('w1','done'),s=setup([w]);await s.ops.ship(w,{qty:10,operator:'T',destination:'DEMO'});
 assert.equal(s.get('wipList','w1'),undefined);assert.ok(s.get('wipArchive','w1'));
 await assert.rejects(s.ops.ship(w,{qty:1,operator:'T',destination:'DEMO'}));assert.equal(s.list('shippingHistory').length,1);
});
test('sample is separately recorded without fake finished processing',async()=>{
 const w=wip(),s=setup([w]);await s.ops.ship(w,{qty:2,operator:'T',destination:'SAMPLE TEST',sample:true});
 const h=s.list('shippingHistory')[0];assert.equal(h.qty,2);assert.equal(h.sourceStep,'step6');assert.equal(s.get('wipList','w1').currentStep,'step6');
});
test('ordinary shipping cannot bypass unfinished process',async()=>{
 const w=wip(),s=setup([w]);await assert.rejects(s.ops.ship(w,{qty:2,operator:'T',destination:'TEST'}));
});
test('sample shipping from allocated equipment is blocked',async()=>{
 const w=wip(),s=setup([w]);s.get('equipment','shrinkDesks')['1'].slotData={L1:slot(w)};
 await assert.rejects(s.ops.ship(w,{qty:2,operator:'T',destination:'TEST',sample:true}));
});
test('production release uses live coverage and unique sequential MIX numbers',async()=>{
 const o={id:'o1',orderNo:'ORD-DEMO',qty:10,color:'345 BL3',height:'25',singleWeight:650,status:'pending'},s=setup([],{'orderList/o1':o});
 const a=await s.ops.release(o,6);await assert.rejects(s.ops.release(o,6));const b=await s.ops.release(o,4);
 assert.notEqual(a.mixLot,b.mixLot);assert.equal(s.list('wipList').reduce((n,w)=>n+w.qty,0),10);
});
test('inbound stock and inventory history never partially commit',async()=>{
 const s=setup(),before=canonical([...s.db.docs]);s.db.failNextCommit=true;
 await assert.rejects(s.ops.inbound([{type:'4Y-W',lot:'RAW-DEMO',weight:10}]));assert.equal(canonical([...s.db.docs]),before);
 await s.ops.inbound([{type:'4Y-W',lot:'RAW-DEMO',weight:10}]);assert.equal(s.list('inventory').length,1);assert.equal(s.list('inventoryHistory').length,1);
});
test('label requires finite shrinkage, real date and no stocktake hold',async()=>{
 const w=printable(),s=setup([w]);await assert.rejects(s.ops.requestPrint({...w,shrinkageRate:''},{payload:payload(w)}));
 assert.throws(()=>manufactureDate({...w,heatTreatmentHistory:[{completedAt:'2026-02-31 08:00:00'}]}));
 const h={...w,stocktakeRecovery:{needsHeatHistory:true}},t=setup([h]);await assert.rejects(t.ops.requestPrint(h,{payload:payload(h)}));
});
test('label request and WIP fingerprint commit together, never duplicate',async()=>{
 const w=printable(),s=setup([w]);const id=await s.ops.requestPrint(w,{payload:payload(w)});const live=s.get('wipList',w.id);
 assert.equal(live.labelJobId,id);assert.ok(s.db.docs.get(`print-queue/${id}`));
 await assert.rejects(s.ops.requestPrint(live,{payload:payload(live)}));assert.equal([...s.db.docs.keys()].filter(p=>p.startsWith('print-queue/')).length,1);
});
test('label atomic failure leaves no queue item',async()=>{
 const w=printable(),s=setup([w]);s.db.failNextCommit=true;await assert.rejects(s.ops.requestPrint(w,{payload:payload(w)}));
 assert.equal([...s.db.docs.keys()].filter(p=>p.startsWith('print-queue/')).length,0);assert.equal(s.get('wipList',w.id).labelJobId,undefined);
});
test('pack complete requires physical confirmation and matching condition',async()=>{
 const w=printable(),s=setup([w]);await s.ops.requestPrint(w,{payload:payload(w)});const live=s.get('wipList',w.id);
 await assert.rejects(s.ops.finishPack(live,{operator:'T',defects:0,physicalLabelConfirmed:false}));
 await assert.rejects(s.ops.finishPack(live,{operator:'T',defects:1,reason:'broken',physicalLabelConfirmed:true}));
 await s.ops.finishPack(live,{operator:'T',defects:0,physicalLabelConfirmed:true});assert.equal(s.get('wipList',w.id).currentStep,'done');
});
test('admin cannot orphan pending label job by changing quantity',async()=>{
 const w=printable(),s=setup([w]);await s.ops.requestPrint(w,{payload:payload(w)});
 await assert.rejects(s.ops.cancelOrEdit(s.get('wipList',w.id),{...admin,qty:9}));
});
test('shrink finalization conserves source and saves completed batch and lineage',async()=>{
 const s=shrinkSetup();const children=await s.ops.finishShrink(1,s.desk,s.plan,[]);
 assert.equal(children.length,1);assert.equal(children[0].qty,10);assert.equal(children[0].shrinkageRate,'20.00');assert.equal(children[0].currentStep,'step6');
 assert.equal(s.get('wipArchive','s').successorWipIds[0],children[0].id);assert.equal(s.get('shrinkArchives','b1').kind,'completed');
});
test('shrink split children retain only their own positions',async()=>{
 const s=shrinkSetup();const split=[{wipId:'s',slots:s.plan[0].slots.map((p,i)=>({...p,group:i?'B':'A'}))}];
 const children=await s.ops.finishShrink(1,s.desk,[],split);assert.deepEqual(children.map(x=>x.qty).sort((a,b)=>a-b),[4,6]);assert.ok(children.every(c=>c.furnaceSlots.length===1));
});
test('shrink missing or duplicate position cannot delete source',async()=>{
 const s=shrinkSetup();await assert.rejects(s.ops.finishShrink(1,s.desk,[{...s.plan[0],slots:[s.plan[0].slots[0]]}],[]));
 await assert.rejects(s.ops.finishShrink(1,s.desk,[{...s.plan[0],slots:[s.plan[0].slots[0],s.plan[0].slots[0]]}],[]));assert.equal(s.get('wipList','s').qty,10);
});
test('shrink rejects stale batch, wrong math and incomplete source total',async()=>{
 const s=shrinkSetup();await assert.rejects(s.ops.finishShrink(1,{...s.desk,revision:0},s.plan,[]));
 await assert.rejects(s.ops.finishShrink(1,s.desk,[{...s.plan[0],finalShrink:'19.5'}],[]));s.db.docs.set(`${root}/wipList/s`,{...s.w,qty:11});
 await assert.rejects(s.ops.finishShrink(1,s.desk,s.plan,[]));assert.equal(s.get('wipList','s').qty,11);
});
test('shrink cannot process source that also occurs in another queued batch',async()=>{
 const s=shrinkSetup();s.get('equipment','shrinkDesks')['1'].queue=[{batchId:'b2',step:1,slotData:{L3:slot(s.w)}}];
 await assert.rejects(s.ops.finishShrink(1,s.desk,s.plan,[]));assert.equal(s.get('wipList','s').qty,10);
});
test('shrinking atomic failure keeps source, batch and audit untouched',async()=>{
 const s=shrinkSetup(),before=canonical([...s.db.docs]);s.db.failNextCommit=true;await assert.rejects(s.ops.finishShrink(1,s.desk,s.plan,[]));assert.equal(canonical([...s.db.docs]),before);
});
test('storage refuses invalid schema, invalid numbers, cross DB and forbidden audit writes',async()=>{
 const s=setup();await assert.rejects(setDoc(s.ref('wipList','x'),{...wip('x'),qty:NaN}));
 await assert.rejects(setDoc(s.ref('wipList','x'),{...wip('wrong')}));
 await assert.rejects(setDoc(s.ref('mesAudit','x'),{a:1}));const t=setup();await assert.rejects(runTransaction(s.db,tx=>tx.set(t.ref('wipList','x'),wip('x'))));
});
test('transaction reads-after-write fail and do not save partial changes',async()=>{
 const w=wip(),s=setup([w]);await assert.rejects(runTransaction(s.db,async tx=>{tx.update(s.ref('wipList','w1'),{qty:9});await tx.get(s.ref('wipList','w1'));}));
 assert.equal(s.get('wipList','w1').qty,10);
});
test('read-only configuration blocks every wrapped write',async()=>{
 const w=wip(),s=setup([w]);configureDatabase(s.db,{root,canWrite:()=>false});await assert.rejects(setDoc(s.ref('wipList','w1'),w));await assert.rejects(s.ops.advance(w,'step7',{operator:'T'}));
});
test('memory listener cleanup prevents events after unmount',async()=>{
 const w=wip(),s=setup([w]);let count=0;const stop=onSnapshot(collection(s.db,`${root}/wipList`),()=>count++);await new Promise(r=>setTimeout(r,0));stop();
 await s.ops.advance(w,'step7',{operator:'T'});await new Promise(r=>setTimeout(r,0));assert.equal(count,1);assert.equal(s.db.listeners.size,0);
});
test('audit list is bounded and sorted newest first',async()=>{
 const s=setup();for(let n=0;n<80;n++)s.db.docs.set(`${root}/mesAudit/${n}`,{recordedAt:String(n).padStart(3,'0')});
 const snap=await getDocsFromServer(limitedQuery(collection(s.db,`${root}/mesAudit`),'recordedAt',50));assert.equal(snap.docs.length,50);assert.equal(snap.docs[0].data().recordedAt,'079');
});

test('cancellation reason and operator remain in archive context',async()=>{
 const w=wip(),s=setup([w]);await s.ops.cancelOrEdit(w,{...admin,cancel:true});const a=s.get('wipArchive',w.id);
 assert.equal(a.archiveContext.reason,admin.reason);assert.equal(a.archiveContext.operator,admin.operator);
});
test('all-defective event keeps defect reason in the same audit commit',async()=>{
 const w=wip(),s=setup([w]);await s.ops.advance(w,'step7',{operator:'T',defects:10,reason:'all broken'});
 assert.equal(s.get('wipArchive',w.id).archiveContext.reason,'all broken');assert.equal(s.list('mesAudit')[0].metadata.defects,10);
});
test('multiple shrink parents link only their own descendants',async()=>{
 const s=shrinkSetup(),other=wip('t','step5_shrink',3);s.db.docs.set(`${root}/wipList/t`,other);
 s.get('equipment','shrinkDesks')['1'].slotData.L2={...slot(other),measurements:[{position:'front',preArea:100,postArea:64}]};
 const desk=s.get('equipment','shrinkDesks')['1'];const plan=[...s.plan,{wipId:'t',finalShrink:20,slots:[{sId:'L2',qty:3,shrinkVal:20}]}];
 const children=await s.ops.finishShrink(1,desk,plan,[]);
 assert.equal(s.get('wipArchive','s').successorWipIds.length,1);assert.equal(s.get('wipArchive','t').successorWipIds.length,1);
 for(const parent of ['s','t'])assert.ok(children.find(c=>c.id===s.get('wipArchive',parent).successorWipIds[0]).parentWipIds.includes(parent));
});
test('two simultaneous release attempts cannot exceed order total',async()=>{
 const order={id:'o1',orderNo:'ORD-DEMO',qty:10,color:'345 BL3',height:'25',singleWeight:650,status:'pending'},s=setup([],{'orderList/o1':order});
 const a=await Promise.allSettled([s.ops.release(order,10),s.ops.release(order,10)]);assert.equal(a.filter(x=>x.status==='fulfilled').length,1);assert.equal(s.list('wipList').reduce((n,w)=>n+w.qty,0),10);
});
test('synthetic full production sequence preserves quantity into shipment',async()=>{
 const initial=wip('full','step3'),s=setup([initial]);
 await s.ops.firstMolding(initial,{actualQty:10,defects:0,operator:'T',note:'test'});
 const children=await s.ops.splitMolding(s.get('wipList','full'),{qtyA:10,qtyB:0,operator:'T'}),id=children[0].id;
 await s.ops.allocateSlot(1,'L1',null,s.get('wipList',id),10);await s.ops.startHeat(1,s.get('equipment','furnaces')['1']);await s.ops.finishHeat(1,s.get('equipment','furnaces')['1']);
 const desk=s.get('equipment','shrinkDesks')['1'];desk.step=2;desk.slotData.L1.measurements=[{position:'front',preArea:100,postArea:64}];
 const next=await s.ops.finishShrink(1,desk,[{wipId:id,finalShrink:20,slots:[{sId:'L1',qty:10,shrinkVal:20}]}],[]),nid=next[0].id;
 await s.ops.advance(s.get('wipList',nid),'step7',{operator:'T'});await s.ops.dryStart(s.get('wipList',nid));await s.ops.dryComplete(s.get('wipList',nid),{});
 let p=s.get('wipList',nid);const v={...payload(p),mfgDate:manufactureDate(p)};await s.ops.requestPrint(p,{payload:v});
 await s.ops.finishPack(s.get('wipList',nid),{operator:'T',defects:0,physicalLabelConfirmed:true});await s.ops.ship(s.get('wipList',nid),{qty:10,operator:'T',destination:'DEMO'});
 assert.equal(s.list('wipList').length,0);assert.equal(s.list('shippingHistory').reduce((n,h)=>n+h.qty,0),10);assert.equal(s.list('wipArchive').length,3);
});

test('audit encodes server timestamp transform rather than placing it inside arrays',async()=>{
 const s=setup();await setDoc(s.ref('inventoryHistory','with-timestamp'),{id:'with-timestamp',qty:1,createdAt:serverTimestamp()});
 const audit=s.list('mesAudit')[0];assert.equal(audit.changes[0].after.createdAt.__firestoreType,'serverTimestamp');assert.equal(audit.changes[0].after.createdAt.resolvedBy,'audit.createdAt');
 assert.equal(typeof s.get('inventoryHistory','with-timestamp').createdAt.seconds,'number');
});
