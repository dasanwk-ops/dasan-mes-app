import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemoryDatabase,configureDatabase} from '../src/mesDatabase.mjs';
import {createOperations} from '../src/mesOperations.mjs';

const root='artifacts/demo-mes/public/data';
function setup({order,wips=[],ships=[]}){
  const seed={
    [`${root}/orderList/${order.id}`]:order,
    [`${root}/equipment/furnaces`]:{'1':{isHeating:false,temp:'1050',operator:'',slotData:{}},'2':{isHeating:false,temp:'1050',operator:'',slotData:{}}},
    [`${root}/equipment/shrinkDesks`]:{'1':{step:0,slotData:{},queue:[]},'2':{step:0,slotData:{},queue:[]}},
    [`${root}/equipment/dryingRoom`]:{dryingWipIds:[],cartItems:[],completionData:{}},
  };
  for(const w of wips) seed[`${root}/wipList/${w.id}`]=w;
  for(const h of ships) seed[`${root}/shippingHistory/${h.id}`]=h;
  const db=createMemoryDatabase(seed);
  configureDatabase(db,{root,canWrite:()=>true,actor:()=> 'TEST'});
  return {db,ops:createOperations(db,root,()=>true),get:(c,id)=>db.docs.get(`${root}/${c}/${id}`)};
}

test('remainder close preserves original order qty and linked WIP',async()=>{
  const order={id:'o1',orderNo:'ORD-DEMO-1',qty:100,status:'생산중',color:'345 BL3',height:'25',singleWeight:650};
  const w={id:'w1',orderId:'o1',mixLot:'MIX-DEMO-1',qty:98,currentStep:'step5',type:'345 BL3',height:'25',singleWeight:650,details:'original'};
  const s=setup({order,wips:[w]});
  const result=await s.ops.closeOrderRemainder(order,{operator:'MASTER',reason:'2EA 미생산 마감'});
  assert.equal(result.remainder,2);
  assert.equal(s.get('orderList','o1').qty,100);
  assert.equal(s.get('orderList','o1').status,'잔량마감');
  assert.equal(s.get('orderList','o1').remainderClosedQty,2);
  assert.equal(s.get('wipList','w1').qty,98);
});

test('closed order rejects further release',async()=>{
  const order={id:'o1',orderNo:'ORD-DEMO-1',qty:100,status:'생산중',color:'345 BL3',height:'25',singleWeight:650};
  const w={id:'w1',orderId:'o1',mixLot:'MIX-DEMO-1',qty:98,currentStep:'step5',type:'345 BL3',height:'25',singleWeight:650,details:'original'};
  const s=setup({order,wips:[w]});
  await s.ops.closeOrderRemainder(order,{operator:'MASTER',reason:'마감'});
  const closed=s.get('orderList','o1');
  await assert.rejects(s.ops.release(closed,1));
});

test('history-less order must use cancel instead of remainder close',async()=>{
  const order={id:'o1',orderNo:'ORD-EMPTY',qty:10,status:'대기중',color:'345 BL3',height:'25',singleWeight:650};
  const s=setup({order});
  await assert.rejects(s.ops.closeOrderRemainder(order,{operator:'MASTER',reason:'정리'}));
});
