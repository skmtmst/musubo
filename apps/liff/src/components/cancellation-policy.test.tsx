// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import Confirm from './confirm.js';
import { api } from '../lib/api.js';
import CancellationPolicy from './cancellation-policy.js';

/* キャンセル料の決まり（B1・kwC8E・Q8HLq）：チェックは初めは空で、入れるまで予約のボタンは押せない。押すとカードを登録し、確かめた決まりの版と登録の印を一緒に送る。 */
vi.mock('../lib/api.js', () => ({
  api: {
    createRequest: vi.fn().mockResolvedValue({ booking_id: 'b1', status: 'confirmed' }),
    cancellationPreview: vi.fn(),
    cancellationSetup: vi.fn().mockResolvedValue({ setupIntentId: 'seti_test_1', url: 'https://example.test/setup', status: 'ready', testMode: true }),
  },
}));
const menu = { id: 'm1', name: 'トリミング（小型犬）', category_label: null, description: null, duration_minutes: 105, buffer_after_minutes: 0, base_price: 8400, sort_order: 0, intake_question: null, cancel_deadline_hours_before: null };
const staff = { id: 's1', display_name: '指名なし', role: null, profile_image_url: null, bio: null, is_designation_optional: 0, price: 8400, duration_minutes: 105 };
const POLICY = { enabled: true, version: 2, freeUntil: '2099-01-01T01:00:00.000Z', afterPercent: 50, noShowPercent: 100, price: 8400, deposit: null };
beforeEach(() => { vi.mocked(api.createRequest).mockClear(); vi.mocked(api.cancellationSetup).mockClear(); });
afterEach(cleanup);

it('端数のある割合の取消料を請求と同じ切り捨てで表示する', () => {
  render(<CancellationPolicy preview={{ ...POLICY, price: 1001, noShowPercent: 33 }} accepted={false} onAcceptedChange={() => {}} />);
  expect(screen.getByText('料金の 50%（¥500）')).toBeTruthy();
  expect(screen.getByText('料金の 33%（¥330）')).toBeTruthy();
});

function renderConfirm() {
  render(<Confirm menu={menu} staff={staff} slot={{ date: '2099-01-02', start: '10:00' }} autoConfirm onSubmitted={() => {}} />);
}

it('決まりがオンの店は、チェックを入れるまで押せず、入れるとカードを登録して決まりの版と一緒に送る', async () => {
  vi.mocked(api.cancellationPreview).mockResolvedValue(POLICY);
  renderConfirm();
  const box = await screen.findByRole('checkbox', { name: 'キャンセル料の決まりを確認しました' }) as HTMLInputElement;
  expect(box.checked).toBe(false);
  const submit = screen.getByRole('button', { name: '試験のカードを登録して予約する' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect(screen.getByText('料金の 50%（¥4,200）')).toBeTruthy();
  expect(screen.getByText(/チェックを入れると試験のカードを登録できます/)).toBeTruthy();
  expect(screen.queryByText(/取り消したときだけ、お店が決まりのとおりに請求します/)).toBeNull();
  fireEvent.click(box);
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  await vi.waitFor(() => expect(api.createRequest).toHaveBeenCalledWith(expect.objectContaining({ policyAccepted: true, policyVersion: 2, setupIntentId: 'seti_test_1' }), expect.any(String)));
  expect(api.cancellationSetup).toHaveBeenCalledWith(expect.objectContaining({menuId:'m1',staffId:'s1',partySize:1}), expect.any(String));
});

it('デポジットがある店は今払う額とお店で払う額を出し、ボタンに今払う額を書く', async () => {
  vi.mocked(api.cancellationPreview).mockResolvedValue({ ...POLICY, deposit: { amount: 2520 } });
  renderConfirm();
  expect(await screen.findByRole('button', { name: '¥2,520の試験で予約する' })).toBeTruthy();
  expect(screen.getByText('¥5,880')).toBeTruthy();
  expect(screen.getByText('キャンセル料とデポジット')).toBeTruthy();
});

it('決まりがオフの正常応答なら、決まりの段を出さず、カードも登録しない', async () => {
  vi.mocked(api.cancellationPreview).mockResolvedValue({ ...POLICY, enabled: false });
  renderConfirm();
  const submit = await screen.findByRole('button', { name: 'この内容で予約を確定する' });
  await vi.waitFor(() => expect((submit as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(submit);
  await vi.waitFor(() => expect(api.createRequest).toHaveBeenCalled());
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(api.cancellationSetup).not.toHaveBeenCalled();
});
