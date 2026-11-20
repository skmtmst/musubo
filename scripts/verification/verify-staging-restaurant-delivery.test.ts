/*
 * 検証環境のデリバリー受注を「ログイン済みで読むだけ」確かめる段取りが、
 * 本番へ届かず・書き込まず・秘密値を漏らさないことを固める試験。
 *
 * 未認証では3画面とも `/login` へ移るため、承認版v02（板 kDQHr・OzHLO・h7OeT）が
 * 実際に描けているかを確かめるには一時的な管理セッションが要る。その一時行が
 * 15分で切れ、終わりに自分の1行だけ消え、残存0件を数えることまでを縛る。
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';

import {
  FONTS_READY_SOURCE,
  READ_FAILURE_STATES_SOURCE,
  READ_GATE_SOURCE,
  READ_TITLE_SOURCE,
  SCREEN_PATH,
  TITLE_PAGE,
  TITLE_SUB,
  inspectFlatBody,
  missingFields,
  nextStepFor,
  nextStepForGate,
  readAdminTarget,
  readOnlyRequest,
  readRestaurantTestFlag,
  screenFailures,
  type DeliveryGates,
  type ScreenReport,
  type TitleInfo,
} from './verify-staging-restaurant-delivery.js';
import { readVerificationTarget } from './verify-staging-operational-path.js';

const script = readFileSync(
  new URL('./verify-staging-restaurant-delivery.ts', import.meta.url),
  'utf8',
);
const stagingConfig = readFileSync(
  new URL('../../apps/worker/wrangler.staging.toml', import.meta.url),
  'utf8',
);

const deliveryScreen = readFileSync(
  new URL('../../apps/web/src/v8/restaurant/delivery/delivery.tsx', import.meta.url),
  'utf8',
);
const workflow = readFileSync(
  new URL('../../.github/workflows/migrate-d1.yml', import.meta.url),
  'utf8',
);
const historyScreen = readFileSync(
  new URL('../../apps/web/src/v8/restaurant/delivery/history.tsx', import.meta.url),
  'utf8',
);
const bulkScreen = readFileSync(
  new URL('../../apps/web/src/v8/restaurant/delivery/bulk.tsx', import.meta.url),
  'utf8',
);
const listState = readFileSync(
  new URL('../../apps/web/src/components/shared/list-state.tsx', import.meta.url),
  'utf8',
);
/** 題の大きさを決めている共通部品。副題の 18px/27px の出どころ。 */
const pageFrame = readFileSync(
  new URL('../../apps/web/src/components/templates/page-frame.tsx', import.meta.url),
  'utf8',
);

/** 3画面とも題が出て、中身も読めている状態。ここから1つずつ壊して不合格を確かめる。 */
function passingScreen(overrides: Partial<ScreenReport> = {}): ScreenReport {
  return {
    view: 'orders',
    title: 'デリバリー受注',
    expectedTitle: 'デリバリー受注',
    observedType: { ...TITLE_PAGE },
    expectedType: { ...TITLE_PAGE },
    titlePasses: true,
    landedOnLogin: false,
    landedPath: SCREEN_PATH,
    crashed: false,
    loadFailures: [],
    gate: null,
    pageErrors: 0,
    blockedWriteRequests: 0,
    ...overrides,
  };
}

const target = { accountId: 'account', databaseId: 'database', workerUrl: 'https://stg-api.musubo.jp' };

/**
 * 実ブラウザ用の雛形。3画面の題（型の題）と、共通部品が付ける失敗の印を再現する。
 * 横の案内・窓の見出し・見えない失敗は数えないことまで同じ1枚で確かめる。
 */
const FIXTURE_HTML = `<!doctype html>
<html lang="ja"><body style="margin:0">
  <aside><h1 style="font-size:22px;font-weight:700;line-height:32px">横の案内</h1></aside>
  <main>
    <div data-template-region="heading">
      <h1 style="font-size:22px;font-weight:700;line-height:32px">デリバリー受注</h1>
    </div>
    <div data-list-state="empty"><p>注文はまだありません</p></div>
    <div data-list-state="error" role="alert">
      <h3>注文を表示できませんでした</h3>
      <p>識別子を含む説明文はここに出る</p>
    </div>
    <div data-list-state="forbidden" style="visibility:hidden"><h3>表示する権限がありません</h3></div>
  </main>
</body></html>`;

/** 実ブラウザを入れていない場所（必須CIの `pnpm test:scripts` など）では飛ばす。 */
const chromiumExecutable = await (async (): Promise<string | null> => {
  try {
    const { chromium } = await import('@playwright/test');
    const path = chromium.executablePath();
    return path && existsSync(path) ? path : null;
  } catch {
    return null;
  }
})();

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

