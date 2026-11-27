// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Research from './research.js';
const researchForm = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.js', () => ({ api: { researchForm, liffConfig: vi.fn().mockResolvedValue({ success: true, data: { accountName: '人工店' } }) } }));
afterEach(() => { cleanup(); researchForm.mockReset(); });
function Probe() { const location = useLocation(); return <p>{location.pathname + location.search}</p>; }
function mount() { render(<MemoryRouter initialEntries={['/research/r1?liffId=account1']}><Routes>
  <Route path="/research/:id" element={<Research />} /><Route path="/forms/:id" element={<Probe />} />
</Routes></MemoryRouter>); }
test('認証済みアカウントのフォームへ移動する', async () => {
  researchForm.mockResolvedValue({ formId: 'form1' }); mount();
  expect(await screen.findByText('/forms/form1?liffId=account1')).toBeTruthy(); expect(researchForm).toHaveBeenCalledWith('r1');
});
test('取得失敗は再読込でき、回答画面へ進む', async () => {
  researchForm.mockRejectedValueOnce(new Error('network')).mockResolvedValue({ formId: 'form1' }); mount();
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByText('/forms/form1?liffId=account1')).toBeTruthy(); expect(researchForm).toHaveBeenCalledTimes(2);
});
test('読み込み中も題（リサーチ）の帯を出す', async () => {
  researchForm.mockReturnValue(new Promise(() => {})); mount();
  expect(await screen.findByText('リサーチ')).toBeTruthy();
});
test.each([{}, { formId: '' }, { formId: 123 }, null])('不正な応答は読み込み失敗として再試行できる: %j', async (response) => {
  researchForm.mockResolvedValueOnce(response).mockResolvedValueOnce({ formId: 'form1' });
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByText('/forms/form1?liffId=account1')).toBeTruthy();
});
test('移動前のリサーチの応答が遅れても現在の回答画面を開く', async () => {
  let resolveOld!: (value: { formId: string }) => void;
  researchForm.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ formId: 'new' });
  function Switch() { const navigate = useNavigate(); return <button onClick={() => navigate('/research/r2')}>切り替え</button>; }
  render(<MemoryRouter initialEntries={['/research/r1']}><Switch /><Routes>
    <Route path="/research/:id" element={<Research />} /><Route path="/forms/:id" element={<Probe />} />
  </Routes></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: '切り替え' }));
  resolveOld({ formId: 'old' });
  expect(await screen.findByText('/forms/new')).toBeTruthy();
  expect(screen.queryByText('/forms/old')).toBeNull();
});
