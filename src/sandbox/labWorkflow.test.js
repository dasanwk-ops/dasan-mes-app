import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {Simulate} from 'react-dom/test-utils';
import App from '../App';
import {doc,getFirestore,setDoc,deleteDoc} from './firestore';
const ROOT='artifacts/dasan-mes-app/public/data/';
const stored=()=>JSON.parse(sessionStorage.getItem('dasan-lab-furnace-preview-v1'))||{};
const ref=path=>doc(getFirestore(),ROOT+path);
const node=(scope,text,tag='button')=>{
  const found=[...scope.querySelectorAll(tag)].find(n=>n.textContent.trim()===text);
  if(!found)throw Error(`Missing UI: ${text}`);return found;
};
const click=async n=>act(async()=>{Simulate.click(n);});
const change=async(n,value)=>act(async()=>{Simulate.change(n,{target:{value}});});
const check=async(n,checked)=>act(async()=>{Simulate.change(n,{target:{checked}});});
const blur=async n=>act(async()=>{Simulate.blur(n);});
const records=name=>Object.entries(stored()).filter(([p])=>p.startsWith(ROOT+name+'/')).map(([,v])=>v);
const jobs=()=>Object.entries(stored()).filter(([p])=>p.startsWith('print-queue/')).map(([,v])=>v);
let container,root;
beforeEach(async()=>{
  global.IS_REACT_ACT_ENVIRONMENT=true;global.fetch=jest.fn(()=>{throw Error('Network forbidden in preview');});
  for(const path of Object.keys(stored())){
    if(path.startsWith('print-queue/')||(path.startsWith(ROOT)&&['wipList','orderList','shippingHistory','shrinkArchives'].some(n=>path.startsWith(ROOT+n+'/'))&&!path.includes('/demo-')))await deleteDoc(doc(getFirestore(),path));
  }
  await setDoc(ref('equipment/furnaces'),Object.fromEntries([1,2,'lab'].map(id=>[id,{isHeating:false,temp:'1050',operator:'',memo:'',slotData:{}}])));
  await setDoc(ref('equipment/shrinkDesks'),{});
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();expect(global.fetch).not.toHaveBeenCalled();});
const render=async()=>act(async()=>root.render(<App/>));
const wip=(id,qty,extra={})=>({id,mixLot:`LOT-${id}`,qty,type:'234 BL2',height:'25',currentStep:'step5',isExperimental:true,includeShrinkageSpecimen:true,
  details:`prior history ${id}`,heatTreatmentHistory:[{furnaceId:1,completedAt:'2026-09-22 12:00:00'}],...extra});
for(const [weight,full,remainder] of [['2.600',false,true],['15.000',true,false],['17.600',true,true]]){
  test(`mixing ${weight}kg only displays containers that will actually be prepared`,async()=>{
    await setDoc(ref('wipList/mix-ui'),wip('mix-ui',4,{currentStep:'step2',weight,singleWeight:650,includeShrinkageSpecimen:false}));
    await render();await click(node(container,'혼합'));
    const plan=container.querySelector('[data-testid="mix-container-plan"]');
    expect(plan.textContent.includes('15kg 통 1개당 투입량')).toBe(full);
    expect(plan.textContent.includes('최종 미달 통')).toBe(remainder);
    if(!full){expect(plan.textContent).toContain('2.487');expect(plan.textContent).not.toContain('14.348');expect(container.textContent).not.toContain('15kg 꽉 찬 통');}
  });
}

