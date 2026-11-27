// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import Form from './form.js';

vi.mock('../lib/liff-auth.js', () => ({ getIdToken: () => 'test-token', getLiffId: () => 'test-liff' }));
vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const form = { id: 'f1', name: 'アンケート', description: null, isActive: true, layout: { version: 2, header: [], sections: [{ id: 's1', blocks: [{ id: 'b1', kind: 'input', type: 'text', name: 'name', label: 'お名前', defaultValue: '見本' }] }], options: { confirmDialog: { enabled: false } } } };
it.each([
  ['不正な応答', 200, null],
  ['未完了の応答', 201, { success: true, data: { complete: false } }],
])('%sは送信完了とせず、同じ回答として再確認できる', async (_name, status, invalid) => {
  const keys: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/submit')) {
      keys.push(new Headers(init?.headers).get('Idempotency-Key') || '');
      return new Response(JSON.stringify(keys.length === 1 ? invalid : { success: true, data: {} }), { status: keys.length === 1 ? status : 200 });
    }
    return new Response(JSON.stringify(path === '/api/forms/f1' ? { success: true, data: form } : { success: true, data: {} }), { status: 200 });
  }));
  render(<MemoryRouter initialEntries={['/forms/f1']}><Routes><Route path="/forms/:id" element={<Form />} /></Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '送信する' }));
  expect(await screen.findByText(/送信できませんでした/)).toBeTruthy();
  expect(screen.queryByText('ご回答ありがとうございました')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '送信する' }));
  expect(await screen.findByText('ご回答ありがとうございました')).toBeTruthy();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});
