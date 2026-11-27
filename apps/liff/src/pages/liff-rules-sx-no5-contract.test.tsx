// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import LiffHeader from '../components/ui/liff-header.js';
import Stepper from '../components/ui/Stepper.js';

const closeWindow = vi.hoisted(() => vi.fn());
vi.mock('@line/liff', () => ({ default: { closeWindow } }));
vi.mock('../lib/api.js', () => ({ api: { liffConfig: vi.fn().mockResolvedValue({ data: { accountName: '試しのお店' } }) } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('上の帯に店名を出し、閉じるとLINEを閉じ、戻る指定があれば前の段へ戻る', async () => {
  const back = vi.fn();
  const view = render(<LiffHeader title="ご予約" />);
  expect(await screen.findByText('試しのお店')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
  expect(closeWindow).toHaveBeenCalledOnce();
  view.rerender(<LiffHeader title="確認" onBack={back} />);
  fireEvent.click(screen.getByRole('button', { name: '戻る' }));
  expect(back).toHaveBeenCalledOnce();
  expect(closeWindow).toHaveBeenCalledTimes(1);
});

it.each([['メニュー', '担当', '日時', '確認'], ['メニュー', '担当', '日時', '確認', 'お支払い']])('%s からの手順は渡した順に並び、現在の段を読み上げで伝える', (...steps) => {
  const view = render(<Stepper steps={steps} current={2} />);
  const list = screen.getByRole('list', { name: '予約の手順' });
  expect(within(list).getAllByRole('listitem').map(el => el.textContent)).toEqual(steps.map((label, i) => `${i + 1} ${label}`));
  expect(list.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
  expect(list.querySelector('[aria-current="step"]')?.textContent).toBe('3 日時');
  view.rerender(<Stepper steps={steps} current={3} />);
  expect(list.querySelector('[aria-current="step"]')?.textContent).toBe('4 確認');
});

it('主色の混同と読み込みの明滅を禁止する', () => {
  const css = readFileSync(join(import.meta.dirname, '../index.css'), 'utf8') + readFileSync(join(import.meta.dirname, '../components/ui/liff-skin.css'), 'utf8') + readFileSync(join(import.meta.dirname, '../tokens.css'), 'utf8');
  expect(css).not.toMatch(/--color-liff-primary:\s*#087a3e/);
  expect(readFileSync(join(import.meta.dirname, '../components/loading-view.tsx'), 'utf8')).not.toContain('animate-pulse');
});
