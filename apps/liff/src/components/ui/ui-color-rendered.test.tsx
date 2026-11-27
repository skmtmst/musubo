import { cleanup, fireEvent, render } from '@testing-library/react';
import { Window } from 'happy-dom';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import StatusView from './status-view.js';
import LoadErrorView from '../load-error-view.js';
import { STYLE_BROWSER_HOOK_TIMEOUT, styleBrowser } from '../../test-utils/style-browser.js';

let view: Awaited<ReturnType<typeof styleBrowser>>;
beforeAll(async () => { view = await styleBrowser(); }, STYLE_BROWSER_HOOK_TIMEOUT);
beforeEach(() => {
  const browser = new Window({ url: 'https://example.test/' });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('document', browser.document);
  vi.stubGlobal('HTMLElement', browser.HTMLElement);
  vi.stubGlobal('navigator', browser.navigator);
});

it('読み込み失敗は赤い警告色を使わず、読み直しを押せる', async () => {
  const retry = vi.fn();
  const rendered = render(<LoadErrorView onRetry={retry} />);
  fireEvent.click(rendered.getByRole('button', { name: 'もう一度読み込む' }));
  expect(retry).toHaveBeenCalledOnce();
  await view.show(rendered.container.innerHTML);
  const colors = await view.page.locator('body *').evaluateAll(elements => elements.flatMap(el => {
    const style = getComputedStyle(el);
    return [style.color, style.backgroundColor, style.borderTopColor];
  }));
  const red = colors.filter(color => {
    const match = color.match(/^rgba?\((\d+), (\d+), (\d+)/);
    if (!match) return false;
    const [r, g, b] = match.slice(1).map(Number);
    return r > 100 && r > g * 1.5 && r > b * 1.5;
  });
  expect(red).toEqual([]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
afterAll(async () => { await view?.browser.close(); });

it.each(['line', 'natural', 'modern', 'gentle', 'night'])('%s の状態画面では主ボタンを押せ、別のサービスの緑や青にならない', async theme => {
  const action = vi.fn();
  const rendered = render(<div data-liff-theme={theme}><StatusView icon="check" title="受付済み" action={{ label: '確認する', onClick: action }} /></div>);
  fireEvent.click(rendered.getByRole('button', { name: '確認する' }));
  expect(action).toHaveBeenCalledOnce();
  await view.show(rendered.container.innerHTML);
  const background = await view.page.getByRole('button', { name: '確認する' }).evaluate(el => getComputedStyle(el).backgroundColor);
  expect(background).not.toBe('rgb(6, 199, 85)');
  expect(background).not.toBe('rgb(11, 99, 206)');
});
