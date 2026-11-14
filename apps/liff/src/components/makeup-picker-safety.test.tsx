// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MakeupPicker from './makeup-picker.js';
import { api, type MakeupCredit } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({ api: { makeupOptions: vi.fn(), useMakeup: vi.fn() } }));
const clock = Date.parse('2026-10-20T00:00:00Z');
const credit = { id: 'mine', status: 'open', expires_at: '2026-11-20T00:00:00Z' } as MakeupCredit;
const option = { slot_id: 'future', event_id: 'e', name: '人工クラス', starts_at: '2026-10-21T01:00:00Z', ends_at: '2026-10-21T02:00:00Z', full: false, remaining: 1 };
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock); vi.mocked(api.makeupOptions).mockResolvedValue({ options: [option] }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.useRealTimers(); });

it.each(['2026-10-19T00:00:00Z', 'invalid'])('期限切れ・不明 (%s) を使える振替として出さない', async (expires_at) => {
  render(<MakeupPicker credit={{ ...credit, expires_at }} onUsed={() => {}} />);
  expect(await screen.findByText(/振替の期限を/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /に振り替える/ })).toBeNull();
  expect(api.makeupOptions).not.toHaveBeenCalled();
  expect(api.useMakeup).not.toHaveBeenCalled();
});

it('使った振替をURLや表示の再利用で再消費しない', () => {
  render(<MakeupPicker credit={{ ...credit, status: 'used' }} onUsed={() => {}} />);
  expect(api.makeupOptions).not.toHaveBeenCalled();
  expect(screen.queryByRole('button')).toBeNull();
});

it('過去・期限外・満席を除き、同じ券の有効な開催回だけ送る', async () => {
  vi.mocked(api.makeupOptions).mockResolvedValue({ options: [option,
    { ...option, slot_id: 'past', starts_at: '2026-10-19T01:00:00Z' },
    { ...option, slot_id: 'late', starts_at: '2026-12-21T01:00:00Z' },
    { ...option, slot_id: 'full', full: true, remaining: 0 },
  ] });
  vi.mocked(api.useMakeup).mockResolvedValue({ id: 'new', status: 'confirmed' });
  render(<MakeupPicker credit={credit} onUsed={() => {}} />);
  const submit = await screen.findByRole('button', { name: /に振り替える/ });
  fireEvent.click(submit);
  await vi.waitFor(() => expect(api.useMakeup).toHaveBeenCalledWith('mine', 'future', expect.any(String)));
  expect(screen.queryByText(/12\/21/)).toBeNull();
});

it('表示後に期限を越えたら、古い押し口でも送らない', async () => {
  render(<MakeupPicker credit={credit} onUsed={() => {}} />);
  const submit = await screen.findByRole('button', { name: /に振り替える/ });
  vi.setSystemTime(Date.parse(credit.expires_at) + 1);
  fireEvent.click(submit);
  expect(api.useMakeup).not.toHaveBeenCalled();
});

it.each([403, 404])('別人・別店の拒否 (%s) を成功にせず残りを維持する', async (status) => {
  vi.mocked(api.useMakeup).mockRejectedValue({ status, body: { error: 'not_found' } });
  const used = vi.fn();
  render(<MakeupPicker credit={credit} onUsed={used} />);
  fireEvent.click(await screen.findByRole('button', { name: /に振り替える/ }));
  expect(await screen.findByText(/振替を予約できませんでした。振替は残っています/)).toBeTruthy();
  expect(used).not.toHaveBeenCalled();
});

it('画面を離れた後の完了で、古い画面の一覧を読み直さない', async () => {
  let finish: (() => void) | undefined;
  vi.mocked(api.useMakeup).mockImplementation(() => new Promise(resolve => {
    finish = () => resolve({ id: 'new', status: 'confirmed' });
  }));
  const used = vi.fn();
  const view = render(<MakeupPicker credit={credit} onUsed={used} />);
  fireEvent.click(await screen.findByRole('button', { name: /に振り替える/ }));
  expect(api.useMakeup).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => { finish!(); });
  expect(used).not.toHaveBeenCalled();
});


