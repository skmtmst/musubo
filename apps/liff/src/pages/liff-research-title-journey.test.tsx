// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { emptyLayout } from '@line-crm/shared';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import Research from './research.js';
import Form from './form.js';

const requests = vi.hoisted(() => ({ researchForm: vi.fn(), getForm: vi.fn() }));
vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
vi.mock('../lib/api.js', () => ({ api: { ...requests, submitForm: vi.fn(), liffConfig: vi.fn().mockResolvedValue({ data: {} }) } }));
vi.mock('../lib/user-message.js', async original => ({ ...await original<typeof import('../lib/user-message.js')>(), logFailure: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); document.title = ''; });

it('リサーチの失敗から再試行して回答画面に移るまで、画面名を保ち切り替える', async () => {
  let fail!: (error: Error) => void;
  requests.researchForm.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; })).mockResolvedValueOnce({ formId: 'form' });
  const layout = emptyLayout();
  layout.sections[0].blocks = [{ id: 'name', kind: 'input', type: 'text', name: 'name', label: 'お名前', required: true }];
  requests.getForm.mockResolvedValue({ id: 'form', name: 'アンケート', description: '', isActive: true, layout });
  render(<MemoryRouter initialEntries={['/research/research?liffId=account']}><Routes>
    <Route path="/research/:id" element={<Research />} />
    <Route path="/forms/:id" element={<Form />} />
  </Routes></MemoryRouter>);

  expect(await screen.findByText('リサーチ')).toBeTruthy();
  expect(document.title).toBe('リサーチ | musubo');
  await act(async () => { fail(new Error('offline')); });
  const retry = await screen.findByRole('button', { name: 'もう一度読み込む' });
  expect(document.title).toBe('リサーチ | musubo');
  fireEvent.click(retry);
  const input = await screen.findByRole('textbox', { name: /お名前/ });
  await waitFor(() => expect(document.title).toBe('アンケート | musubo'));
  fireEvent.change(input, { target: { value: '利用者' } });
  expect((input as HTMLInputElement).value).toBe('利用者');
  expect(requests.researchForm).toHaveBeenCalledTimes(2);
  expect(requests.getForm).toHaveBeenCalledWith('form', undefined);
});
