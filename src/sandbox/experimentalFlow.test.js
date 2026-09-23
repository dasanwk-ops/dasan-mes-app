import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import App from '../App';
import { doc, getFirestore, setDoc, deleteDoc } from './firestore';

const ROOT = 'artifacts/dasan-mes-app/public/data/';
const stored = () => JSON.parse(sessionStorage.getItem('dasan-lab-furnace-preview-v1'));
const ref = path => doc(getFirestore(), ROOT + path);
const node = (scope, text, tag = 'button') => {
  const found = [...scope.querySelectorAll(tag)].find(n => n.textContent.trim() === text);
  if (!found) throw Error(`Missing UI: ${text}`);
  return found;
};
const click = async n => act(async () => { Simulate.click(n); });
const change = async (n, value) => act(async () => { Simulate.change(n, { target: { value } }); });
const check = async (n, checked) => act(async () => { Simulate.change(n, { target: { checked } }); });
const blur = async n => act(async () => { Simulate.blur(n); });
let container, root;
beforeEach(async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.fetch = jest.fn(() => { throw Error('Unexpected network request'); });
  // Each test owns these fixture rows; retain seeded unrelated production history.
  for (const path of Object.keys(stored() || {})) {
    if ((path.includes('/orderList/') || path.includes('/inventoryHistory/') || path.includes('/shrinkArchives/') || path.includes('/wipList/')) && !path.includes('/demo-')) await deleteDoc(ref(path.slice(ROOT.length)));
  }
  await setDoc(ref('equipment/shrinkDesks'), {});
  await setDoc(ref('equipment/furnaces'), Object.fromEntries([1,2,'lab'].map(id => [id,{ isHeating:false,temp:'1050',operator:'',memo:'',slotData:{} }])));
  await setDoc(ref('inventory/demo-4Y-W'), { id:'demo-4Y-W', type:'4Y-W',lot:'TEST-POWDER-4Y-W', weight:100 });
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  expect(global.fetch).not.toHaveBeenCalled();
});
const render = async () => act(async () => root.render(<App />));
const values = name => Object.entries(stored()).filter(([p]) => p.startsWith(ROOT+name+'/')).map(([,v])=>v);

