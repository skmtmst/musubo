import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { Window } from 'happy-dom';
import Button from '../components/ui/button/index.js';
import LoadingView from '../components/loading-view.js';
import { STYLE_BROWSER_HOOK_TIMEOUT, styleBrowser } from '../test-utils/style-browser.js';

let view: Awaited<ReturnType<typeof styleBrowser>>;
beforeAll(async () => { view = await styleBrowser(); }, STYLE_BROWSER_HOOK_TIMEOUT);
beforeEach(() => {
  const browser = new Window({ url: 'https://example.test/' });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('document', browser.document);
  vi.stubGlobal('HTMLElement', browser.HTMLElement);
  vi.stubGlobal('navigator', browser.navigator);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
afterAll(async () => { await view?.browser.close(); });

it.each(['line', 'natural', 'modern', 'gentle', 'night'])('%s の主ボタンは管理画面の主色と混同せず操作できる', async (theme) => {
  const onClick = vi.fn();
  const rendered = render(<div data-liff-theme={theme}><Button onClick={onClick}>次へ</Button></div>);
  fireEvent.click(rendered.getByRole('button', { name: '次へ' }));
  expect(onClick).toHaveBeenCalledOnce();
  await view.show(rendered.container.innerHTML);
  const color = await view.page.getByRole('button', { name: '次へ' }).evaluate(el => getComputedStyle(el).backgroundColor);
  expect(color).not.toBe('rgb(8, 122, 62)');
});

it('読み込みが続くと骨組みを表示し、明滅ではなく流れる光で知らせる', async () => {
  vi.useFakeTimers();
  const rendered = render(<LoadingView />);
  expect(rendered.getByRole('status').getAttribute('aria-busy')).toBe('true');
  await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(rendered.getByRole('status').querySelectorAll('[aria-hidden="true"] > div')).toHaveLength(5);
  vi.useRealTimers();
  await view.show(rendered.container.innerHTML);
  const animations = await view.page.getByRole('status').evaluate(root => Array.from(root.querySelectorAll('*')).flatMap(el => [getComputedStyle(el).animationName, getComputedStyle(el, '::after').animationName]));
  expect(animations).not.toContain('pulse');
  expect(animations).toContain('liff-feel-shimmer');
});
