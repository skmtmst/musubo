// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CustomerStyleContext } from '../components/customer-style-scope.js';
import EventDone from './event-done.js';
const calls=vi.hoisted(()=>({get:vi.fn(async()=>({name:'教室'})),wait:vi.fn(),cancel:vi.fn(async()=>({ok:true}))}));
vi.mock('../lib/api.js',()=>({api:{getEvent:calls.get,myEventWaitlist:calls.wait,cancelMyEventWaitlist:calls.cancel}}));
vi.mock('@line/liff',()=>({default:{closeWindow:vi.fn()}}));
vi.mock('../components/liff-look-scope.js',()=>({default:({children}:{children:React.ReactNode})=>children}));
vi.mock('../components/ui/liff-header.js',()=>({default:()=>null}));
afterEach(()=>{cleanup();vi.clearAllMocks()});
function show(status:string){
  render(<CustomerStyleContext.Provider value="lesson"><MemoryRouter initialEntries={[`/events/event/done?status=${status}&waitSlot=slot`]}><Routes>
    <Route path="/events/:id/done" element={<EventDone/>}/><Route path="/events/me" element={<p>履歴へ移動</p>}/>
  </Routes></MemoryRouter></CustomerStyleContext.Provider>);
}
test.each(['confirmed','requested'])('確定と承認待ち%sは履歴へ進み、業種の連絡先を案内する',async status=>{
  calls.wait.mockResolvedValue({items:[]});show(status);
  if(status==='requested')expect(screen.getByText(/教室の確認をお待ちください/)).toBeTruthy();
  expect(screen.getByRole('button',{name:'LINEに戻る'})).toBeTruthy();
  expect(screen.queryByRole('button',{name:'キャンセル待ちを取り消す'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'自分のクラスを見る'}));
  await screen.findByText('履歴へ移動');expect(calls.cancel).not.toHaveBeenCalled();
});
test('自分の待ちがある場合だけ取り消しを出し、確認してから同じIDを送る',async()=>{
  calls.wait.mockResolvedValue({items:[{id:'wait',event_id:'event',slot_id:'slot',status:'waiting',queue_position:2}]});show('waitlisted');
  fireEvent.click(await screen.findByRole('button',{name:'キャンセル待ちを取り消す'}));
  expect(screen.queryByRole('button',{name:'自分のクラスを見る'})).toBeNull();
  expect(calls.cancel).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'取り消す'}));
  await screen.findByText('履歴へ移動');expect(calls.cancel).toHaveBeenCalledExactlyOnceWith('wait');
});
test.each(['', 'unexpected'])('不明な申し込み状態 %s を確定と表示しない', async status => {
  show(status);
  expect(screen.getByText('申し込みの状態を確認してください')).toBeTruthy();
  expect(screen.queryByText('申し込みが確定しました')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '自分のクラスを見る' }));
  expect(await screen.findByText('履歴へ移動')).toBeTruthy();
});