for (const scenario of [
  {name:'experimental without specimen',experimental:true,specimen:false,kg:6.28},
  {name:'experimental with specimen',experimental:true,specimen:true,kg:6.48},
  {name:'ordinary production retains allowance',experimental:false,specimen:true,kg:6.543},
]) {
  test(`${scenario.name}: order → warehouse → actual powder consumption → molding`, async () => {
    await render();
    const preserved = stored()[ROOT+'wipList/demo-history'];
    await click(node(container, '발주 관리'));
    await click(node(container, '345 BL0'));
    await change(container.querySelector('form').querySelectorAll('input[type="number"]')[1], '10');
    if (scenario.experimental) {
      await check(container.querySelector('[aria-label="실험용 생산"]'), true);
      if (scenario.specimen) {
        await check(container.querySelector('[aria-label="수축률 시편 포함"]'), true);
        // Missing specimen powder must not create a zero-powder specimen order.
        await act(async () => Simulate.submit(container.querySelector('form')));
        expect(values('orderList')).toHaveLength(0);
        await change(container.querySelector('[aria-label="시편 추가 분말"]'), '200');
      }
    }
    expect(container.querySelector('[data-testid="order-bom"]').textContent).toContain(scenario.kg.toFixed(3)+'kg');
    await act(async () => Simulate.submit(container.querySelector('form')));
    const order = values('orderList')[0];
    expect(order.isExperimental).toBe(scenario.experimental);
    expect(order.includeShrinkageSpecimen).toBe(scenario.specimen);
    await change(container.querySelector('[placeholder="수량"]'), '10');
    await click(node(container, '공정 투입')); await click(node(container, '확인'));
    const wip = values('wipList').find(w => w.orderId === order.id);
    expect(wip.includeShrinkageSpecimen).toBe(scenario.specimen);
    await click(node(container, '원재료 창고'));
    expect(container.textContent).toContain(`합계: ${scenario.kg.toFixed(3)} kg`);
    await change(container.querySelector('[placeholder="작업자"]'), '소재 담당');
    await click(node(container, '배합실 이관'));
    expect(stored()[ROOT+'wipList/'+wip.id].weight).toBe(scenario.kg.toFixed(3));
    await click(node(container, '혼합'));
    await change(container.querySelector('select'), 'demo-4Y-W');
    await change(container.querySelector('[placeholder="작업자 성명"]'), '혼합 담당');
    await click(node(container, '배합 완료 및 재고 차감'));
    expect(stored()[ROOT+'wipList/'+wip.id].currentStep).toBe('step3');
    expect(stored()[ROOT+'inventory/demo-4Y-W'].weight).toBeCloseTo(100-scenario.kg, 3);
    expect(values('inventoryHistory')[0].qty).toBe(scenario.kg);
    await click(node(container, '1차 성형'));
    expect(container.querySelector('input[type="checkbox"]').checked).toBe(scenario.specimen);
    if (scenario.experimental) {
      await change(container.querySelector('[placeholder="작업자 성명"]'),'성형 담당');
      await click(node(container,'1차 성형 완료'));
      await click(node(container,'2차 성형'));
      await change(container.querySelector('[placeholder="작업자 성명"]'),'성형 담당');
      await change(container.querySelector('[placeholder="0"]'),'10');
      await click(node(container,'2차 성형 데이터 저장 및 열처리 이관'));
      const molded=values('wipList').find(w=>w.orderId===order.id);
      expect(molded.currentStep).toBe('step5');
      expect(molded.includeShrinkageSpecimen).toBe(scenario.specimen);
      await click(node(container,'열처리'));
      const lab=()=>container.querySelector('[data-testid="furnace-lab"]');
      await click(node(container,molded.mixLot,'div'));
      await click([...lab().querySelectorAll('span')].find(n=>n.textContent.includes('단일 공간')));
      await click(node(container,'확인'));
      await change(lab().querySelector('[placeholder="성명"]'),'열처리 담당'); await blur(lab().querySelector('[placeholder="성명"]'));
      await click(node(lab(),'실험로 가동 시작')); await click(node(lab(),'실험로 완료 · 측정 이관'));
      await click(node(container,'확인')); await click(node(container,'수축률 측정'));
      await click(node(container.querySelector('[data-testid="shrink-lab"]'),'수축률 미측정으로 검수 이관'));
      await click(node(container,'확인'));
      const result=stored()[ROOT+'wipList/'+molded.id];
      expect(result).toMatchObject({qty:10,orderId:order.id,currentStep:'step6',shrinkageStatus:'not_measured',shrinkageRate:null});
      expect(result.includeShrinkageSpecimen).toBe(scenario.specimen);
      expect(result.heatTreatmentHistory).toHaveLength(1);
      for (const history of ['지시분할투입','소재창고','배합완료','1차성형','2차성형','열처리완료','수축률 미측정']) expect(result.details).toContain(history);
    }
    expect(stored()[ROOT+'wipList/demo-history']).toEqual(preserved);
  });
}

test('experimental release caps each lot at ten; unchecked specimen ignores a previously entered amount', async () => {
  await render(); await click(node(container, '발주 관리')); await click(node(container, '345 BL0'));
  await change(container.querySelector('form').querySelectorAll('input[type="number"]')[1], '20');
  await check(container.querySelector('[aria-label="실험용 생산"]'), true);
  await check(container.querySelector('[aria-label="수축률 시편 포함"]'), true);
  await change(container.querySelector('[aria-label="시편 추가 분말"]'), '200');
  expect(container.querySelector('[data-testid="order-bom"]').textContent).toContain('12.960kg');
  await check(container.querySelector('[aria-label="수축률 시편 포함"]'), false);
  expect(container.querySelector('[data-testid="order-bom"]').textContent).toContain('12.560kg');
  await act(async () => Simulate.submit(container.querySelector('form')));
  const order = values('orderList')[0];
  expect(order.specimenPowderG).toBe(0);
  await change(container.querySelector('[placeholder="수량"]'), '11');
  await click(node(container, '공정 투입'));
  expect(container.textContent).toContain('1회 투입을 10개 이하');
  expect(values('wipList').filter(w => w.orderId === order.id)).toHaveLength(0);
  await change(container.querySelector('[placeholder="수량"]'), '10');
  await click(node(container, '공정 투입')); await click(node(container, '확인'));
  expect(values('wipList').find(w => w.orderId === order.id).qty).toBe(10);
});

