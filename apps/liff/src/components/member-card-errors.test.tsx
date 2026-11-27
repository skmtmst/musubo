// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import MemberCard, { MemberCardView, type MemberCardData } from './member-card.js';

vi.mock('@line/liff', () => ({ default: { getIDToken: () => 'token', id: 'account' } }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const card: MemberCardData = { name: 'シルバー', since: '2026-09-01', downgradeDueAt: null, next: { name: 'ゴールド', remaining: 2, metric: 'visits', progress: 0.6 } };

it('取得に失敗したら再読み込みでき、成功したら会員証を表示する', async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ success: false }) }).mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: card }) });
  vi.stubGlobal('fetch', fetchMock);
  render(<MemberCard />);
  expect(await screen.findByText('会員証を読み込めませんでした。')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '会員証をもう一度確認' }));
  expect(await screen.findByText('シルバー')).toBeTruthy();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('未知のランク条件は確認不能と表示し、更新後に正しい単位を示す', () => {
  function View() {
    const [current, setCurrent] = useState<MemberCardData>({ ...card, next: { ...card.next!, metric: 'unknown' as 'visits' } });
    return <><MemberCardView card={current} /><button onClick={() => setCurrent(card)}>更新</button></>;
  }
  render(<View />);
  expect(screen.getByText('次のランクの条件を確認できません')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByText('ゴールドまで あと 2 回の利用')).toBeTruthy();
});
