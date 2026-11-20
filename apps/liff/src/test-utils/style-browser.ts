import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { preprocessCSS, resolveConfig } from 'vite';

/**
 * `styleBrowser()` を呼ぶ `beforeAll` に渡す持ち時間。
 *
 * この関数は index.css を本番と同じ PostCSS で通してから Chromium を立てる。
 * 手元では数秒で終わるが、必須ゲートの `Repository and shared checks` は
 * 同じジョブで先に 700 本超のテストファイルを回してから liff に入るため、
 * 混雑した側では同じ処理が大きく伸びる。実測で environment 44.21s・
 * import 57.49s まで伸び、30 秒では足りずに
 * `Error: Hook timed out in 30000ms.` でゲートが落ちていた
 * （run 44308406826 / 44271075205）。手元とCIで 10 倍以上ぶれる処理なので、
 * 持ち時間はぶれの幅に合わせて取る。確認している内容は変わらない。
 */
export const STYLE_BROWSER_HOOK_TIMEOUT = 120_000;

/** 本番と同じ PostCSS 処理でスタイルをコンパイルし、Chromium へ適用する。 */
export async function styleBrowser(): Promise<{ browser: Browser; page: Page; show: (html: string) => Promise<void> }> {
  const filename = fileURLToPath(new URL('../index.css', import.meta.url));
  const config = await resolveConfig({ root: fileURLToPath(new URL('../../', import.meta.url)) }, 'serve');
  const compile = async (source: string) => (await preprocessCSS(source, filename, config)).code;
  const css = await compile(readFileSync(filename, 'utf8'));
  const browser = await chromium.launch(existsSync(chromium.executablePath()) ? { executablePath: chromium.executablePath(), headless: true } : { channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  await page.route('**/*', route => route.abort());
  return { browser, page, show: async html => {
    await page.setContent(`<html lang="ja"><head><style>${css}</style></head><body>${html}</body></html>`);
  } };
}