/** 入口がすべて開いている状態。ここから1つずつ閉じて次の手を確かめる。 */
function openGates(overrides: Partial<DeliveryGates> = {}): DeliveryGates {
  return {
    restaurantTestEnabled: true,
    activeAdmins: 1,
    activeLineAccounts: 1,
    tenantsWithRestaurantPack: 1,
    storesLinkedToLineAccount: 1,
    ...overrides,
  };
}

describe('staging delivery verification safety', () => {
  test('targets only the dedicated staging Worker, D1 and admin site', () => {
    // 対象の決め方は既に検証済みの共通処理へ委ねる。
    expect(script).toContain("const CONFIG_PATH = 'apps/worker/wrangler.staging.toml'");
    expect(script).toContain("readFileSync(CONFIG_PATH, 'utf8')");
    expect(script).toContain('readVerificationTarget(config)');
    expect(script).toContain("process.env.VERIFY_ENVIRONMENT !== 'staging'");

    expect(readVerificationTarget(stagingConfig)).toMatchObject({
      workerUrl: 'https://stg-api.musubo.jp',
    });
    expect(() => readVerificationTarget(
      stagingConfig.replace('name = "nen-line-stg"', 'name = "production"'),
    )).toThrow('Only the staging Worker is allowed');
    expect(() => readVerificationTarget(
      stagingConfig.replace('database_name = "nen-line-stg"', 'database_name = "nen-line"'),
    )).toThrow('Only the staging D1 database is allowed');
    expect(() => readVerificationTarget(
      stagingConfig.replace('WORKER_PUBLIC_URL = "https://stg-api.musubo.jp"', 'WORKER_PUBLIC_URL = "https://api.musubo.jp"'),
    )).toThrow('Unexpected staging Worker URL');
    expect(() => readVerificationTarget(
      `${stagingConfig}\n[triggers]\ncrons = ["* * * * *"]`,
    )).toThrow('must not have cron triggers');

    // 画面を開く宛先も設定から読む。本番の管理画面は開かない。
    expect(readAdminTarget(stagingConfig)).toEqual({ adminUrl: 'https://stg-admin.musubo.jp' });
    expect(() => readAdminTarget(
      stagingConfig.replace('ADMIN_PUBLIC_URL = "https://stg-admin.musubo.jp"', 'ADMIN_PUBLIC_URL = "https://admin.musubo.jp"'),
    )).toThrow('Only the staging admin site is allowed');
    expect(() => readAdminTarget(
      stagingConfig.replace('ADMIN_PUBLIC_URL = "https://stg-admin.musubo.jp"', 'ADMIN_PUBLIC_URL = "http://stg-admin.musubo.jp"'),
    )).toThrow('Unexpected staging admin URL');
    expect(() => readAdminTarget(
      stagingConfig.replace('ADMIN_PUBLIC_URL = "https://stg-admin.musubo.jp"', 'ADMIN_PUBLIC_URL = "stg-admin.musubo.jp"'),
    )).toThrow('Unexpected staging admin URL');
    expect(() => readAdminTarget(
      stagingConfig.replace('ADMIN_PUBLIC_URL =', 'ADMIN_PUBLIC_URL_DISABLED ='),
    )).toThrow('ADMIN_PUBLIC_URL is missing');

    // 設定の `ADMIN_ORIGIN` にも同じ文字列が入るので、取り違えないことを押さえる。
    expect(stagingConfig).toContain('ADMIN_ORIGIN =');
    expect(readRestaurantTestFlag(stagingConfig)).toBe(true);
    expect(readRestaurantTestFlag(
      stagingConfig.replace('RESTAURANT_TEST_ENABLED = "true"', 'RESTAURANT_TEST_ENABLED = "false"'),
    )).toBe(false);
  });

  test('runs only from the staging workflow entry, so no secret is needed on a laptop', () => {
    // 手元に秘密値を置かずに走らせる唯一の入口。staging と codex/development に限る。
    expect(workflow).toContain("inputs.operation == 'verify-restaurant-delivery'");
    expect(workflow).toContain('scripts/verification/verify-staging-restaurant-delivery.ts');
    expect(workflow).toContain("inputs.environment == 'staging'");
    expect(workflow).toContain("github.repository == 'skmtmst/line-harness-oss'");
    expect(workflow).toContain("github.ref == 'refs/heads/codex/development'");
    expect(workflow).toContain('VERIFY_ENVIRONMENT: staging');
    expect(workflow).toContain('group: verify-staging-restaurant-delivery');
    expect(workflow).toContain('set -o pipefail');
    expect(workflow).not.toMatch(/\bset\s+-x\b/);
    // 実ブラウザで開くので、走らせる側に Chromium が要る。
    expect(workflow).toContain('playwright install --with-deps chromium');
    // 集計だけを出す。秘密値や個別の識別子をサマリーへ流さない。
    expect(workflow).toContain('tail -n 1 "$RUNNER_TEMP/delivery-verification.json"');
    expect(workflow).not.toMatch(/CLOUDFLARE_API_TOKEN[^\n]*GITHUB_STEP_SUMMARY/);
  });

  test('calls only the four read-only endpoints, never an order operation', async () => {
    const allowed = fakeFetch(200, { success: true, store: { id: 'store-1' } });
    const result = await readOnlyRequest(
      target,
      'token-value',
      '/api/restaurant-test/delivery/orders?account_id=account-1&tab=all',
      allowed,
    );
    expect(result).toMatchObject({ status: 200 });
    const [url, init] = allowed.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://stg-api.musubo.jp/api/restaurant-test/delivery/orders?account_id=account-1&tab=all');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer lh_session:token-value');

    // 注文の詳細は通る。
    const detail = fakeFetch(200, { success: true, order: { id: 'order-1' }, items: [] });
    await expect(readOnlyRequest(
      target, 'token-value', '/api/restaurant-test/delivery/orders/order-1?account_id=account-1', detail,
    )).resolves.toMatchObject({ status: 200 });

    // 操作の口は、識別子の後ろへ付けても通らない（道の頭だけで許さない）。
    const blocked = fakeFetch(200, { success: true });
    for (const forbidden of [
      '/api/restaurant-test/delivery/orders/order-1/accept',
      '/api/restaurant-test/delivery/orders/order-1/ready',
      '/api/restaurant-test/delivery/orders/order-1/handed-over',
      '/api/restaurant-test/delivery/orders/order-1/reject',
      '/api/restaurant-test/delivery/orders/order-1/cancel',
      '/api/restaurant-test/delivery/menu-items/bulk-sold-out',
      '/api/restaurant-test/delivery/intake/stop',
      '/api/restaurant-test/delivery/intake/resume',
      '/api/restaurant-test/delivery/webhooks/ubereats',
      '/api/restaurant-test/delivery/history.csv?account_id=account-1',
      '/api/notifications/rules',
    ]) {
      await expect(readOnlyRequest(target, 'token-value', forbidden, blocked)).rejects.toThrow(
        'may only call the read-only',
      );
    }
    expect(blocked).not.toHaveBeenCalled();

    expect(script).toContain("method: 'GET'");
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(script).not.toContain(`method: '${verb}'`);
    }
    // 画面からの通信も GET だけ通し、それ以外は断つ。
    expect(script).toContain("route.request().method() === 'GET'");
    expect(script).toContain('route.abort()');
    expect(script).toContain('blockedWriteRequests');
    expect(script).toContain('writeRequestsSent: 0');
    // 配信・台帳・在庫を自分で動かさない。
    for (const forbidden of ['sendWithLedger', 'pushMessage', 'multicast', 'UPDATE rt_', 'INSERT INTO rt_']) {
      expect(script).not.toContain(forbidden);
    }
  });

  test('keeps the temporary session short-lived and deletes only its own row', () => {
    expect(script).toContain('const SESSION_TTL_MINUTES = 15');
    expect(script).toContain('INSERT OR IGNORE INTO admin_sessions (token_hash, staff_id, expires_at)');
    expect(script).toContain('DELETE FROM admin_sessions WHERE token_hash = ?');
    expect(script).toContain('temporarySessionDeleted: true');
    // 自分が作った一時行だけを消す。期限切れの他行を一括削除する道を作らない。
    expect(script).not.toContain('expires_at <=');
    expect(script).not.toMatch(/DELETE FROM admin_sessions WHERE(?! token_hash = \?)/);
    expect(script).not.toMatch(/DELETE FROM (?!admin_sessions)/);
    // 担当者は作らずに探す。
    expect(script).not.toContain('INSERT INTO staff_members');
    expect(script).not.toContain('INSERT OR IGNORE INTO staff_members');
    // 残存0件を数えてから合格にする。
    expect(script).toContain('SELECT COUNT(*) AS count FROM admin_sessions WHERE token_hash = ?');
    expect(script).toContain('Staging cleanup incomplete');
    expect(script).toContain('leftoverCount !== 0');
  });

  test('never puts the session token in a URL, log or summary', () => {
    // 合言葉は `sessionStorage` へ直接置く。URL（fragment）へは載せない。
    expect(script).toContain("sessionStorage.setItem('lh_admin_session_fallback', token)");
    expect(script).toContain('await page.goto(`${admin.adminUrl}${SCREEN_PATH}${screen.search}`');
    expect(script).not.toContain('lh_session=');
    expect(script).not.toContain('#lh_session');
    // 画面側が同じ場所を読むので、これで `AuthGuard` も通る。
    const adminSession = readFileSync(
      new URL('../../apps/web/src/lib/admin-session.ts', import.meta.url),
      'utf8',
    );
    expect(adminSession).toContain("ADMIN_SESSION_STORAGE_KEY = 'lh_admin_session_fallback'");
    // 店舗の選び取りは明示する（未選択のとき先頭へ落ちない作りなので）。
    expect(script).toContain("localStorage.setItem('lh_selected_account', accountId)");
    const accountContext = readFileSync(
      new URL('../../apps/web/src/contexts/account-context.tsx', import.meta.url),
      'utf8',
    );
    expect(accountContext).toContain("const STORAGE_KEY = 'lh_selected_account'");
    // 合言葉・鍵・識別子をログへ出さない。
    expect(script).not.toMatch(
      /console\.(?:log|error)\([^\n]*(?:sessionToken|sessionHash|apiToken|CLOUDFLARE_API_TOKEN|staff_id|line_account_id)/,
    );
  });

  test('keeps the chosen store by marking the post-auth clear as done', () => {
    // AuthGuard は認証確認のあと一度だけ前回の選択を捨てる。印が無いと
    // スクリプトが置いた店舗選択も消され、3画面とも店舗未選択の門で止まる。
    const navigation = readFileSync(
      new URL('../../apps/web/src/lib/hq-navigation.ts', import.meta.url),
      'utf8',
    );
    expect(navigation).toContain("ACCOUNT_SELECTION_KEY = 'lh_selected_account'");
    expect(navigation).toContain("AUTH_SELECTION_CLEARED_KEY = 'lh_auth_selection_cleared'");
    // 印があれば消さない、という実装と期待を結び付ける。
    expect(navigation).toContain('if (local.getItem(AUTH_SELECTION_CLEARED_KEY) === \'1\') return false');
    expect(navigation).toContain('if (session.getItem(AUTH_SELECTION_CLEARED_KEY) === \'1\') return false');
    expect(navigation).toContain('local.removeItem(ACCOUNT_SELECTION_KEY)');
    // その処理が認証確認の成功側で実際に呼ばれている。
    const authGuard = readFileSync(
      new URL('../../apps/web/src/components/auth-guard.tsx', import.meta.url),
      'utf8',
    );
    expect(authGuard).toContain('clearSelectionAfterAuthentication(localStorage, sessionStorage)');

    // スクリプトは正本の localStorage と、残存扱いにされる sessionStorage の
    // 両方へ印を置く。どちらかの行が消えたらここで落ちる。
    expect(script).toContain("localStorage.setItem('lh_auth_selection_cleared', '1')");
    expect(script).toContain("sessionStorage.setItem('lh_auth_selection_cleared', '1')");
    // 印は店舗選択より先に置く（後だと置く前に消される余地が残る）。
    const markerAt = script.indexOf("localStorage.setItem('lh_auth_selection_cleared', '1')");
    const selectionAt = script.indexOf("localStorage.setItem('lh_selected_account', accountId)");
    expect(markerAt).toBeGreaterThan(-1);
    expect(selectionAt).toBeGreaterThan(markerAt);
    // 印も店舗選択も、画面が描かれる前に走る `addInitScript` の中にある。
    const initAt = script.search(/await page\.addInitScript\(/);
    expect(initAt).toBeGreaterThan(-1);
    expect(markerAt).toBeGreaterThan(initAt);
  });

  test('checks the real flat shape the three screens actually read', async () => {
    // 既定の器は `data` で包むので、包まれていないことが本物と同じ形の証。
    expect(inspectFlatBody(
      { success: true, store: { id: 's', name: 'n' }, services: [], kpis: { todayCount: 0 }, tab: 'all', tabCounts: {}, orders: [] },
      ['store.id', 'store.name', 'services', 'kpis.todayCount', 'tab', 'tabCounts', 'orders'],
    )).toEqual({ wrapped: false, success: true, missing: [] });

    expect(inspectFlatBody(
      { success: true, data: { store: { id: 's' } } },
      ['store.id', 'orders'],
    )).toEqual({ wrapped: true, success: true, missing: ['orders', 'store.id'] });

    // 配列を器と間違えない。中身が null の項目も欠けとして数える。
    expect(missingFields({ store: ['id'], range: { from: '2026-10-01', to: null } }, ['store.id', 'range.from', 'range.to']))
      .toEqual(['range.to', 'store.id']);

    const shape = inspectFlatBody({ success: false, order: { id: 'o' } }, ['order.id']);
    expect(shape).toEqual({ wrapped: false, success: false, missing: [] });
    expect(script).toContain('Unexpected staging delivery response for');

    // 題は画面側の `PAGE_META` と同じ3つ。
    for (const title of ['デリバリー受注', '注文履歴・売上', '品切れ一括設定']) {
      expect(script).toContain(`title: '${title}'`);
      expect(deliveryScreen).toContain(`title: '${title}'`);
    }
    expect(script).toContain("export const SCREEN_PATH = '/restaurant-test/delivery'");
    expect(script).toContain("search: '?view=history'");
    expect(script).toContain("search: '?view=sold-out'");
    expect(script).toContain("const CRASH_TITLE = '画面を表示できませんでした'");
    expect(script).toContain('landedOnLogin');
  });

  test('measures each title against the type its own drawing uses', () => {
    // 検証環境の実行 38143831111 が3画面とも `title` で落ちた原因。
    // 1つの値で測っていたため、副題で描かれている2枚が必ず不合格になっていた。
    expect(TITLE_PAGE).toEqual({ size: '22px', weight: '700', lh: '32px' });
    expect(TITLE_SUB).toEqual({ size: '18px', weight: '700', lh: '27px' });

    // 画面側は副題を2枚に渡している（板 OzHLO・h7OeT）。ここが期待値の根拠。
    expect(deliveryScreen).toContain("history: { titleSize: 'sub' }");
    expect(deliveryScreen).toContain("'sold-out': { titleSize: 'sub' }");
    // 共通部品が副題のとき 18px/27px を頭の中だけに流す。
    expect(pageFrame).toContain("titleSize === 'sub'");
    expect(pageFrame).toContain("'--tpl-title-size': '18px'");
    expect(pageFrame).toContain("'--tpl-title-lh': '27px'");

    // 期待値は画面ごとに持つ。注文一覧だけが頁の題。
    expect(script).toContain("title: 'デリバリー受注', type: TITLE_PAGE");
    expect(script).toContain("title: '注文履歴・売上', type: TITLE_SUB");
    expect(script).toContain("title: '品切れ一括設定', type: TITLE_SUB");
    expect(script).toContain('title.size === screen.type.size');
    expect(script).toContain('title.weight === screen.type.weight');
    expect(script).toContain('title.lh === screen.type.lh');
    // 1つの値で3画面をまとめて測る形へ戻さない。
    expect(script).not.toContain("title.size === '22px' && title.weight === '700' && title.lh === '32px'");

    // 型が違えば実測値を添えて不合格。副題の画面に頁の題が出たら気付ける。
    expect(screenFailures(passingScreen({
      view: 'history',
      title: '注文履歴・売上',
      expectedTitle: '注文履歴・売上',
      expectedType: { ...TITLE_SUB },
      observedType: { ...TITLE_SUB },
    }))).toEqual([]);
    expect(screenFailures(passingScreen({
      view: 'sold-out',
      title: '品切れ一括設定',
      expectedTitle: '品切れ一括設定',
      expectedType: { ...TITLE_SUB },
      observedType: { ...TITLE_PAGE },
    }))).toEqual(['title-type(22px/700/32px, want=18px/700/27px)']);

    // 水分けを待つ目印。数え切りの待ちだけへ戻さない（配った HTML に題は入っていない）。
    expect(script).toContain('page.waitForSelector(SETTLED_SELECTOR');
    expect(script).not.toContain('await page.waitForTimeout(4000)');
    expect(deliveryScreen).toContain('Suspense');
  });

  test('puts the values it actually read into the failure reasons', () => {
    // 原因を判断できるよう、実測値と行き先を必ず添える。
    expect(screenFailures(passingScreen({ title: null, observedType: null })))
      .toEqual(['title(none, want=デリバリー受注)']);
    expect(screenFailures(passingScreen({ title: '店舗が選ばれていません' })))
      .toEqual(['title(店舗が選ばれていません, want=デリバリー受注)']);
    // `/login` 以外へ移った場合も行き先を出す。
    expect(screenFailures(passingScreen({ landedPath: '/hq' })))
      .toEqual(['redirect(/hq)']);
    // `/login` のときは `login` が出るので行き先を重ねない。
    expect(screenFailures(passingScreen({ landedOnLogin: true, landedPath: '/login' })))
      .toEqual(['login']);
    // 長い文字は失敗の1枚と同じ40字で切る。
    expect(screenFailures(passingScreen({ title: 'あ'.repeat(60) })))
      .toEqual([`title(${'あ'.repeat(40)}, want=デリバリー受注)`]);
    // 重なったときは理由を全部並べる。
    expect(screenFailures(passingScreen({
      title: '別の題',
      observedType: { ...TITLE_SUB },
      loadFailures: ['error:注文を表示できませんでした'],
      pageErrors: 2,
    }))).toEqual([
      'title(別の題, want=デリバリー受注)',
      'title-type(18px/700/27px, want=22px/700/32px)',
      'load-failure(error:注文を表示できませんでした)',
      'page-error(2)',
    ]);
  });

  test('reports a gate as a setting to fix, not as a broken screen', () => {
    // 門（`FeatureDisabledGate` / `StoreSelectionGate`）は中身をそのまま差し替える。
    // 題も失敗の1枚も出ないので、測るだけでは画面の作りと区別できない。
    expect(screenFailures(passingScreen({ title: null, observedType: null, gate: 'store-unselected' })))
      .toEqual(['gate(store-unselected)']);
    expect(screenFailures(passingScreen({ title: null, observedType: null, gate: 'store-checking' })))
      .toEqual(['gate(store-checking)']);
    // 門が出ているときは題と失敗の1枚を重ねない。例外と行き先は別に残す。
    expect(screenFailures(passingScreen({
      title: null, observedType: null, gate: 'feature-off',
      loadFailures: ['forbidden:表示する権限がありません'], pageErrors: 1,
    }))).toEqual(['gate(feature-off)', 'page-error(1)']);

    // 門ごとに、検証環境で次に整える設定が1つ出る。
    expect(nextStepForGate('feature-off')).toContain('飲食店の機能パック');
    expect(nextStepForGate('store-unselected')).toContain('/api/line-accounts');
    expect(nextStepForGate('store-checking')).toContain('店舗の確認中');
    expect(nextStepForGate('account-list')).toContain('CORS');
    expect(nextStepForGate('')).toContain('入口の門');

    // 門だけなら失敗として投げず、次の手が分かる形で止める。
    expect(script).toContain("reason.startsWith('gate(')");
    expect(script).toContain('blockedByGates = brokenScreens.map');
    expect(script).toContain('nextStep: nextStepForGate(');
    expect(script).toContain('temporarySessionDeleted: true');
    // 門と混ざっていなければ、これまでどおり失敗として投げる。
    expect(script).toContain('Staging delivery screens failed');
  });

  test('fails a screen that shows a load failure or throws, even when the title is right', () => {
    // 題が出ているだけでは合格にしない。
    expect(screenFailures(passingScreen())).toEqual([]);

    // 画面の中の「注文を表示できませんでした」。Node から読み口を呼べていても、
    // 画面からの取得が CORS や合言葉で落ちるとこの形になる。
    expect(screenFailures(passingScreen({
      loadFailures: ['error:注文を表示できませんでした'],
    }))).toEqual(['load-failure(error:注文を表示できませんでした)']);
    expect(screenFailures(passingScreen({
      view: 'history',
      title: '注文履歴・売上',
      expectedTitle: '注文履歴・売上',
      observedType: { ...TITLE_SUB },
      expectedType: { ...TITLE_SUB },
      loadFailures: ['error:注文履歴を表示できませんでした'],
    }))).toEqual(['load-failure(error:注文履歴を表示できませんでした)']);
    expect(screenFailures(passingScreen({
      view: 'sold-out',
      title: '品切れ一括設定',
      expectedTitle: '品切れ一括設定',
      observedType: { ...TITLE_SUB },
      expectedType: { ...TITLE_SUB },
      loadFailures: ['forbidden:表示する権限がありません'],
    }))).toEqual(['load-failure(forbidden:表示する権限がありません)']);

    // 未捕捉の例外も不合格。
    expect(screenFailures(passingScreen({ pageErrors: 1 }))).toEqual(['page-error(1)']);

    // もとから見ていた3つは引き続き不合格。
    expect(screenFailures(passingScreen({ landedOnLogin: true }))).toContain('login');
    expect(screenFailures(passingScreen({ crashed: true }))).toContain('crash');
    expect(screenFailures(passingScreen({ title: '別の題' }))[0]).toMatch(/^title\(/);

    // 合否は `screenFailures` だけで決める（題の判定へ戻らない）。
    expect(script).toContain('reasons: screenFailures(screen)');
    expect(script).toContain('reasons.length !== 0');
    expect(script).not.toContain('screen.landedOnLogin || screen.crashed || !screen.titlePasses');
    expect(script).toContain('Staging delivery screens failed');

    // 読む場所は本物の部品が必ず付ける印。3画面とも同じ部品で失敗を出す。
    expect(script).toContain('[data-list-state="error"], [data-list-state="forbidden"]');
    expect(listState).toContain('data-list-state="error"');
    expect(listState).toContain("const preset = kind === 'empty' ? EMPTY_PRESETS[emptyPreset] : PRESETS[kind]");
    expect(deliveryScreen).toContain('kind="error"');
    expect(historyScreen).toContain('kind="error"');
    expect(bulkScreen).toContain('kind="error"');
    // 例外は画面ごとに拾う。
    expect(script).toContain("page.on('pageerror'");
    expect(script).toContain('await page.evaluate<string[]>(READ_FAILURE_STATES_SOURCE)');
    // 失敗の控えには説明文をそのまま載せない（識別子が混じるため見出しだけ・40字で切る）。
    expect(script).toContain('.slice(0, 40)');
  });

  test('hands the browser plain strings, so the tsx transform cannot inject a helper', () => {
    // 検証環境の実行 38141457930 が `ReferenceError: __name is not defined` で
    // 落ちた原因と、その再発を止める縛り。`pnpm tsx` の esbuild は keepNames が
    // 入っているため、関数の中の「名前付きの」矢印や関数を `__name(...)` で包む。
    // Playwright は関数を本文の文字列にして送るので、ブラウザに無い `__name` を
    // 呼んで落ちる。文字列で渡せば変換の対象外になり、この失敗の形が消える。
    const payloads = {
      READ_TITLE_SOURCE, READ_FAILURE_STATES_SOURCE, READ_GATE_SOURCE, FONTS_READY_SOURCE,
    };
    for (const [name, source] of Object.entries(payloads)) {
      expect(source, name).not.toContain('__name');
      // keepNames が包むのは名前の付いた宣言。ブラウザへ渡す本文には作らない。
      expect(source, name).not.toMatch(/\bfunction\s+[A-Za-z_$]/);
      expect(source, name).not.toMatch(
        /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
      );
    }

    // 渡し方も文字列に固定する。関数参照へ戻すと同じ失敗がそのまま再発する。
    expect(script).toContain('await page.evaluate<boolean>(FONTS_READY_SOURCE)');
    expect(script).toContain('await page.evaluate<TitleInfo | null>(READ_TITLE_SOURCE)');
    expect(script).toContain('await page.evaluate<string[]>(READ_FAILURE_STATES_SOURCE)');
    expect(script).toContain('await page.evaluate<string | null>(READ_GATE_SOURCE)');
    expect(script).not.toMatch(/page\.evaluate\(\s*(?:\(|async\b|function\b|read[A-Za-z]*InPage)/);
    // 合言葉を渡す `addInitScript` だけは関数のまま（引数を渡す必要があり、
    // 呼び出しの引数に直接書いた無名の矢印は keepNames に包まれない）。
    expect(script).toMatch(/await page\.addInitScript\(\s*\(\[token, accountId\]\) => \{/);
  });

  // 実ブラウザ試験。Chromium を入れていない場所では飛ばす（必須CIの
  // `pnpm test:scripts` の工程はブラウザを入れていない）。
  (chromiumExecutable ? test : test.skip)(
    'runs the exact strings we ship inside a real Chromium',
    async () => {
      const { chromium } = await import('@playwright/test');
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await page.setContent(FIXTURE_HTML);

        // 配るものと同じ本文を、そのままブラウザへ渡して動くことを確かめる。
        expect(await page.evaluate<boolean>(FONTS_READY_SOURCE)).toBe(true);
        expect(await page.evaluate<TitleInfo | null>(READ_TITLE_SOURCE)).toEqual({
          text: 'デリバリー受注', size: '22px', weight: '700', lh: '32px',
        });
        // 見える失敗だけ・見出しだけを拾う（説明文と「まだありません」は数えない）。
        expect(await page.evaluate<string[]>(READ_FAILURE_STATES_SOURCE))
          .toEqual(['error:注文を表示できませんでした']);

        // 型の題が無い画面では、窓の見出しを題と取り違えない。
        await page.setContent('<main><div role="dialog"><h1 style="font-size:22px">窓の見出し</h1>'
          + '</div><h2 style="font-size:22px;font-weight:700;line-height:32px">品切れ一括設定</h2></main>');
        expect((await page.evaluate<TitleInfo | null>(READ_TITLE_SOURCE))?.text)
          .toBe('品切れ一括設定');

        // 門が出ていない画面では null。ここまでの雛形で誤検出しないことを先に見る。
        expect(await page.evaluate<string | null>(READ_GATE_SOURCE)).toBe(null);
        await page.setContent(FIXTURE_HTML);
        expect(await page.evaluate<string | null>(READ_GATE_SOURCE)).toBe(null);

        // 副題で描く2枚（板 OzHLO・h7OeT）は 18px/700/27px で読める。
        // 共通部品が頭の中へ流す `--tpl-title-size` をそのまま再現する。
        await page.setContent(`<main><div data-template-region="heading"
          style="--tpl-title-size:18px;--tpl-title-lh:27px">
          <h1 style="font-size:var(--tpl-title-size);font-weight:700;line-height:var(--tpl-title-lh)">
          注文履歴・売上</h1></div></main>`);
        expect(await page.evaluate<TitleInfo | null>(READ_TITLE_SOURCE)).toEqual({
          text: '注文履歴・売上', size: '18px', weight: '700', lh: '27px',
        });

        // 入口の門4つ。題が出ないのに失敗の1枚も出ない状態を、門として見分ける。
        await page.setContent('<main><div data-feature-disabled="restaurant">'
          + '<h2>この機能はご契約に含まれていません</h2></div></main>');
        expect(await page.evaluate<string | null>(READ_GATE_SOURCE)).toBe('feature-off');

        await page.setContent('<main><div data-page-pending="store"'
          + ' style="height:64px"><div style="height:32px"></div></div></main>');
        expect(await page.evaluate<string | null>(READ_GATE_SOURCE)).toBe('store-checking');

        // 本物の `StoreSelectionGate` と同じ形（`data-design="Empty"` の中の題）。
        await page.setContent('<main><section data-design="Empty">'
          + '<h1>店舗が選ばれていません</h1><p>この画面は店舗ごとのデータを扱います。</p>'
          + '</section></main>');
        expect(await page.evaluate<string | null>(READ_GATE_SOURCE)).toBe('store-unselected');

        await page.setContent('<main><div data-list-state="error" role="alert">'
          + '<h3>アカウント一覧を読み込めませんでした</h3></div></main>');
        expect(await page.evaluate<string | null>(READ_GATE_SOURCE)).toBe('account-list');
        // 画面側の失敗（注文が読めない）は門にしない。こちらは load-failure のまま。
        await page.setContent('<main><div data-list-state="error" role="alert">'
          + '<h3>注文を表示できませんでした</h3></div></main>');
        expect(await page.evaluate<string | null>(READ_GATE_SOURCE)).toBe(null);
        expect(await page.evaluate<string[]>(READ_FAILURE_STATES_SOURCE))
          .toEqual(['error:注文を表示できませんでした']);
        // 見えない門は数えない（開いていない引き出しの中など）。
        await page.setContent('<main><section data-design="Empty" style="visibility:hidden">'
          + '<h1>店舗が選ばれていません</h1></section></main>');
        expect(await page.evaluate<string | null>(READ_GATE_SOURCE)).toBe(null);

        // 再発の検出：変換ヘルパーが混ざった本文は、実ブラウザでこう落ちる。
        // 上の3つが通りこれが落ちることで、「文字列で渡す」が効いている証になる。
        await expect(page.evaluate<boolean>(
          "(() => { const visible = /* @__PURE__ */ __name((el) => !!el, 'visible'); return visible(document.body) })()",
        )).rejects.toThrow('__name is not defined');
      } finally {
        await browser.close();
      }
    },
    120_000,
  );

  test('reports a next step instead of a bare failure when an entry gate is empty', () => {
    expect(nextStepFor(openGates({ restaurantTestEnabled: false })))
      .toContain('RESTAURANT_TEST_ENABLED');
    expect(nextStepFor(openGates({ activeAdmins: 0 }))).toContain('owner/admin');
    expect(nextStepFor(openGates({ activeLineAccounts: 0 }))).toContain('LINE公式アカウント');
    expect(nextStepFor(openGates({ tenantsWithRestaurantPack: 0 }))).toContain('feature_packs');
    expect(nextStepFor(openGates({ storesLinkedToLineAccount: 0 }))).toContain('rt_stores.line_account_id');
    // すべて埋まっていれば、残るのは担当者の可視範囲。
    expect(nextStepFor(openGates())).toContain('account_scope');

    expect(script).toContain("status: 'blocked'");
    expect(script).toContain('nextStep: nextStepFor(gates)');
    expect(script).toContain('temporarySessionCreated: false');

    // 本物と同じ3つの 404 の門（試験スイッチ・機能パック・店舗の紐付け）を見ている。
    expect(script).toContain('feature_packs LIKE \'%"restaurant"%\'');
    expect(script).toContain('JOIN rt_stores s ON s.line_account_id = la.id');
  });
});