const fixture = async ({step=1, qty=10, queuedDuplicate=false}={}) => {
  const wip = {id:'lab-test', mixLot:'LAB-TEST', orderId:'keep-order', qty, isExperimental:true,includeShrinkageSpecimen:false,specimenPowderG:0,
    type:'345 BL0',height:'25',currentStep:'step5_shrink',details:'prior order and molding history',
    heatTreatmentHistory:[{furnaceId:'lab',operator:'열처리 담당'}],shrinkageHistory:[{status:'measured',value:'4.8'}],shrinkageRate:'4.8'};
  const batch = {batchId:'test-batch',step,operator:'열처리 담당',memo:'keep memo',slotData:{SINGLE:{wipId:wip.id,mixLot:wip.mixLot,qty,
    measurements:[{position:'',preArea:'',postArea:'',calcShrink:'',calcExpand:''}]}}};
  const queued = {...batch,batchId:'next-batch',slotData:{SINGLE:{...batch.slotData.SINGLE,wipId:queuedDuplicate?wip.id:'next-wip'}}};
  await setDoc(ref('wipList/lab-test'),wip);
  await setDoc(ref('equipment/shrinkDesks'),{1:{step:1,slotData:{L1:{...batch.slotData.SINGLE,wipId:'untouched',qty:3}}},lab:{...batch,queue:[queued]}});
  return {wip,batch,queued};
};
for (const step of [1,2]) test(`lab skips empty measurements at stage ${step}, preserves history and promotes only its next batch`, async () => {
  const {wip,queued} = await fixture({step});
  const before=stored(); await render(); await click(node(container,'수축률 측정'));
  const desk=()=>container.querySelector('[data-testid="shrink-lab"]');
  expect(container.querySelector('[data-testid="shrink-1"]').textContent).not.toContain('미측정으로 검수 이관');
  // Unsaved partial input must be archived as well, without being turned into a rate.
  await change(desk().querySelector('input[type="number"]'), '100');
  await click(node(desk(),'수축률 미측정으로 검수 이관')); await click(node(container,'확인'));
  const after=stored(), result=after[ROOT+'wipList/lab-test'];
  expect(result).toMatchObject({id:wip.id,orderId:wip.orderId,qty:10,currentStep:'step6',shrinkageStatus:'not_measured',shrinkageRate:null});
  expect(result.heatTreatmentHistory).toEqual(wip.heatTreatmentHistory);
  expect(result.shrinkageHistory[0]).toEqual(wip.shrinkageHistory[0]);
  expect(result.shrinkageHistory[1].previousShrinkageRate).toBe('4.8');
  expect(result.details).toContain(wip.details);
  expect(result.details).toContain('수축률 미측정');
  expect(after[ROOT+'shrinkArchives/test-batch'].kind).toBe('completed-unmeasured');
  const measurement=after[ROOT+'shrinkArchives/test-batch'].slotData.SINGLE.measurements[0];
  expect(step===1?measurement.preArea:measurement.postArea).toBe('100');
  expect(after[ROOT+'equipment/shrinkDesks'].lab).toEqual({...queued,queue:[]});
  expect(after[ROOT+'equipment/shrinkDesks'][1]).toEqual(before[ROOT+'equipment/shrinkDesks'][1]);
  expect(after[ROOT+'wipList/demo-history']).toEqual(before[ROOT+'wipList/demo-history']);
  await click(node(container,'검수/가공'));
  expect(container.textContent).toContain('실험로 · 수축률 미측정');
});

