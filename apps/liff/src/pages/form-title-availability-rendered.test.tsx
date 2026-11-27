// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { emptyLayout } from '@line-crm/shared';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import Form from './form.js';

const requests = vi.hoisted(() => ({ getForm: vi.fn(), submitForm: vi.fn() }));
vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
vi.mock('../lib/api.js', () => ({ api: { ...requests, liffConfig: vi.fn().mockResolvedValue({ data: {} }) } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); document.title = ''; });

it('受付停止の読み直しから回答完了まで、設定した画面名を保つ', async () => {
  const layout = emptyLayout();
  layout.options.pageTitle = 'ご案内アンケート';
  layout.options.confirmDialog = { enabled: false };
  layout.sections[0].blocks = [{ id: 'name', kind: 'input', type: 'text', name: 'name', label: 'お名前', required: true }];
  const form = { id: 'form', name: '内部のフォーム名', description: '', isActive: true, layout };
  let finish!: (value: typeof form) => void;
  requests.getForm.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(form);
  requests.submitForm.mockResolvedValue({ status: 200, body: { success: true, data: {} } });
  render(<MemoryRouter initialEntries={['/forms/form']}><Routes><Route path="/forms/:id" element={<Form />} /></Routes></MemoryRouter>);

  expect(await screen.findByText('フォーム')).toBeTruthy();
  expect(document.title).toBe('フォーム | musubo');
  await act(async () => { finish({ ...form, isActive: false }); });
  expect(await screen.findByText('このフォームは、いま回答を受け付けていません。')).toBeTruthy();
  expect(document.title).toBe('ご案内アンケート | musubo');
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }));
  const input = await screen.findByRole('textbox', { name: /お名前/ });
  await waitFor(() => expect(document.title).toBe('ご案内アンケート | musubo'));
  fireEvent.change(input, { target: { value: '利用者' } });
  fireEvent.click(screen.getByRole('button', { name: '送信する' }));
  expect(await screen.findByRole('button', { name: 'LINEに戻る' })).toBeTruthy();
  expect(document.title).toBe('ご案内アンケート | musubo');
  expect(requests.submitForm).toHaveBeenCalledTimes(1);
});
