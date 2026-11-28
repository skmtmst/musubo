// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { emptyLayout } from '@line-crm/shared';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import Form from './form.js';

const requests = vi.hoisted(() => ({ getForm: vi.fn(), submitForm: vi.fn() }));
vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
vi.mock('../lib/api.js', () => ({ api: { ...requests, liffConfig: vi.fn().mockResolvedValue({ data: {} }) } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('リンク付き画像は説明の有無に応じた名前を持ち、フォームも送信できる', async () => {
  const layout = emptyLayout();
  layout.options.confirmDialog = { enabled: false };
  layout.sections[0].blocks = [
    { id: 'named', kind: 'image', mediaUrl: 'https://example.test/named.png', linkUrl: 'https://example.test/guide', alt: '来店のご案内', size: 'full' },
    { id: 'unnamed', kind: 'image', mediaUrl: 'https://example.test/unnamed.png', linkUrl: 'https://example.test/details', size: 'full' },
    { id: 'name', kind: 'input', type: 'text', name: 'name', label: 'お名前', required: true },
  ];
  requests.getForm.mockResolvedValue({ id: 'form', name: '受付', description: '', isActive: true, layout });
  requests.submitForm.mockResolvedValue({ status: 200, body: { success: true, data: {} } });
  render(<MemoryRouter initialEntries={['/forms/form']}><Routes><Route path="/forms/:id" element={<Form />} /></Routes></MemoryRouter>);

  const input = await screen.findByRole('textbox', { name: /お名前/ });
  const named = screen.getByRole('link', { name: '来店のご案内' });
  expect(named.getAttribute('href')).toBe('https://example.test/guide');
  expect(within(named).getByRole('img', { name: '来店のご案内' })).toBeTruthy();
  const unnamed = screen.getByRole('link', { name: '画像のリンクを開く' });
  expect(unnamed.getAttribute('href')).toBe('https://example.test/details');
  expect(unnamed.querySelector('img')?.getAttribute('alt')).toBe('');
  expect(unnamed.getAttribute('rel')).toContain('noreferrer');
  fireEvent.change(input, { target: { value: '利用者' } });
  fireEvent.click(screen.getByRole('button', { name: '送信する' }));
  expect(await screen.findByRole('button', { name: 'LINEに戻る' })).toBeTruthy();
  expect(requests.submitForm).toHaveBeenCalledTimes(1);
});
