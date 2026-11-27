// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AddressFields, type AddressDraft } from './form-address-fields.js';

const search = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.js', () => ({ api: { postalCodeSearch: search } }));
beforeEach(() => search.mockReset());
afterEach(cleanup);
function Form() {
  const [draft, setDraft] = useState<AddressDraft>({ postalCode: '1234567', prefecture: '', city: '入力済み', addressLine1: '', addressLine2: '' });
  return <AddressFields name="address" draft={draft} onChange={(_name, value) => setDraft(value as AddressDraft)} />;
}
it.each([
  ['未知の状態', { status: 'unknown', candidates: [] }],
  ['候補がない複数件', { status: 'multiple', candidates: [] }],
])('%sは検索失敗を知らせ、手入力を残す', async (_kind, data) => {
  search.mockResolvedValue({ success: true, data });
  render(<Form />);
  fireEvent.click(screen.getByRole('button', { name: '住所を探す' }));
  expect(await screen.findByText('住所を調べられませんでした。下の欄へ直接入力してください')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: '市区町村' }) as HTMLInputElement).value).toBe('入力済み');
});
