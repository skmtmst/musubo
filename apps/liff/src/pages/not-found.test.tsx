// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const liffMock = vi.hoisted(() => ({ isInClient: vi.fn(() => true), closeWindow: vi.fn() }));
vi.mock('@line/liff', () => ({ default: liffMock }));
vi.mock('../lib/api.js', () => ({ api: {
  liffConfig: () => Promise.resolve({ data: null }),
  customerLook: () => Promise.resolve({ success: true, data: { settings: {} } }),
} }));

import NotFound, { closeOrBackToLine } from './not-found.js';
import App from '../app.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });

/** 見つからない画面。迷った人が戻れる道を必ず出す。 */
describe('LIFF の見つからない画面', () => {
  it('題・説明・LINE に戻る・閉じる を出す', () => {
    const html = renderToStaticMarkup(<NotFound />);
    expect(html).toContain('data-design-node="aLU3r"');
    expect(html).toContain('ページが見つかりません');
    expect(html).toContain('ご案内');
    expect(html).not.toContain('ご予約');
    expect(html).toContain('お店からのメッセージのリンクを、もう一度開いてください。');
    expect(html).toContain('LINE に戻る');
    expect(html).toContain('閉じる');
  });

  it('LINE の中では、どちらのボタンも LIFF を閉じて LINE に戻る', () => {
    closeOrBackToLine('line');
    closeOrBackToLine('close');
    expect(liffMock.closeWindow).toHaveBeenCalledTimes(2);
  });

  it('どの住所にも当たらないときは、この画面へ送る', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-18T00:00:00Z'));
    render(<MemoryRouter initialEntries={['/unknown-address']}><App /></MemoryRouter>);
    expect(await screen.findByText('ページが見つかりません')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'LINE に戻る' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '閉じる' }).length).toBeGreaterThan(0);
    expect(screen.queryByText('ページが見つかりませんでした')).toBeNull();
  });
});
