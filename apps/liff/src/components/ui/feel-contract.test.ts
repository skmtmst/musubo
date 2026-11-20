import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import Button from './Button.js';
import { STYLE_BROWSER_HOOK_TIMEOUT, styleBrowser } from '../../test-utils/style-browser.js';

let view: Awaited<ReturnType<typeof styleBrowser>>;
beforeAll(async () => { view = await styleBrowser(); }, STYLE_BROWSER_HOOK_TIMEOUT);
afterAll(async () => { await view?.browser.close(); });
afterEach(async () => { await view.page.mouse.up(); await view.page.emulateMedia({ reducedMotion: 'no-preference' }); });

it('押すと縮み、離すと元に戻る', async () => {
  await view.show(renderToStaticMarkup(createElement(Button, {}, '選ぶ')));
  const button = view.page.getByRole('button', { name: '選ぶ' });
  await button.hover();
  await view.page.mouse.down();
  await expect.poll(() => button.evaluate(el => getComputedStyle(el).transform)).toBe('matrix(0.96, 0, 0, 0.96, 0, 0)');
  expect(await button.evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0.08s');
  await view.page.mouse.up();
  expect(await button.evaluate(el => getComputedStyle(el).transitionTimingFunction)).toContain('cubic-bezier(0.34, 1.36, 0.64, 1)');
  await expect.poll(() => button.evaluate(el => getComputedStyle(el).transform)).toBe('none');
  expect(await button.evaluate(el => getComputedStyle(el).transitionDuration)).toBe('0.16s, 0.16s');
});

it('骨組みの光が左から右へ流れ、段の中身は右から現れる', async () => {
  await view.show('<div class="liff-shimmer-bone" style="width:200px;height:40px"></div><main class="liff-step" style="animation-fill-mode:both">中身</main>');
  const animations = await view.page.evaluate(() => document.getAnimations().map(animation => {
    animation.pause();
    const effect = animation.effect as KeyframeEffect;
    return { duration: effect.getTiming().duration, frames: effect.getKeyframes().map(frame => ({ transform: frame.transform, opacity: frame.opacity })) };
  }));
  expect(animations).toContainEqual({ duration: 1200, frames: [{ transform: 'translateX(-100%)', opacity: undefined }, { transform: 'translateX(100%)', opacity: undefined }] });
  expect(animations).toContainEqual({ duration: 240, frames: [{ transform: 'translateX(24px)', opacity: '0' }, { transform: 'translateX(0px)', opacity: '1' }] });
});

it('動きを減らす設定では押しと光を止め、段は薄く入れ替わる', async () => {
  await view.page.emulateMedia({ reducedMotion: 'reduce' });
  await view.show(renderToStaticMarkup(createElement(Button, {}, '選ぶ')) + '<div class="liff-shimmer-bone"></div><main class="liff-step" style="animation-fill-mode:both">中身</main>');
  const button = view.page.getByRole('button');
  await button.hover();
  await view.page.mouse.down();
  expect(await button.evaluate(el => getComputedStyle(el).transform)).toBe('none');
  expect(await button.evaluate(el => getComputedStyle(el).transitionProperty)).toBe('none');
  expect(await view.page.locator('.liff-shimmer-bone').evaluate(el => getComputedStyle(el, '::after').animationName)).toBe('none');
  const frames = await view.page.locator('main').evaluate(el => (el.getAnimations()[0].effect as KeyframeEffect).getKeyframes());
  expect(frames.map(frame => frame.opacity)).toEqual(['0', '1']);
  expect(frames.every(frame => frame.transform === undefined)).toBe(true);
  await view.page.mouse.up();
  await view.page.emulateMedia({ reducedMotion: 'no-preference' });
});
