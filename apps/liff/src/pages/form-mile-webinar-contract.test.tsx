// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { emptyLayout } from '@line-crm/shared';
import Form from './form.js';
import { api } from '../lib/api.js';

vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
vi.mock('../lib/api.js', () => ({ api: { getForm: vi.fn(), submitForm: vi.fn(), liffConfig: vi.fn().mockResolvedValue({ data: {} }) } }));
vi.mock('../lib/user-message.js', async original => ({ ...await original<typeof import('../lib/user-message.js')>(), logFailure: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { vi.mocked(api.submitForm).mockResolvedValue({ status: 200, body: { success: true, data: {} } }); });

async function open(options: Record<string, unknown> = {}, active = true) {
  const layout = emptyLayout();
  layout.sections[0].blocks = [{ id: 'name', kind: 'input', type: 'text', name: 'name', label: 'お名前', required: true }];
  Object.assign(layout.options, { confirmDialog: { enabled: false }, ...options });
  vi.mocked(api.getForm).mockResolvedValue({ id: 'form', name: '受付', description: '1分で終わります', isActive: active, layout });
  render(<MemoryRouter initialEntries={['/forms/form']}><Routes><Route path="/forms/:id" element={<Form />} /></Routes></MemoryRouter>);
  if (active) await screen.findByRole('textbox', { name: /お名前/ });
}

it('必須の札と欄下の直し方を出し、入力を直したらその欄の案内だけ消す', async () => {
  await open();
  expect(screen.getByText('必須')).toBeTruthy();
  expect(screen.getByText('1分で終わります')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '送信する' }));
  expect(await screen.findByText('お名前 は必須項目です')).toBeTruthy();
  expect(api.submitForm).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: /お名前/ }), { target: { value: '利用者' } });
  expect(screen.queryByText('お名前 は必須項目です')).toBeNull();
});

it('停止中は入力と送信を出さず、受付外を知らせる', async () => {
  await open({}, false);
  expect(await screen.findByText('このフォームは、いま回答を受け付けていません。')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: '送信する' })).toBeNull();
});

it.each([undefined, '送信', 'この内容を送る'])('送信名%sと確認の操作を表示し、確認後だけ送る', async label => {
  await open({ submitLabel: label, confirmDialog: { enabled: true } });
  fireEvent.change(screen.getByRole('textbox', { name: /お名前/ }), { target: { value: '利用者' } });
  const text = label && label !== '送信' ? label : '送信する';
  const send = screen.getByRole('button', { name: text });
  expect(send.style.backgroundColor).toBe('#008f3d');
  expect(send.style.color).toBe('#ffffff');
  fireEvent.click(send);
  expect(api.submitForm).not.toHaveBeenCalled();
  const dialog = screen.getByText('送信してよろしいですか？').parentElement!;
  const confirm = within(dialog).getByRole('button', { name: '送信する' });
  expect(confirm.style.backgroundColor).toBe('#008f3d');
  expect(confirm.style.color).toBe('#ffffff');
  fireEvent.click(confirm);
  expect(await screen.findByRole('button', { name: 'LINEに戻る' })).toBeTruthy();
  expect(api.submitForm).toHaveBeenCalledTimes(1);
});

it('通信失敗の後も入力と同じ鍵を保ち、再送できる', async () => {
  vi.mocked(api.submitForm).mockRejectedValueOnce(new Error('offline'));
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: /お名前/ }), { target: { value: '利用者' } });
  fireEvent.click(screen.getByRole('button', { name: '送信する' }));
  await waitFor(() => expect((screen.getByRole('button', { name: '送信する' }) as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByDisplayValue('利用者')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '送信する' }));
  await screen.findByRole('button', { name: 'LINEに戻る' });
  expect(vi.mocked(api.submitForm).mock.calls[0][2]).toBe(vi.mocked(api.submitForm).mock.calls[1][2]);
});

it('内容違いは自動再送せず、別回答を明示したときだけ鍵を変える', async () => {
  vi.mocked(api.submitForm).mockResolvedValueOnce({ status: 409, body: { success: false, code: 'idempotency_content_mismatch' } });
  await open();
  fireEvent.change(screen.getByRole('textbox', { name: /お名前/ }), { target: { value: '利用者' } });
  fireEvent.click(screen.getByRole('button', { name: '送信する' }));
  const resend = await screen.findByRole('button', { name: /別の回答として/ });
  expect(api.submitForm).toHaveBeenCalledTimes(1);
  fireEvent.click(resend);
  await screen.findByRole('button', { name: 'LINEに戻る' });
  expect(vi.mocked(api.submitForm).mock.calls[1][2]).not.toBe(vi.mocked(api.submitForm).mock.calls[0][2]);
});

it('紹介画面に旧い箱の名前を戻さない', () => {
  expect(readFileSync(join(import.meta.dirname, 'affiliate.tsx'), 'utf8')).not.toContain('af-');
  expect(readFileSync(join(import.meta.dirname, 'form.tsx'), 'utf8')).not.toContain('bg-ground');
});

it('選んだメニューが消えたとき、入力を残して選び直して再送できる', async () => {
  vi.mocked(api.submitForm).mockResolvedValueOnce({status:409,body:{success:false,code:'restaurant_course_unavailable'}});
  await open();
  fireEvent.change(screen.getByRole('textbox',{name:/お名前/}),{target:{value:'利用者'}});
  fireEvent.click(screen.getByRole('button',{name:'送信する'}));
  expect(await screen.findByText(/メニューを選び直してください/)).toBeTruthy();
  expect((screen.getByRole('textbox',{name:/お名前/}) as HTMLInputElement).value).toBe('利用者');
  fireEvent.click(screen.getByRole('button',{name:'送信する'}));
  expect(await screen.findByRole('button',{name:'LINEに戻る'})).toBeTruthy();
  expect(vi.mocked(api.submitForm).mock.calls[1][2]).not.toBe(vi.mocked(api.submitForm).mock.calls[0][2]);
});
