// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import VisitStampQr from './visit-stamp-qr.js';
import { visitStampsApi } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: { customerLook: vi.fn().mockResolvedValue({ success: true, data: { settings: {} } }), bookingSettings: vi.fn().mockResolvedValue({ data: {} }), liffConfig: vi.fn().mockResolvedValue({ data: { accountId: 'acc', accountName: '店舗', botBasicId: '@shop' } }) },
  visitStampsApi: { redeemQr: vi.fn() },
}));
vi.mock('@line/liff', () => ({ default: { isInClient: () => true, closeWindow: vi.fn() } }));
beforeEach(() => vi.mocked(visitStampsApi.redeemQr).mockReset());
afterEach(cleanup);
function Switch() { const navigate = useNavigate(); return <button onClick={() => navigate('/visit-stamp-qr?token=second&accountId=acc')}>次のQR</button>; }
function open() { render(<MemoryRouter initialEntries={['/visit-stamp-qr?token=first&accountId=acc']}><Switch /><VisitStampQr /></MemoryRouter>); }

it('知らない押印結果は空画面にせず読み直せる', async () => {
  vi.mocked(visitStampsApi.redeemQr).mockResolvedValueOnce({ data: { status: 'unknown' } } as unknown as Awaited<ReturnType<typeof visitStampsApi.redeemQr>>)
    .mockResolvedValueOnce({ data: { status: 'invalid', reason: 'invalid' } } as Awaited<ReturnType<typeof visitStampsApi.redeemQr>>);
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByText('この QR は使えません')).toBeTruthy();
});

it('別のQRを読み込み中は前の結果を表示しない', async () => {
  vi.mocked(visitStampsApi.redeemQr).mockResolvedValueOnce({ data: { status: 'invalid', reason: 'invalid' } } as Awaited<ReturnType<typeof visitStampsApi.redeemQr>>)
    .mockReturnValueOnce(new Promise(() => {}));
  open();
  await screen.findByText('この QR は使えません');
  fireEvent.click(screen.getByRole('button', { name: '次のQR' }));
  expect(screen.queryByText('この QR は使えません')).toBeNull();
});
