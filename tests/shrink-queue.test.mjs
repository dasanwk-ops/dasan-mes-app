import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewShrinkage} from '../src/mesShrinkReview.mjs';
import {switchShrinkBatch} from '../src/mesShrinkQueue.mjs';
import {createMemoryDatabase,configureDatabase} from '../src/mesDatabase.mjs';
import {canonical} from '../src/mesSafetyCore.mjs';
const root='artifacts/demo-mes/public/data';
const w=(id='ready',n=10)=>({id,mixLot:`MIX-DEMO-${id}`,qty:n,type:'345 BL3',height:'25',currentStep:'step5_shrink'});
const slot=(v,n=v.qty)=>({wipId:v.id,mixLot:v.mixLot,type:v.type,height:v.height,qty:n,measurements:[{position:'',preArea:'',postArea:''}]});
function scenario(){
 const good=w(), old={batchId:'old',step:2,revision:6,operator:'TEST',memo:'PRESERVE',slotData:{R2:slot(w('gone'),4)},queue:[{batchId:'ready-batch',step:1,revision:0,slotData:{L1:slot(good)}}]};
 const desks={'1':old,'2':{step:0,slotData:{},queue:[]}}, furnaces={'1':{isHeating:false,slotData:{}}};
 const db=createMemoryDatabase({[`${root}/equipment/shrinkDesks`]:desks,[`${root}/equipment/furnaces`]:furnaces,[`${root}/wipList/${good.id}`]:good});
 configureDatabase(db,{root,canWrite:()=>true});
 return {db,desks,furnaces,good,old};
}
const read=s=>s.db.docs.get(`${root}/equipment/shrinkDesks`);
const run=s=>switchShrinkBatch(s.db,root,1,s.old,'ready-batch','TEST');
function changeDesk(s,fn){const d=read(s);fn(d);s.old=structuredClone(d['1']);s.desks=d;}
const issues=(s,b='ready-batch')=>reviewShrinkage([s.good],s.desks,s.furnaces).batches.find(r=>r.batchId===b).issues.map(i=>i.code);

