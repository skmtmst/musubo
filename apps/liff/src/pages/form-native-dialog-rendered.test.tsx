// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { emptyLayout } from '@line-crm/shared';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import Form from './form.js';

const requests = vi.hoisted(() => ({ getForm: vi.fn(), submitForm: vi.fn() }));
vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
vi.mock('../lib/api.js', () => ({ api: { ...requests, liffConfig: vi.fn().mockResolvedValue({ data: {} }) } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('フォームの送信確認をLINE内で閉じたり送信でき、端末の確認窓を呼ばない', async () => {
  const confirm = vi.fn().mockReturnValue(false);
  const alert = vi.fn();
  const prompt = vi.fn().mockReturnValue(null);
  vi.stubGlobal('confirm', confirm);
  vi.stubGlobal('alert', alert);
  vi.stubGlobal('prompt', prompt);
  const layout = emptyLayout();
  layout.sections[0].blocks = [{ id: 'name', kind: 'input', type: 'text', name: 'name', label: 'お名前', required: true }];
  layout.options.confirmDialog = { enabled: true };
  requests.getForm.mockResolvedValue({ id: 'form', name: '受付', description: '', isActive: true, layout });
  requests.submitForm.mockResolvedValue({ status: 200, body: { success: true, data: {} } });
  render(<MemoryRouter initialEntries={['/forms/form']}><Routes><Route path="/forms/:id" element={<Form />} /></Routes></MemoryRouter>);

  const input = await screen.findByRole('textbox', { name: /お名前/ });
  fireEvent.change(input, { target: { value: '利用者' } });
  fireEvent.click(screen.getByRole('button', { name: '送信する' }));
  const first = screen.getByText('送信してよろしいですか？').parentElement!;
  fireEvent.click(within(first).getByRole('button', { name: '閉じる' }));
  expect(requests.submitForm).not.toHaveBeenCalled();
  expect((input as HTMLInputElement).value).toBe('利用者');
  fireEvent.click(screen.getByRole('button', { name: '送信する' }));
  const second = screen.getByText('送信してよろしいですか？').parentElement!;
  fireEvent.click(within(second).getByRole('button', { name: '送信する' }));
  expect(await screen.findByRole('button', { name: 'LINEに戻る' })).toBeTruthy();
  expect(requests.submitForm).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
  expect(prompt).not.toHaveBeenCalled();
});
