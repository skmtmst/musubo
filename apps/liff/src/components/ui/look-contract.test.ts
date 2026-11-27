import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import Button from './Button.js';
import { STYLE_BROWSER_HOOK_TIMEOUT, styleBrowser } from '../../test-utils/style-browser.js';

let view: Awaited<ReturnType<typeof styleBrowser>>;
beforeAll(async () => { view = await styleBrowser(); }, STYLE_BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await view?.browser.close(); });

it.each([
  ['natural', 'rgb(251, 250, 247)', 'rgb(18, 61, 47)', 'rgb(255, 255, 255)', '23px', 'Shippori Mincho'],
  ['modern', 'rgb(255, 255, 255)', 'rgb(43, 45, 49)', 'rgb(255, 255, 255)', '10px', 'Noto Sans JP'],
  ['gentle', 'rgb(255, 248, 243)', 'rgb(181, 83, 47)', 'rgb(255, 255, 255)', '21px', 'Zen Maru Gothic'],
  ['night', 'rgb(15, 28, 51)', 'rgb(201, 169, 106)', 'rgb(15, 28, 51)', '23px', 'Shippori Mincho'],
  ['line', 'rgb(255, 255, 255)', 'rgb(3, 135, 58)', 'rgb(255, 255, 255)', '10px', 'Noto Sans JP'],
])('%s の型で地・主ボタン・見出しを描く', async (theme, canvas, primary, ink, radius, font) => {
  await view.show(`<main data-liff-theme="${theme}" class="bg-canvas"><h1>見出し</h1><span class="liff-num">123</span><aside class="bg-liff-note">お知らせ</aside>${renderToStaticMarkup(createElement(Button, {}, '申し込む'))}</main>`);
  expect(await view.page.locator('main').evaluate(el => getComputedStyle(el).backgroundColor)).toBe(canvas);
  const button = await view.page.getByRole('button').evaluate(el => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, color: s.color, radius: s.borderRadius, height: el.getBoundingClientRect().height };
  });
  expect(button).toEqual({ background: primary, color: ink, radius, height: 48 });
  expect(await view.page.locator('h1').evaluate(el => getComputedStyle(el).fontFamily)).toContain(font);
  expect(await view.page.locator('.liff-num').evaluate(el => getComputedStyle(el).fontFamily)).toContain(theme === 'gentle' ? 'Zen Maru Gothic' : 'Inter');
  expect(await view.page.locator('aside').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(242, 246, 254)');
  if (theme === 'modern') expect(await view.page.locator('h1').evaluate(el => getComputedStyle(el).fontWeight)).toBe('800');
});

