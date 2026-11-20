import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import Button from '../components/ui/Button.js';
import { STYLE_BROWSER_HOOK_TIMEOUT, styleBrowser } from '../test-utils/style-browser.js';

let view: Awaited<ReturnType<typeof styleBrowser>>;
beforeAll(async () => { view = await styleBrowser(); }, STYLE_BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await view?.browser.close(); });

it.each(['icon', 'arrow', 'chip', 'restaurant-control'] as const)('%s は見た目の外側も44px以上の範囲で押せる', async variant => {
  await view.show(`<main style="padding:80px">${renderToStaticMarkup(createElement(Button, { variant }, '操作'))}</main>`);
  const button = view.page.getByRole('button');
  const target = await button.evaluate(el => {
    const box = el.getBoundingClientRect();
    const after = getComputedStyle(el, '::after');
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    return { width: parseFloat(after.width), height: parseFloat(after.height), hits: [[x - 21, y], [x + 21, y], [x, y - 21], [x, y + 21]].every(([cx, cy]) => el.contains(document.elementFromPoint(cx, cy))) };
  });
  expect(target.width).toBeGreaterThanOrEqual(44);
  expect(target.height).toBeGreaterThanOrEqual(44);
  expect(target.hits).toBe(true);
});

it.each(['absolute', 'fixed', 'sticky'])('%s の操作の位置を押せる範囲のために変えない', async position => {
  await view.show(renderToStaticMarkup(createElement(Button, { variant: 'icon', className: position }, '操作')));
  expect(await view.page.getByRole('button').evaluate(el => getComputedStyle(el).position)).toBe(position);
});

it('個人情報のリンクは行の高さを増やさず、押せる範囲を広げる', async () => {
  const { default: PrivacyNote } = await import('../components/ui/privacy-note.js');
  await view.show(renderToStaticMarkup(createElement(PrivacyNote)));
  const link = view.page.getByRole('link', { name: 'プライバシーポリシー' });
  expect(await link.evaluate(el => parseFloat(getComputedStyle(el, '::after').height))).toBeGreaterThanOrEqual(44);
  expect(await link.evaluate(el => el.parentElement!.getBoundingClientRect().height)).toBe(18);
});
