// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import Form from './form.js';

vi.mock('../lib/liff-auth.js', () => ({ getIdToken: () => 'test-token', getLiffId: () => 'test-liff' }));
vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each([
  ['不正な残り数', { full: false, remaining: -1 }],
  ['不正な受付状態', { full: 'unknown', remaining: 1 }],
])('%sを確認不能と伝え、開き直して正しい値を選べる', async (_label, invalid) => {
  let choice: unknown = invalid;
  const form = () => ({ id: 'f1', name: 'アンケート', description: null, isActive: true,
    availability: { accepting: true, reason: null, deadlineAt: null, oncePerFriend: false, totalRemaining: null, choices: { pick: { a: choice } } },
    layout: { version: 2, header: [], sections: [{ id: 's1', blocks: [{ id: 'b1', kind: 'input', type: 'radio', name: 'pick', label: '希望', choices: [{ id: 'a', label: '午前' }] }] }], options: {} } });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    return new Response(JSON.stringify(path === '/api/forms/f1' ? { success: true, data: form() } : { success: true, data: {} }), { status: 200 });
  }));
  const mount = () => render(<MemoryRouter initialEntries={['/forms/f1']}><Routes><Route path="/forms/:id" element={<Form />} /></Routes></MemoryRouter>);
  const first = mount();
  expect(await screen.findByText(/受付状況を確認できません/)).toBeTruthy();
  first.unmount();
  choice = { full: false, remaining: 2 };
  mount();
  const option = await screen.findByRole('radio', { name: /午前.*残り2件/ });
  fireEvent.click(option);
  expect((option as HTMLInputElement).checked).toBe(true);
});
