// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PartyStaffStep } from './party-step.js';
import { initialParty } from '../lib/party.js';
import type { MenuItem } from '../lib/api.js';

const read = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.js', () => ({ api: { staffOf: read } }));
vi.mock('../lib/user-message.js', async original => ({ ...await original<typeof import('../lib/user-message.js')>(), logFailure: vi.fn() }));
const menu = { id: 'm', name: 'メニュー', duration_minutes: 30, base_price: 0 } as MenuItem;
beforeEach(() => read.mockReset());
afterEach(cleanup);
it.each([
  ['一覧が欠けた', { staff: null }],
  ['担当者の名前が欠けた', { staff: [{ id: 's' }] }],
])('%s場合は読み直せる', async (_kind, invalid) => {
  read.mockResolvedValueOnce(invalid).mockResolvedValueOnce({ staff: [{ id: 's', display_name: '担当A', is_designation_optional: 1 }] });
  render(<PartyStaffStep menu={menu} party={initialParty()} onParty={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByText('担当A')).toBeTruthy();
});