it('型の禁止の見張りを保つ', () => {
  const root = join(import.meta.dirname, '../..');
  const css = readFileSync(join(root, 'index.css'), 'utf8') + readFileSync(join(root, 'components/ui/liff-skin.css'), 'utf8') + readFileSync(join(root, 'tokens.css'), 'utf8');
  for (const theme of ['modern', 'night']) {
    const block = css.match(new RegExp(`\\[data-liff-theme="${theme}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(block).not.toMatch(/#000\b/);
    expect(block).not.toContain('#000000');
  }
  expect(css).not.toMatch(/\[data-liff-theme="line"\]\s*\{/);
  for (const theme of ['natural', 'modern', 'gentle', 'night']) {
    const block = css.match(new RegExp(`\\[data-liff-theme="${theme}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(block).not.toContain('--color-liff-note');
  }
});

it.each([375, 414])('幅%sでも主ボタンを画面内に収める', async width => {
  await view.page.setViewportSize({ width, height: 812 });
  await view.show(`<main class="max-w-md mx-auto px-4">${renderToStaticMarkup(createElement(Button, {}, '内容を確かめる'))}</main>`);
  const box = await view.page.getByRole('button').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width);
});

it('副操作と危険な操作・押せない選択を別の表示で伝える', async () => {
  await view.show(renderToStaticMarkup(createElement('div', {},
    createElement(Button, { variant: 'secondary' }, '読み直す'),
    createElement(Button, { variant: 'danger' }, '取り消す'),
    createElement(Button, { variant: 'optionRow', unavailable: true, disabled: true }, '満席'),
  )));
  const secondary = await view.page.getByRole('button', { name: '読み直す' }).evaluate(el => ({ background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopWidth, height: el.getBoundingClientRect().height }));
  expect(secondary).toEqual({ background: 'rgb(255, 255, 255)', border: '1px', height: 44 });
  expect(await view.page.getByRole('button', { name: '取り消す' }).evaluate(el => getComputedStyle(el).color)).toBe('rgb(255, 255, 255)');
  expect(await view.page.getByRole('button', { name: '取り消す' }).evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgb(255, 255, 255)');
  expect(await view.page.getByRole('button', { name: '満席' }).isDisabled()).toBe(true);
});

it.each([
  ['natural', '#ffffff', '#e9e4dc', '#76716a', '#1a1a1a', '#c9a96a', '#c4beb4', '23px', '300'],
  ['modern', '#f5f5f5', '#e8e8e8', '#6e6e73', '#111111', '#ff9f0a', '#c7c7cc', '10px', '500'],
  ['gentle', '#ffffff', '#f1e2d6', '#8a7468', '#3b2a22', '#e8b04a', '#d6c6bb', '21px', '500'],
  ['night', '#172a47', '#27406a', '#a9b8d0', '#f2f5fa', '#e0c48a', '#4a5f82', '23px', '300'],
  ['line', '#f5f5f7', '#e6e9ed', '#5f6670', '#1d1d1f', '#b26b00', '#c3c8cf', '14px', '400'],
])('%s の本文・線・空きの印・箱の角丸を描く', async (theme, ground, line, sub, ink, few, full, radius, weight) => {
  await view.show(`<main data-liff-theme="${theme}"><article class="bg-ground border border-liff-line rounded-(--liff-radius-lg)"><p class="text-ink">本文</p><p class="text-liff-sub">補足</p><p class="text-liff-dot-few">残りわずか</p><p class="text-liff-full">満席</p><span class="liff-num">123</span></article></main>`);
  const rgb = (hex: string) => `rgb(${[1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16)).join(', ')})`;
  const card = await view.page.locator('article').evaluate(el => { const s = getComputedStyle(el); return { background: s.backgroundColor, border: s.borderTopColor, radius: s.borderRadius }; });
  expect(card).toEqual({ background: rgb(ground), border: rgb(line), radius });
  for (const [label, color] of [['本文', ink], ['補足', sub], ['残りわずか', few], ['満席', full]]) expect(await view.page.getByText(label, { exact: true }).evaluate(el => getComputedStyle(el).color)).toBe(rgb(color));
  expect(await view.page.locator('.liff-num').evaluate(el => getComputedStyle(el).fontWeight)).toBe(weight);
});

it.each(['modern', 'night'])('%s の画面で主ボタンと文字を真っ黒にしない', async theme => {
  await view.show(`<main data-liff-theme="${theme}" class="bg-canvas text-ink"><p>本文</p>${renderToStaticMarkup(createElement(Button, {}, '次へ'))}</main>`);
  const colors = await view.page.locator('main, main p, main button').evaluateAll(nodes => nodes.flatMap(el => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]));
  expect(colors).not.toContain('rgb(0, 0, 0)');
});

it('LINEの画面は型指定がない画面と同じ色を表示する', async () => {
  const button = renderToStaticMarkup(createElement(Button, {}, '次へ'));
  await view.show(`<main id="default" class="bg-canvas text-ink">${button}<aside class="bg-liff-note">お知らせ</aside></main><main id="line" data-liff-theme="line" class="bg-canvas text-ink">${button}<aside class="bg-liff-note">お知らせ</aside></main>`);
  const colors = (selector: string) => view.page.locator(selector).evaluateAll(nodes => nodes.flatMap(el => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]));
  expect(await colors('#line, #line button, #line aside')).toEqual(await colors('#default, #default button, #default aside'));
});

it.each(['natural', 'modern', 'gentle', 'night'])('%s のお知らせは共通の背景色を保つ', async theme => {
  await view.show(`<main><aside id="default" class="bg-liff-note">お知らせ</aside><div data-liff-theme="${theme}"><aside id="themed" class="bg-liff-note">お知らせ</aside></div></main>`);
  const background = (selector: string) => view.page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor);
  expect(await background('#themed')).toBe(await background('#default'));
});
