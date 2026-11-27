// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import EventCatalog from './event-catalog.js';
import { api } from '../lib/api.js';
vi.mock('../lib/api.js', () => ({ api: { listEvents: vi.fn(), liffConfig: vi.fn().mockResolvedValue({ success: true, data: { accountName: '教室' } }) } }));
const list = vi.mocked(api.listEvents);
const event = (id: string) => ({ id, name: `クラス${id}`, venue_name: '会場', image_url: null, nextStartsAt: '2026-11-10T01:00:00Z' });
function Destination() { const location = useLocation(); return <p>{location.pathname + location.search}</p>; }
function open() { return render(<MemoryRouter initialEntries={['/events?liffId=qa&source=catalog']}><Routes><Route path="/events" element={<EventCatalog />} /><Route path="/events/:id" element={<Destination />} /></Routes></MemoryRouter>); }
beforeEach(() => list.mockReset());
afterEach(cleanup);

it('初回の失敗は全体の案内から再試行し、空の一覧を表示する', async () => {
  list.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [], nextCursor: null });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByText('これからのクラスはありません')).toBeTruthy();
  expect(screen.queryByText('読み込めませんでした')).toBeNull();
  expect(list.mock.calls).toEqual([[], []]);
});

it('追加失敗では既読のカードと順序を保ち、同じ続きだけを再試行する', async () => {
  list.mockResolvedValueOnce({ items: [event('1'), event('2')], nextCursor: 'cursor-2' }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [event('2'), event('3'), event('3')], nextCursor: null });
  open();
  const first = await screen.findByRole('heading', { name: 'クラス1' });
  fireEvent.click(screen.getByRole('button', { name: '続きを見る' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('読み込めませんでした')).toBeNull();
  expect(screen.getByRole('heading', { name: 'クラス1' })).toBe(first);
  expect(screen.getAllByRole('heading').map(node => node.textContent)).toEqual(['クラス1', 'クラス2']);
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }));
  await screen.findByRole('heading', { name: 'クラス3' });
  expect(screen.getAllByRole('heading').map(node => node.textContent)).toEqual(['クラス1', 'クラス2', 'クラス3']);
  expect(list.mock.calls).toEqual([[], ['cursor-2'], ['cursor-2']]);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('続きを取得中の連打を止め、成功時に一度だけ追加する', async () => {
  let finish!: (data: Awaited<ReturnType<typeof api.listEvents>>) => void;
  list.mockResolvedValueOnce({ items: [event('1')], nextCursor: 'cursor-2' }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  open();
  const button = await screen.findByRole('button', { name: '続きを見る' });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(button.hasAttribute('disabled')).toBe(true);
  expect(list).toHaveBeenCalledTimes(2);
  await act(async () => finish({ items: [event('2')], nextCursor: null }));
  expect(screen.getAllByRole('heading')).toHaveLength(2);
});

it('再試行の取得中も理由とカードを保ち、再試行の連打を止める', async () => {
  let finish!: (data: Awaited<ReturnType<typeof api.listEvents>>) => void;
  list.mockResolvedValueOnce({ items: [event('1')], nextCursor: 'cursor-2' }).mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  open();
  fireEvent.click(await screen.findByRole('button', { name: '続きを見る' }));
  const retry = await screen.findByRole('button', { name: 'もう一度読み込む' });
  act(() => { fireEvent.click(retry); fireEvent.click(retry); });
  expect(retry.hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(list).toHaveBeenCalledTimes(3);
  await act(async () => finish({ items: [event('2')], nextCursor: null }));
  expect(screen.getAllByRole('heading')).toHaveLength(2);
});

it('アンマウント済みの応答が、新しいインスタンスの一覧を変えない', async () => {
  let finish!: (data: Awaited<ReturnType<typeof api.listEvents>>) => void;
  list.mockResolvedValueOnce({ items: [event('1')], nextCursor: 'cursor-2' }).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ items: [event('new')], nextCursor: null });
  const view = open();
  fireEvent.click(await screen.findByRole('button', { name: '続きを見る' }));
  view.unmount();open();
  await screen.findByRole('heading', { name: 'クラスnew' });
  await act(async () => finish({ items: [event('old')], nextCursor: null }));
  expect(screen.queryByRole('heading', { name: 'クラスold' })).toBeNull();
});

it('日時を選ぶと既存のクエリとクラスIDを引き継ぐ', async () => {
  list.mockResolvedValue({ items: [event('entry')], nextCursor: null });
  open();fireEvent.click(await screen.findByRole('button', { name: '日時を選ぶ' }));
  expect(await screen.findByText('/events/entry?liffId=qa&source=catalog')).toBeTruthy();
});

it('初回の不正な応答は空一覧にせず、読み直しで回復する', async () => {
  list.mockResolvedValueOnce({ items: null, nextCursor: null } as unknown as Awaited<ReturnType<typeof api.listEvents>>)
    .mockResolvedValueOnce({ items: [event('1')], nextCursor: null });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByRole('heading', { name: 'クラス1' })).toBeTruthy();
});

it('続きの不正な日時は表示済みの一覧を保ち、同じ続きを読み直せる', async () => {
  list.mockResolvedValueOnce({ items: [event('1')], nextCursor: 'cursor-2' })
    .mockResolvedValueOnce({ items: [{ ...event('2'), nextStartsAt: 'invalid' }], nextCursor: null })
    .mockResolvedValueOnce({ items: [event('2')], nextCursor: null });
  open();
  fireEvent.click(await screen.findByRole('button', { name: '続きを見る' }));
  const retry = await screen.findByRole('button', { name: 'もう一度読み込む' });
  expect(screen.getByRole('heading', { name: 'クラス1' })).toBeTruthy();
  fireEvent.click(retry);
  expect(await screen.findByRole('heading', { name: 'クラス2' })).toBeTruthy();
  expect(list.mock.calls).toEqual([[], ['cursor-2'], ['cursor-2']]);
});
