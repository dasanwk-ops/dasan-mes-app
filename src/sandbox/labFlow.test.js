import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Simulate } from 'react-dom/test-utils';
import App from '../App';

const ROOT = 'artifacts/dasan-mes-app/public/data/';
const stored = () => JSON.parse(sessionStorage.getItem('dasan-lab-furnace-preview-v1'));
const textNode = (scope, text, tag = '*') => {
  const node = [...scope.querySelectorAll(tag)].find(n => n.textContent.trim() === text);
  if (!node) throw Error(`Missing UI: ${text}`);
  return node;
};
const click = async node => { await act(async () => { Simulate.click(node); }); };
const change = async (node, value) => { await act(async () => { Simulate.change(node, {target:{value}}); }); };
const blur = async node => { await act(async () => { Simulate.blur(node); }); };

test('sample lot passes through lab loading, heating, measurement and inspection without altering other lots', async () => {
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.fetch = jest.fn(() => { throw Error('Unexpected network request'); });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const lab = () => container.querySelector('[data-testid="furnace-lab"]');
  const desk = () => container.querySelector('[data-testid="shrink-lab"]');
  try {
    await act(async () => root.render(<App />));
    expect(lab().textContent).toContain('단일 공간');
    expect(lab().textContent).not.toMatch(/[1-6]층/);
    expect(container.querySelector('[data-testid="furnace-1"]').textContent).toContain('좌측 6층');

    await click(textNode(container, 'TEST-LAB-001', 'div'));
    await click([...lab().querySelectorAll('span')].find(n => n.textContent.includes('단일 공간')));
    await click(textNode(container, '확인', 'button'));
    expect(lab().textContent).toContain('6개');
    const before = stored();
    const otherLot = before[ROOT + 'wipList/demo-history'];
    const otherWaitingLot = before[ROOT + 'wipList/demo-production'];
    const mainFurnace = before[ROOT + 'equipment/furnaces'][1];

    await change(lab().querySelector('[placeholder="성명"]'), '실험 담당');
    await blur(lab().querySelector('[placeholder="성명"]'));
    await click(textNode(lab(), '실험로 가동 시작', 'button'));
    expect(lab().textContent).toContain('열처리 가동 중');
    await change(lab().querySelector('[placeholder="특이사항이나 메모를 입력하세요"]'), '실험 메모');
    await blur(lab().querySelector('[placeholder="특이사항이나 메모를 입력하세요"]'));
    await click(textNode(lab(), '실험로 완료 · 측정 이관', 'button'));
    expect(container.textContent).toContain('가동 종료!');
    await click(textNode(container, '확인', 'button'));

    await click(textNode(container, '수축률 측정', 'button'));
    expect(desk().textContent).toContain('TEST-LAB-001');
    expect(desk().textContent).toContain('수량: 6개');
    expect(desk().textContent).not.toMatch(/[1-6]층/);
    expect(desk().querySelector('select')).toBeNull();
    await change(desk().querySelector('input[type="number"]'), '100');
    await click(textNode(desk(), '[1단계] 소결 전 면적 임시저장 및 잠금', 'button'));
    expect(container.textContent).toContain('소결 전 면적 저장 및 잠금이 완료되었습니다');
    await click(textNode(container, '확인', 'button'));
    await change(desk().querySelector('input[type="number"]'), '90.25');
    expect(desk().textContent).toContain('5.00');
    await click(textNode(desk(), '[2단계] 수축률 분석 및 결과 확정', 'button'));
    expect(container.textContent).toContain('수축률 분석 및 검수 이관 완료');

    const after = stored();
    const labLots = Object.entries(after).filter(([key,value]) => key.startsWith(ROOT+'wipList/') && value.originalLot === 'TEST-LAB-001').map(([,value]) => value);
    expect(labLots.length).toBe(1);
    expect(labLots[0].currentStep).toBe('step6');
    expect(labLots[0].qty).toBe(6);
    expect(labLots[0].heatTreatmentHistory[0].furnaceId).toBe('lab');
    expect(labLots[0].heatTreatmentHistory[0].memo).toBe('실험 메모');
    expect(labLots[0].details).toContain('실험로');
    expect(after[ROOT+'wipList/demo-history']).toEqual(otherLot);
    expect(after[ROOT+'wipList/demo-production']).toEqual(otherWaitingLot);
    expect(after[ROOT+'equipment/furnaces'][1]).toEqual(mainFurnace);
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