test('mixed products 2 + 3 + 5 share the lab, reject overflow, preserve history and measure per lot without locations',async()=>{
  const originals=[wip('a',2),wip('b',3,{includeShrinkageSpecimen:false}),wip('c',5)];
  for(const item of originals)await setDoc(ref('wipList/'+item.id),item);
  const preserved=stored()[ROOT+'wipList/demo-history'];const furnace1=stored()[ROOT+'equipment/furnaces'][1];
  await render();const lab=()=>container.querySelector('[data-testid="furnace-lab"]');
  const add=async(id,first=false)=>{
    await click(node(container,'LOT-'+id,'div'));
    await click(first?[...lab().querySelectorAll('span')].find(n=>n.textContent.includes('단일 공간')):[...lab().querySelectorAll('button')].find(n=>n.textContent.startsWith('선택 제품 추가')));
    await click(node(container,'확인'));
  };
  await add('a',true);await add('b');
  expect(Object.values(stored()[ROOT+'equipment/furnaces'].lab.slotData).map(s=>s.qty)).toEqual([2,3]);
  // A six-piece lot cannot replace an existing entry when only five spaces remain.
  await click(node(container,'TEST-LAB-001','div'));
  await click([...lab().querySelectorAll('button')].find(n=>n.textContent.startsWith('선택 제품 추가')));
  expect(container.textContent).toContain('잔여 용량은 5개');await click(node(container,'확인'));
  expect(Object.values(stored()[ROOT+'equipment/furnaces'].lab.slotData).map(s=>s.qty)).toEqual([2,3]);
  await click(lab().querySelector('[aria-label="LOT-b 배정 제거"]'));
  expect(Object.values(stored()[ROOT+'equipment/furnaces'].lab.slotData).map(s=>s.wipId)).toEqual(['a']);
  await add('b');await add('c');
  expect(lab().textContent).toContain('합계 10 / 10개');
  expect(lab().textContent).not.toContain('선택 제품 추가');
  await change(lab().querySelector('[placeholder="성명"]'),'실험 담당');await blur(lab().querySelector('[placeholder="성명"]'));
  await click(node(lab(),'실험로 가동 시작'));await click(node(lab(),'실험로 완료 · 측정 이관'));await click(node(container,'확인'));
  for(const item of originals){const out=stored()[ROOT+'wipList/'+item.id];expect(out.qty).toBe(item.qty);expect(out.currentStep).toBe('step5_shrink');expect(out.heatTreatmentHistory).toHaveLength(2);}
  await click(node(container,'수축률 측정'));
  const desk=()=>container.querySelector('[data-testid="shrink-lab"]');
  const measurement=id=>container.querySelector(`[data-testid="measurement-${id}"]`);
  expect(desk().querySelector('select')).toBeNull();expect(desk().textContent).not.toContain('시편 위치');
  await check(measurement('b').querySelector('input[type="checkbox"]'),true);
  await change(measurement('a').querySelector('input[type="number"]'),'100');
  await change(measurement('c').querySelector('input[type="number"]'),'100');
  await click(node(desk(),'[1단계] 소결 전 면적 임시저장 및 잠금'));await click(node(container,'확인'));
  expect(measurement('b').querySelector('input[type="number"]')).toBeNull();
  await change(measurement('a').querySelector('input[type="number"]'),'90.25');
  await change(measurement('c').querySelector('input[type="number"]'),'64');
  await click(node(desk(),'[2단계] 수축률 분석 및 결과 확정'));
  const result=records('wipList').filter(w=>originals.some(o=>o.mixLot===w.mixLot));
  expect(result).toHaveLength(3);expect(result.reduce((n,w)=>n+w.qty,0)).toBe(10);
  expect(result.find(w=>w.mixLot==='LOT-a')).toMatchObject({qty:2,currentStep:'step6',shrinkageRate:'5.00',shrinkageStatus:'measured'});
  expect(result.find(w=>w.mixLot==='LOT-b')).toMatchObject({id:'b',qty:3,currentStep:'step6',shrinkageRate:null,shrinkageStatus:'not_measured'});
  expect(result.find(w=>w.mixLot==='LOT-c')).toMatchObject({qty:5,currentStep:'step6',shrinkageRate:'20.00'});
  for(const item of result){expect(item.details).toContain('prior history');expect(item.heatTreatmentHistory).toHaveLength(2);}
  expect(stored()[ROOT+'wipList/demo-history']).toEqual(preserved);expect(stored()[ROOT+'equipment/furnaces'][1]).toEqual(furnace1);
  expect(records('shrinkArchives').find(a=>a.kind==='completed').results).toHaveLength(3);
});

test('ordinary furnace still requires specimen position',async()=>{
  await setDoc(ref('wipList/normal-measure'),wip('normal-measure',2,{currentStep:'step5_shrink',isExperimental:false}));
  await setDoc(ref('equipment/shrinkDesks'),{1:{batchId:'normal',step:1,operator:'담당',memo:'',queue:[],slotData:{L1:{wipId:'normal-measure',qty:2,mixLot:'LOT-normal-measure',measurements:[{position:'',preArea:'100',postArea:''}]}}}});
  await render();await click(node(container,'수축률 측정'));const desk=container.querySelector('[data-testid="shrink-1"]');
  expect(desk.querySelector('select')).not.toBeNull();await click(node(desk,'[1단계] 소결 전 면적 임시저장 및 잠금'));
  expect(container.textContent).toContain("모든 시편의 '위치'");expect(stored()[ROOT+'equipment/shrinkDesks'][1].step).toBe(1);
});