for (const fault of ['quantity','duplicate','concurrent batch']) test(`unmeasured transfer rejects ${fault} and leaves records intact`, async () => {
  await fixture({queuedDuplicate:fault==='duplicate'});
  if (fault==='quantity') await setDoc(ref('wipList/lab-test'),{...stored()[ROOT+'wipList/lab-test'],qty:9});
  await render(); await click(node(container,'수축률 측정'));
  await click(node(container.querySelector('[data-testid="shrink-lab"]'),'수축률 미측정으로 검수 이관'));
  if (fault==='concurrent batch') await act(async()=>setDoc(ref('equipment/shrinkDesks'),{...stored()[ROOT+'equipment/shrinkDesks'],lab:{...stored()[ROOT+'equipment/shrinkDesks'].lab,batchId:'changed-batch'}}));
  const before=stored(); await click(node(container,'확인'));
  expect(stored()).toEqual(before);
  expect(stored()[ROOT+'wipList/lab-test'].currentStep).toBe('step5_shrink');
});

test('lab loads ten pieces, rejects eleven and fractional input and rejects a larger unsplit lot',async()=>{
  await setDoc(ref('wipList/capacity-test'),{id:'capacity-test',mixLot:'TEN-PIECES',qty:10,currentStep:'step5',type:'345 BL0',height:'25'});
  await render(); const lab=()=>container.querySelector('[data-testid="furnace-lab"]');
  await click(node(container,'TEST-MAIN-002','div'));
  await click([...lab().querySelectorAll('span')].find(n=>n.textContent.includes('단일 공간')));
  expect(container.textContent).toContain('10개 이하로 분할된 로트');
  await click(node(container,'확인'));
  await click(node(container,'TEN-PIECES','div'));
  await click([...lab().querySelectorAll('span')].find(n=>n.textContent.includes('단일 공간')));
  const qtyInput=()=>[...container.querySelectorAll('input[type="number"]')].find(n=>n.max==='10');
  expect(qtyInput().value).toBe('10');
  for (const invalid of ['11','1.5']) {
    await change(qtyInput(),invalid); await click(node(container,'확인'));
    expect(stored()[ROOT+'equipment/furnaces'].lab.slotData).toEqual({});
    await click(node(container,'확인'));
  }
  await change(qtyInput(),'10'); await click(node(container,'확인'));
  expect(stored()[ROOT+'equipment/furnaces'].lab.slotData.SINGLE.qty).toBe(10);
  await change(lab().querySelector('[placeholder="성명"]'),'실험 담당'); await blur(lab().querySelector('[placeholder="성명"]'));
  await click(node(lab(),'실험로 가동 시작'));
  expect(stored()[ROOT+'equipment/furnaces'].lab.isHeating).toBe(true);
});


test('partial experimental mixing reserves specimen powder before computing producible pieces', async () => {
  await setDoc(ref('wipList/partial-mix'),{id:'partial-mix',mixLot:'PARTIAL-TEST',qty:10,singleWeight:628,weight:'6.480',type:'345 BL0',height:'25',
    currentStep:'step2',isExperimental:true,includeShrinkageSpecimen:true,specimenPowderG:200});
  await render(); await click(node(container,'혼합'));
  await click(node(container,'원료 부족 부분 배합 (추가 생산 자동 반영)'));
  await change(container.querySelector('select'),'demo-4Y-W');
  await change(container.querySelector('[placeholder="예: 300"]'),'1310');
  expect(node(container,'실제 생산 진행 수량','div').parentElement.textContent).toContain('1 EA');
  await change(container.querySelector('[placeholder="작업자 성명"]'),'혼합 담당');
  await click(node(container,'배합 완료 및 재고 차감'));
  expect(stored()[ROOT+'wipList/partial-mix']).toMatchObject({currentStep:'step3',qty:1,weight:'1.310',includeShrinkageSpecimen:true,specimenPowderG:200});
});
