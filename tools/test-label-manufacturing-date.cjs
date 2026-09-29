const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const helper=fs.readFileSync(path.join(root,'src/labelManufacturingDate.js'),'utf8').replaceAll('export const ','const ');
const source=fs.readFileSync(path.join(root,'src/App.js'),'utf8');
const begin=source.indexOf('  const handlePrintLabel =',source.indexOf('function Step8Packaging('));
const end=source.indexOf('\n  return (',begin);
assert.ok(begin>0&&end>begin);
const handler=source.slice(begin,end);
const helpers=source.slice(source.indexOf('const HEAT_FURNACE_IDS ='),source.indexOf('const DEFAULT_DRYING_ROOM ='));
const clone=x=>JSON.parse(JSON.stringify(x));
const today='2026-09-29';
const ctx=vm.createContext({Date});
vm.runInContext(helper+';this.resolve=getLabelManufacturingDate;this.normalize=normalizeManufacturingDate;this.confirm=confirmLabelManufacturingDate;',ctx);
const resolve=x=>clone(ctx.resolve(x,today));
const base=()=>({id:'legacy',mixLot:'LEGACY-MIX-B',packLot:'F-LEGACY-001',type:'345 BL1',height:'30',qty:56,currentStep:'step8',shrinkageRate:'19.42',details:'[2026-09-07 10:00:00] [배합완료] 이전 생산 이력'});
function setup({wip=base(),live=wip,form={},failCommit=false}={}){
 let record=clone(live);const before=clone(record);const jobs=[],toasts=[];let commits=0;
 const c=vm.createContext({Date,console,wipList:[clone(wip)],formData:{[wip.id]:form},printingRef:{current:new Set()},setPrinting:()=>{},setPrintedStatus:()=>{},setLabelPreview:()=>{},
  ctx:{showToast:(message,type)=>toasts.push({message,type})},getKST:()=>today+' 10:30:00',
  getPackagingLot:x=>x.packLot,ensurePackagingLot:async()=>{throw Error('Unexpected LOT reassignment');},getFirestore:()=>({}),
  getProductSeries:()=> '345',getProductShade:()=> 'BL1',getProductSKU:()=> 'Z345BL130',serverTimestamp:()=>today+' 10:30:00',
  doc:(_db,col,id)=>({path:col+'/'+id,id}),getDocRef:(col,id)=>({path:col+'/'+id,id}),
  runTransaction:async(_db,fn)=>{
   const writes=[];
   await fn({get:async ref=>{assert.equal(writes.length,0);return {exists:()=>true,data:()=>clone(record)};},set:(ref,data)=>writes.push({kind:'set',ref,data:clone(data)}),update:(ref,data)=>writes.push({kind:'update',ref,data:clone(data)})});
   if(failCommit)throw Error('Simulated queue commit rejection');
   for(const write of writes){if(write.kind==='set')jobs.push(write.data);else record={...record,...write.data};}commits++;
  }
 });
 vm.runInContext(helper+helpers+handler+';this.print=handlePrintLabel;',c);
 return {print:()=>c.print(wip.id),jobs,toasts,before,record:()=>clone(record),commits:()=>commits};
}