it('確保の直前に満席になったら、残った振替と近い3回を出して選び直せる', async () => {
  const alternatives = [22, 23, 24, 25].map(day => ({ ...option, slot_id: `next-${day}`, name: `振替クラス${day}`, starts_at: `2026-10-${day}T01:00:00Z` }))
  vi.mocked(api.makeupOptions).mockResolvedValueOnce({ options: [option] }).mockResolvedValue({ options: [...alternatives].reverse() })
  vi.mocked(api.useMakeup).mockRejectedValueOnce({ status: 409, body: { error: 'makeup_slot_unavailable' } }).mockResolvedValue({ id: 'new', status: 'confirmed' })
  const used = vi.fn()
  render(<MakeupPicker credit={credit} onUsed={used} />)
  fireEvent.click(await screen.findByRole('button', { name: /に振り替える/ }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'この回は埋まりました。ほかの回を選んでください。振替は残っています。')
  const nearby = await screen.findByRole('group', { name: '近い振替先' })
  const choices = within(nearby).getAllByRole('button')
  expect(choices).toHaveLength(3)
  expect(choices.map(button => button.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('10/22'), expect.stringContaining('10/23'), expect.stringContaining('10/24')]))
  expect(choices[0].textContent).toContain('10/22')
  expect(used).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '振替先を選んでください' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(choices[1])
  expect(screen.queryByRole('group', { name: '近い振替先' })).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: /10\/23.*に振り替える/ }))
  await vi.waitFor(() => expect(used).toHaveBeenCalledTimes(1))
  expect(api.useMakeup).toHaveBeenLastCalledWith('mine', 'next-23', expect.any(String))
  expect(vi.mocked(api.useMakeup).mock.calls[0][2]).not.toBe(vi.mocked(api.useMakeup).mock.calls[1][2])
})

it('空きのない週に、別の週の候補を混ぜない', async () => {
  vi.mocked(api.makeupOptions).mockResolvedValue({ options: [option] });
  render(<MakeupPicker credit={credit} onUsed={() => {}} />);
  expect(await screen.findByText('人工クラス')).toBeTruthy();
  const calls = vi.mocked(api.makeupOptions).mock.calls.length;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '次の週' })); });
  expect(vi.mocked(api.makeupOptions).mock.calls.length).toBeGreaterThan(calls);
  expect(screen.queryByText('人工クラス')).toBeNull();
  expect(screen.getByRole('button', { name: '振替先を選んでください' }).hasAttribute('disabled')).toBe(true);
});

it('満席後に選んだ別週の回が再読込時に消えても、別の回を勝手に選ばない', async () => {
  const selected = { ...option, slot_id: 'selected', name: '選んだ回', starts_at: '2026-11-02T01:00:00Z' };
  const replacement = { ...option, slot_id: 'replacement', name: '別の回', starts_at: '2026-11-03T01:00:00Z' };
  vi.mocked(api.makeupOptions).mockResolvedValueOnce({ options: [option] }).mockResolvedValueOnce({ options: [selected] }).mockResolvedValue({ options: [replacement] });
  vi.mocked(api.useMakeup).mockRejectedValueOnce({ status: 409, body: { error: 'makeup_slot_unavailable' } });
  const used = vi.fn();
  render(<MakeupPicker credit={credit} onUsed={used} />);
  fireEvent.click(await screen.findByRole('button', { name: /に振り替える/ }));
  const nearby = await screen.findByRole('group', { name: '近い振替先' });
  fireEvent.click(within(nearby).getByRole('button', { name: /選んだ回/ }));
  expect(await screen.findByText('別の回')).toBeTruthy();
  expect(screen.getByRole('button', { name: '振替先を選んでください' }).hasAttribute('disabled')).toBe(true);
  expect(api.useMakeup).toHaveBeenCalledTimes(1);
  expect(used).not.toHaveBeenCalled();
});