const packaging=async(extra={})=>{
  const item=wip('pack',3,{currentStep:'step8',packLot:'F-EXPERIMENT',shrinkageRate:null,shrinkageStatus:'not_measured',includeShrinkageSpecimen:false,...extra});
  await setDoc(ref('wipList/pack'),item);await render();await click(node(container,'포장 (라벨링)'));return item;
};
for(const measured of [false,true])test(`experimental ${measured?'measured':'unmeasured'} labels match good quantity; packaging and shipped tracking retain TEST`,async()=>{
  const item=await packaging(measured?{shrinkageRate:'5.00',shrinkageStatus:'measured',includeShrinkageSpecimen:true}:{});
  const row=()=>container.querySelector('[data-testid="package-pack"]');
  await change(row().querySelector('[placeholder="불량"]'),'1');
  const print=node(row(),'라벨출력 2장');
  // Double-click in a single event turn must create only one queue item.
  await act(async()=>{Simulate.click(print);Simulate.click(print);});
  expect(jobs()).toHaveLength(1);expect(jobs()[0]).toMatchObject({quantity:2,unitQty:1,isExperimental:true,labelType:'experimental',gtin:'08600015381754'});
  expect(jobs()[0].displayName).toContain('[TEST]');expect(jobs()[0].shrinkage).toBe(measured?'5.00':'미측정');
  expect(jobs()[0].scaleFactor).toBe(measured?'1.0526':'미측정');
  expect(container.querySelectorAll('[data-testid="label-copy"]')).toHaveLength(2);
  expect(stored()[ROOT+'wipList/pack'].labelPrintHistory).toHaveLength(1);
  await change(row().querySelector('[placeholder="작업자"]'),'포장 담당');
  await click(node(row(),'포장완료'));
  expect(stored()[ROOT+'wipList/pack']).toMatchObject({currentStep:'done',qty:2,isExperimental:true});
  expect(stored()[ROOT+'wipList/pack'].details).toContain(item.details);
  await click(node(container,'완제품 창고'));
  await change(container.querySelector('[placeholder="수량"]'),'2');await change(container.querySelector('select'),'이엔씨');
  await change(container.querySelector('[placeholder="담당자"]'),'출고 담당');await click(node(container,'출고'));await click(node(container,'확인'));
  expect(records('shippingHistory')[0]).toMatchObject({qty:2,isExperimental:true,shrinkageStatus:measured?'measured':'not_measured'});
  await click(node(container,'로트 이력 추적'));
  await change(container.querySelector('input[type="text"]'),'실험용');await click(node(container,'통합 검색'));
  const badge=[...container.querySelectorAll('[data-testid="experimental-badge"]')].find(n=>n.closest('.border-2').textContent.includes('F-EXPERIMENT'));
  expect(badge.textContent).toContain('실험용 / TEST');expect(container.textContent).toContain('F-EXPERIMENT');
  if(!measured)expect(badge.textContent).toContain('수축률 미측정');
});

test('ordinary measured labels preserve production fields and quantity, but missing rates are rejected',async()=>{
  await packaging({isExperimental:false,shrinkageRate:'5.00',shrinkageStatus:'measured'});
  let row=container.querySelector('[data-testid="package-pack"]');await click(node(row,'라벨출력 3장'));
  expect(jobs()[0]).toMatchObject({quantity:3,unitQty:1,labelType:'production',isExperimental:false,gtin:'08600015381754',scaleFactor:'1.0526'});
  await act(async()=>setDoc(ref('wipList/pack'),{...stored()[ROOT+'wipList/pack'],shrinkageRate:null,shrinkageStatus:'not_measured'}));
  row=container.querySelector('[data-testid="package-pack"]');await click(node(row,'재출력 3장'));
  expect(jobs()).toHaveLength(1);expect(container.textContent).toContain('수축률 데이터가 필요');
});

test('invalid label quantities and a concurrent quantity change cannot create a wrong queue entry',async()=>{
  const item=await packaging();const row=()=>container.querySelector('[data-testid="package-pack"]');
  for(const bad of ['-1','1.5','3','4']){
    await change(row().querySelector('[placeholder="불량"]'),bad);
    const print=[...row().querySelectorAll('button')].find(n=>n.textContent.includes('라벨출력'));
    if(!print.disabled)await click(print);expect(jobs()).toHaveLength(0);
  }
  await change(row().querySelector('[placeholder="불량"]'),'0');
  const print=node(row(),'라벨출력 3장');
  await act(async()=>{const update=setDoc(ref('wipList/pack'),{...item,qty:2});Simulate.click(print);await update;});
  expect(jobs()).toHaveLength(0);expect(stored()[ROOT+'wipList/pack'].labelPrintedAt).toBeUndefined();
  expect(container.textContent).toContain('제품 조건이 변경');
});

test('changing defects after requesting labels requires reprinting before packaging completes',async()=>{
  await packaging();const row=()=>container.querySelector('[data-testid="package-pack"]');
  await click(node(row(),'라벨출력 3장'));await change(row().querySelector('[placeholder="불량"]'),'1');await change(row().querySelector('[placeholder="작업자"]'),'포장 담당');
  await click(node(row(),'포장완료'));expect(stored()[ROOT+'wipList/pack'].currentStep).toBe('step8');
  expect(container.textContent).toContain('라벨을 재출력');await click(node(row(),'재출력 2장'));await click(node(row(),'포장완료'));
  expect(stored()[ROOT+'wipList/pack'].currentStep).toBe('done');expect(jobs().map(j=>j.quantity)).toEqual([3,2]);
});