test('reads legacy completion events but ignores start, packaging, measurement and explanatory notes',()=>{
 const w=base();w.details+='\n[2026-09-20 11:00:00] [열처리완료] 1호기\n[2026-09-25 11:00:00] [열처리 시작]\n[2026-09-28 12:00:00] [포장LOT확정] F260928001';
 assert.deepEqual(resolve(w),{date:'2026-09-20',source:'process_history'});
 assert.equal(resolve({...w,details:'[2026-09-28 11:00:00] [검수] 메모:[열처리완료]'}),null);
});
test('uses newest actual heat completion across reordered structured records and legacy events',()=>{
 assert.deepEqual(resolve({heatTreatmentHistory:[{completedAt:'2026-09-22 08:00:00'},{completedAt:'2026-09-20 18:00:00'}],details:'[2026-09-24 13:00:00] [열처리 완료] 2호기'}),{date:'2026-09-24',source:'process_history'});
 assert.deepEqual(resolve({heatTreatmentHistory:[{completedAt:'2026-09-22 08:00:00'},{completedAt:'2026-09-20 18:00:00'}]}),{date:'2026-09-22',source:'heat_history'});
});
test('normalizes timestamp/ISO values to Korean manufacturing dates, rejects invalid and future dates',()=>{
 assert.equal(ctx.normalize('2026-09-22T16:30:00Z'),'2026-09-23');
 assert.equal(ctx.normalize({seconds:Date.parse('2026-09-22T16:30:00Z')/1000}),'2026-09-23');
 assert.equal(ctx.normalize('2026-02-30'),'');
 assert.equal(resolve({heatTreatmentHistory:[{completedAt:'2099-09-29'}]}),null);
});
test('never guesses dates from lot numbers, creation, printing, shrinkage or packaging timestamps',()=>{
 assert.equal(resolve({...base(),mixLot:'MIX-260907-123',packLot:'F260928001',createdAt:'2026-09-07',packLotCreatedAt:'2026-09-28',labelPrintedAt:'2026-09-29',shrinkageHistory:[{completedAt:'2026-09-23'}]}),null);
});
test('preserves the narrowly approved 667 date without applying it to other recovered lots',()=>{
 const w={id:'stocktake-recovery-260724-667',mixLot:'MIX-260724-667',qty:94,shrinkageRate:'19.7665',stocktakeRecovery:{sourceLot:'MIX-260724-667'}};
 assert.deepEqual(resolve(w),{date:'2026-09-21',source:'approved_legacy'});
 assert.equal(resolve({...w,mixLot:'ANOTHER-LOT'}),null);
});
for(const qty of [56,44,50,48])test(`legacy packaging ${qty} labels uses existing completion date and retains all production fields`,async()=>{
 const wip={...base(),qty,details:base().details+'\n[2026-09-20 12:34:56] [열처리완료] 1호기'};
 const h=setup({wip});await h.print();
 assert.equal(h.jobs.length,1);assert.equal(h.jobs[0].quantity,qty);assert.equal(h.jobs[0].mfgDate,'2026-09-20');assert.equal(h.jobs[0].mfgDateSource,'process_history');
 for(const key of ['qty','currentStep','mixLot','packLot','shrinkageRate'])assert.deepEqual(h.record()[key],wip[key]);
 assert.equal(h.record().heatTreatmentHistory,undefined);assert.ok(h.record().details.startsWith(wip.details));
});
test('missing records require explicit date, evidence and operator before creating any print job',async()=>{
 for(const form of [{},{labelMfgDate:'2099-01-01',labelMfgReason:'일지',operator:'담당'},{labelMfgDate:'2026-02-30',labelMfgReason:'일지',operator:'담당'},{labelMfgDate:'2026-09-20'},{labelMfgDate:'2026-09-20',labelMfgReason:'일지'}]){
  const h=setup({form});await h.print();assert.equal(h.jobs.length,0);assert.deepEqual(h.record(),h.before);
 }
});
test('confirmed date is label-only, audited atomically, retained on reprint without fabricated heat history',async()=>{
 const h=setup({form:{labelMfgDate:'2026-09-20',labelMfgReason:'열처리 작업일지 확인',operator:'담당',defects:'1'}});await h.print();
 assert.equal(h.jobs[0].quantity,55);assert.equal(h.jobs[0].mfgDate,'2026-09-20');assert.equal(h.jobs[0].mfgDateSource,'confirmed');
 const record=h.record();assert.equal(record.heatTreatmentHistory,undefined);assert.equal(record.qty,56);assert.equal(record.currentStep,'step8');
 assert.deepEqual(record.labelManufacturingDateConfirmation,{date:'2026-09-20',reason:'열처리 작업일지 확인',confirmedBy:'담당',confirmedAt:today+' 10:30:00'});
 assert.match(record.details,/라벨 제조일 확인/);assert.doesNotMatch(record.details,/\[열처리완료\]/);
 const reprint=setup({wip:record,form:{defects:'1'}});await reprint.print();assert.equal(reprint.jobs[0].mfgDate,'2026-09-20');
 assert.equal((reprint.record().details.match(/\[라벨 제조일 확인\]/g)||[]).length,1);
});
test('failed print commit neither confirms a date nor appends a success history',async()=>{
 const h=setup({form:{labelMfgDate:'2026-09-20',labelMfgReason:'일지',operator:'담당'},failCommit:true});await h.print();assert.deepEqual(h.record(),h.before);assert.equal(h.jobs.length,0);
});
test('a date changed by another screen blocks stale output, including a concurrent manual confirmation',async()=>{
 const w=base();
 const cases=[{wip:{...w,details:'[2026-09-20 10:00:00] [열처리완료]'},live:{...w,details:'[2026-09-21 10:00:00] [열처리완료]'}},
 {wip:w,live:{...w,labelManufacturingDateConfirmation:{date:'2026-09-21',confirmedBy:'다른 담당',reason:'일지',confirmedAt:today}},form:{labelMfgDate:'2026-09-20',labelMfgReason:'일지',operator:'담당'}}];
 for(const scenario of cases){const h=setup(scenario);await h.print();assert.equal(h.jobs.length,0);assert.deepEqual(h.record(),h.before);assert.match(h.toasts.at(-1).message,/제조일 기록이 변경/);}
});
test('normal structured records and measured/experimental fields continue through the same handler',async()=>{
 const w={...base(),heatTreatmentHistory:[{completedAt:'2026-09-22 18:00:00'}]};const h=setup({wip:w});await h.print();assert.equal(h.jobs[0].mfgDate,'2026-09-22');assert.deepEqual(h.record().heatTreatmentHistory,w.heatTreatmentHistory);
 const ex=setup({wip:{...w,isExperimental:true,shrinkageStatus:'not_measured',shrinkageRate:null}});await ex.print();assert.equal(ex.jobs[0].shrinkage,'미측정');assert.equal(ex.jobs[0].mfgDate,'2026-09-22');
});