test('RC3 reports orphan quantities as links, not extra stock',()=>{
 const s=scenario(),r=reviewShrinkage([s.good],s.desks);
 assert.equal(r.orphanSlotCount,1);assert.equal(r.orphanSlotQty,4);assert.equal(r.pending[0].quantity,10);assert.equal(r.pending[0].unlinkedQty,0);
});
test('RC3 valid unmeasured work can be selected but is not declared measured',()=>{
 const s=scenario(),r=reviewShrinkage([s.good],s.desks).batches.find(b=>b.batchId==='ready-batch');
 assert.equal(r.selectable,true);assert.equal(r.preMissing,1);assert.equal(r.postMissing,1);
});
test('RC3 selecting valid work preserves old measurements and WIP exactly',async()=>{
 const s=scenario(),before=canonical(s.db.docs.get(`${root}/wipList/ready`)),old=structuredClone(s.old);delete old.queue;
 await run(s);assert.equal(read(s)['1'].batchId,'ready-batch');assert.deepEqual(read(s)['1'].queue[0],old);
 assert.equal(canonical(s.db.docs.get(`${root}/wipList/ready`)),before);
 const audit=[...s.db.docs].filter(([p])=>p.startsWith(`${root}/mesAudit/`));assert.equal(audit.length,1);
 assert.equal(audit[0][1].metadata.kind,'select-shrink-batch');assert.equal(audit[0][1].changes.length,1);
 assert.equal(audit[0][1].changes[0].path,`${root}/equipment/shrinkDesks`);
});
test('RC3 records with no matching ID are not repaired from similar LOT names',async()=>{
 const s=scenario();s.db.docs.delete(`${root}/wipList/ready`);s.db.docs.set(`${root}/wipList/other`,{...s.good,id:'other'});
 await assert.rejects(run(s));assert.equal(read(s)['1'].batchId,'old');
});
test('RC3 changing a WIP quantity before selection rejects the whole operation',async()=>{
 const s=scenario();s.db.docs.get(`${root}/wipList/ready`).qty=12;const before=canonical([...s.db.docs]);
 await assert.rejects(run(s));assert.equal(canonical([...s.db.docs]),before);
});
test('RC3 moved WIP cannot become active measurement work',async()=>{
 const s=scenario();s.db.docs.get(`${root}/wipList/ready`).currentStep='step6';await assert.rejects(run(s));
});
test('RC3 selecting a batch with repeated identity is blocked',async()=>{
 const s=scenario();changeDesk(s,d=>d['1'].queue.push(structuredClone(d['1'].queue[0])));await assert.rejects(run(s));
});
test('RC3 a concurrently changed active batch is never overwritten',async()=>{
 const s=scenario();read(s)['1'].memo='NEW INPUT';const before=canonical([...s.db.docs]);await assert.rejects(run(s));assert.equal(canonical([...s.db.docs]),before);
});
test('RC3 new incoming work added to the queue makes stale selection retry explicitly',async()=>{
 const s=scenario();read(s)['1'].queue.push({batchId:'incoming',step:1,slotData:{}});await assert.rejects(run(s));assert.equal(read(s)['1'].queue.length,2);
});
test('RC3 duplicate button clicks have only one successful transaction',async()=>{
 const s=scenario(),r=await Promise.allSettled([run(s),run(s)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal(read(s)['1'].queue.length,1);
});
test('RC3 failed commit keeps queue, audit, quantities and measurements unchanged',async()=>{
 const s=scenario(),before=canonical([...s.db.docs]);s.db.failNextCommit=true;await assert.rejects(run(s));assert.equal(canonical([...s.db.docs]),before);
});
test('RC3 same WIP referenced by two batches is blocked',async()=>{
 const s=scenario();changeDesk(s,d=>d['1'].slotData.R4=slot(s.good));await assert.rejects(run(s));assert.ok(issues(s).includes('duplicate'));
});
test('RC3 same WIP referenced by another furnace desk is blocked',async()=>{
 const s=scenario();changeDesk(s,d=>d['2']={batchId:'other',step:1,slotData:{L2:slot(s.good)},queue:[]});await assert.rejects(run(s));
});
test('RC3 physical furnace link blocks selecting that WIP for measurement',async()=>{
 const s=scenario();s.db.docs.get(`${root}/equipment/furnaces`)['1'].slotData.L1=slot(s.good);await assert.rejects(run(s));
});
test('RC3 product and height mismatch are blocked',async()=>{
 for(const field of ['mixLot','type','height']){const s=scenario();changeDesk(s,d=>d['1'].queue[0].slotData.L1[field]='OTHER');await assert.rejects(run(s));assert.ok(issues(s).includes('product'));}
});
test('RC3 zero, fractional, missing, boolean and negative slot quantities are blocked',async()=>{
 for(const q of [0,-1,1.5,null,true,'',NaN]){const s=scenario();changeDesk(s,d=>d['1'].queue[0].slotData.L1.qty=q);await assert.rejects(run(s));}
});
test('RC3 original heat positions must match if present',async()=>{
 const s=scenario();s.db.docs.get(`${root}/wipList/ready`).furnaceSlots=[{fid:1,slotId:'R3',qty:10}];await assert.rejects(run(s));
});
test('RC3 numeric legacy IDs and old product names remain supported',()=>{
 const v=w('123');v.type='BL3';const d={'1':{batchId:'legacy',step:1,slotData:{R1:{...slot(v),wipId:123,type:'345 BL3'}},queue:[]}};
 assert.equal(reviewShrinkage([v],d).batches[0].selectable,true);
});
test('RC3 partial and absent allocation are distinguished without inventing slots',()=>{
 const v=w('partial',46),absent=w('absent',50),d={'1':{batchId:'mixed',step:2,slotData:{L5:slot(v,22)},queue:[]}},before=canonical(d);
 const r=reviewShrinkage([v,absent],d);assert.equal(r.pending[0].unlinkedQty,24);assert.equal(r.pending[0].status,'quantity-mismatch');assert.equal(r.pending[1].status,'unregistered');assert.equal(canonical(d),before);
});
test('RC3 new queued work can proceed without deleting a corrupt partial old batch',async()=>{
 const s=scenario(),partial=w('partial',46);s.db.docs.set(`${root}/wipList/partial`,partial);changeDesk(s,d=>d['1'].slotData.L5=slot(partial,22));
 await run(s);assert.equal(read(s)['1'].queue[0].slotData.L5.qty,22);assert.equal(s.db.docs.get(`${root}/wipList/partial`).qty,46);
});
test('RC3 malformed nested queues fail closed',async()=>{
 const s=scenario();changeDesk(s,d=>d['1'].queue[0].queue=[{batchId:'hidden',slotData:{}}]);await assert.rejects(run(s));
});
test('RC3 inspection itself performs no mutations',()=>{
 const s=scenario(),before=canonical(s);reviewShrinkage([s.good],s.desks,s.furnaces);assert.equal(canonical(s),before);
});
