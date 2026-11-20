import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { app } from '../index.js';
import { routeClassification } from '../middleware/feature-enforcement.js';
import { ALLOWLIST } from './openapi-coverage-allowlist.js';
import { BASELINE_DOCUMENTED } from './openapi-coverage-baseline.js';

/**
 * OpenAPI（GET /openapi.json）と実装の同期ゲート。
 *
 * 目的: 仕様書だけ置き去りになる状態を防ぐ。route を足したのに OpenAPI へ
 * 記載も allowlist 登録もしていないと落ちる。API の実動作は変えない。
 *
 * 対象: `/api/*` と `/webhook`、認証なし公開メタデータ 2 件
 * （GET /admin/version、GET /admin/manifest）。
 * 対象外とその理由:
 * - `/api/restaurant-test/*`（休業・貸切と席の空きの口以外） … 飲食店向け機能（`RESTAURANT_TEST_ENABLED` で環境ごとに切替）
 * - `/api/internal/*` … 内部サービス間経路（内部専用口）
 * - `/admin/update/*` … 管理キー必須の内部保守口
 * - `ALL` メソッド … ミドルウェア掛け（同じ path の具体メソッドが別にある）
 * - `OPTIONS`、`/*`、`/api/*` … プリフライトと全体ミドルウェア
 * - `/openapi.json`、`/docs` … 仕様書そのもの
 * - `/auth/*`、`/book`、`/setup`、`/t/*`、`/r/*` などのページ・転送 … 公開APIではない
 *
 * 運用: 新しい route を足したら OpenAPI（openapi.ts）へ記載する。
 * ALLOWLIST への追加は原則禁止。新 route は OpenAPI 記載が必要。
 * 後続票で記載を増やしたら ALLOWLIST から消し、ALLOWLIST_MAX と
 * BASELINE_DOCUMENTED の基準も同じ PR で更新する。
 * version は repo の package.json と一致させる（自動取得ではなく検査で同期）。
 * request/response の中身までは見ない。本文の parity は順次対応。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const ROOT_VERSION: string = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;

const HONO_PARAM_PATTERN = /:([A-Za-z0-9_]+)/g;
const toOpenApiPath = (honoPath: string): string => honoPath.replace(HONO_PARAM_PATTERN, '{$1}');

const INFRASTRUCTURE_PATHS = new Set(['/*', '/api/*', '/openapi.json', '/docs']);

function isCoveredRoute(method: string, path: string): boolean {
  if (method === 'ALL' || method === 'OPTIONS') return false;
  if (INFRASTRUCTURE_PATHS.has(path)) return false;
  if (path.startsWith('/api/restaurant-test') && ![
    '/api/restaurant-test/menus/:id/payment',
    '/api/restaurant-test/assignment-settings',
    '/api/restaurant-test/table-auto-assignment-settings',
    '/api/restaurant-test/store-groups', '/api/restaurant-test/store-groups/:id/members/:storeId', '/api/restaurant-test/stores/:id/referral-location',
    '/api/restaurant-test/closures', '/api/restaurant-test/closures/preview', '/api/restaurant-test/closures/:id',
    '/api/restaurant-test/availability', '/api/restaurant-test/google/hours/from-closure',
    '/api/restaurant-test/closures/:id/contact-status', '/api/restaurant-test/close-notification-settings',
    '/api/restaurant-test/opening-hours', '/api/restaurant-test/reservation-link',
    '/api/restaurant-test/followups/:storeId',
    '/api/restaurant-test/followups/:storeId/steps/:stepId/messages',
    '/api/restaurant-test/followups/:storeId/review-history',
    '/api/restaurant-test/followups/:storeId/bindings/:stepId',
    '/api/restaurant-test/followups/:storeId/request-start',
    '/api/restaurant-test/followups/:storeId/stop',
    '/api/restaurant-test/reservations/:id',
    '/api/restaurant-test/reservations/:id/confirmations',
    '/api/restaurant-test/channel-close-tasks',
    '/api/restaurant-test/channel-close-tasks/:id/opened',
    '/api/restaurant-test/google/reviews/:id/draft/generate',

  ].includes(path)) return false;
  if (path.startsWith('/api/internal')) return false;
  if (path.startsWith('/admin/update')) return false;
  return (
    path.startsWith('/api/') ||
    path === '/webhook' ||
    path === '/admin/version' ||
    path === '/admin/manifest'
  );
}

type InventoryEntry = { key: string; method: string; openApiPath: string; honoPath: string };

function mountedInventory(): Map<string, InventoryEntry> {
  const inventory = new Map<string, InventoryEntry>();
  for (const route of app.routes) {
    if (!isCoveredRoute(route.method, route.path)) continue;
    const openApiPath = toOpenApiPath(route.path);
    const key = `${route.method} ${openApiPath}`;
    if (!inventory.has(key)) {
      inventory.set(key, { key, method: route.method, openApiPath, honoPath: route.path });
    }
  }
  return inventory;
}

type Operation = {
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  responses?: Record<string, { description?: string }>;
  security?: Array<Record<string, unknown>>;
};

type OpenApiSpec = {
  openapi: string;
  info: { title: string; version: string; description?: string };
  security?: Array<Record<string, unknown>>;
  paths: Record<string, Record<string, Operation>>;
  components?: { securitySchemes?: Record<string, unknown>; schemas?: Record<string, unknown> };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [extra: string]: any;
};

async function loadSpec(): Promise<OpenApiSpec> {
  const res = await app.request('/openapi.json');
  expect(res.status).toBe(200);
  return (await res.json()) as OpenApiSpec;
}

const OPERATION_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

function documentedKeys(spec: OpenApiSpec): Map<string, { method: string; path: string }> {
  const keys = new Map<string, { method: string; path: string }>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(item ?? {})) {
      if (!OPERATION_METHODS.has(method) || operation == null) continue;
      keys.set(`${method.toUpperCase()} ${path}`, { method: method.toUpperCase(), path });
    }
  }
  return keys;
}

function formatKeys(keys: string[]): string {
  const shown = keys.slice(0, 30).join('\n  ');
  return keys.length > 30 ? `  ${shown}\n  ほか ${keys.length - 30} 件` : `  ${shown}`;
}

/** 未記載負債はこの件数より増やせない。 */
const ALLOWLIST_MAX = 769;



describe('OpenAPIと公開APIの同期', () => {
  test('versionはrepoのpackage.jsonと一致する', async () => {
    const spec = await loadSpec();
    expect(
      spec.info.version,
      `openapi.ts の version を ${ROOT_VERSION} に上げてください`,
    ).toBe(ROOT_VERSION);
  });

  test('仕様書の基本構造が壊れていない', async () => {
    const spec = await loadSpec();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title.length).toBeGreaterThan(0);
    expect(typeof spec.paths).toBe('object');
    expect(spec.components?.securitySchemes?.bearerAuth).toBeDefined();
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
  });

  test('公開APIは記載済みかallowlistのどちらかに入っている', async () => {
    const spec = await loadSpec();
    const documented = documentedKeys(spec);
    const missing = [...mountedInventory().keys()]
      .filter((key) => !documented.has(key) && !ALLOWLIST.has(key))
      .sort();
    expect(
      missing,
      `OpenAPI未記載の公開APIが ${missing.length} 件あります:\n${formatKeys(missing)}\n` +
        'openapi.ts へ記載するか、ALLOWLIST へ理由付きで登録してください。',
    ).toEqual([]);
  });

  test('記載済みだが実装に無いpathは無い（陳腐化の検出）', async () => {
    const spec = await loadSpec();
    const documented = documentedKeys(spec);
    const inventory = mountedInventory();
    const orphans = [...documented.keys()].filter((key) => !inventory.has(key)).sort();
    expect(
      orphans,
      `実装に無い記載が ${orphans.length} 件あります:\n${formatKeys(orphans)}\n` +
        'route が消えたなら openapi.ts からも消してください。',
    ).toEqual([]);
  });

  test('記載済み・廃止済みはALLOWLISTに残っていない', async () => {
    const spec = await loadSpec();
    const documented = documentedKeys(spec);
    const inventory = mountedInventory();
    const stale = [...ALLOWLIST].filter((key) => documented.has(key) || !inventory.has(key)).sort();
    expect(
      stale,
      `ALLOWLISTのうち ${stale.length} 件は記載済みか廃止済みです:\n${formatKeys(stale)}\n` +
        'ALLOWLISTから消してください。残っていると次の追加漏れを見逃します。',
    ).toEqual([]);
  });

  test('記載済みoperation数は基準一覧の件数以上（後退禁止）', async () => {
    const spec = await loadSpec();
    const count = documentedKeys(spec).size;
    expect(
      count >= BASELINE_DOCUMENTED.size,
      `記載済みが ${count} 件で基準 ${BASELINE_DOCUMENTED.size} 件を下回っています。` +
        '既存仕様を消す・ALLOWLISTへ移す変更は禁止です。後続票で記載を増やした場合は基準一覧を同じPRで更新してください。',
    ).toBe(true);
  });

  test('暫定allowlistは基準件数以下（増加禁止）', async () => {
    expect(
      ALLOWLIST.size <= ALLOWLIST_MAX,
      `ALLOWLISTが ${ALLOWLIST.size} 件で基準 ${ALLOWLIST_MAX} 件を超えています。` +
        'ALLOWLISTへの追加は原則禁止です。新routeはopenapi.tsへ記載してください。',
    ).toBe(true);
  });

  test('基準一覧と記載済みoperationが一致する（移し替え・更新漏れ検出）', async () => {
    const spec = await loadSpec();
    const documented = documentedKeys(spec);
    const lost = [...BASELINE_DOCUMENTED].filter((key) => !documented.has(key)).sort();
    const untracked = [...documented.keys()].filter((key) => !BASELINE_DOCUMENTED.has(key)).sort();
    expect(
      { lost, untracked },
      `基準から消えた記載が ${lost.length} 件、基準へ未登録の記載が ${untracked.length} 件あります。\n` +
        `消えた記載:\n${formatKeys(lost)}\n未登録の記載:\n${formatKeys(untracked)}\n` +
        'OpenAPIと基準一覧は同じPRで更新してください。',
    ).toEqual({ lost: [], untracked: [] });
  });

  test('path parameterは名前まで実装と一致して宣言されている', async () => {
    const spec = await loadSpec();
    const problems: string[] = [];
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      const expected = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      for (const [method, operation] of Object.entries(item ?? {})) {
        if (!OPERATION_METHODS.has(method) || operation == null) continue;
        const declared = (operation.parameters ?? []).filter((p) => p.in === 'path');
        for (const name of expected) {
          const hit = declared.find((p) => p.name === name);
          if (!hit) problems.push(`${method.toUpperCase()} ${path}: {${name}} の宣言が無い`);
          else if (hit.required !== true) problems.push(`${method.toUpperCase()} ${path}: {${name}} に required: true が無い`);
        }
        for (const p of declared) {
          if (!expected.includes(p.name)) problems.push(`${method.toUpperCase()} ${path}: path に無い {${p.name}} を宣言している`);
        }
      }
    }
    expect(problems, `path parameterの不一致が ${problems.length} 件あります:\n${formatKeys(problems)}`).toEqual([]);
  });

  test('pathの重複・名前違いの衝突が無い', async () => {
    const spec = await loadSpec();
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const path of Object.keys(spec.paths ?? {})) {
      // 名前を消した形（/api/friends/{}/tags）で衝突を見つける
      const shape = path.replace(/\{[^}]+\}/g, '{}');
      const prev = seen.get(shape);
      if (prev !== undefined && prev !== path) collisions.push(`${prev} と ${path}`);
      else seen.set(shape, path);
    }
    expect(collisions, `pathの衝突が ${collisions.length} 件あります:\n${formatKeys(collisions)}`).toEqual([]);
  });

  test('認証の表示が実装と一致する（公開口だけsecurity空）', async () => {
    const spec = await loadSpec();
    const inventory = mountedInventory();
    const problems: string[] = [];
    for (const [key, { method, path }] of documentedKeys(spec)) {
      const entry = inventory.get(key);
      // 実装に無い記載は陳腐化テストが落とすので、ここでは飛ばす
      if (!entry) continue;
      const classification = routeClassification(entry.honoPath, method);
      const operation = spec.paths[path]?.[method.toLowerCase() as 'get'];
      // LIFF ハンドラ自身が、対象アカウントの LINE ID トークンを検証する。
      const verifiedLiff = ['/api/liff/booking/monthly-contracts','/api/liff/files/:id/download',"/api/liff/booking/cost-estimate","/api/liff/booking/group-availability","/api/liff/booking/pass-purchases/:id","/api/liff/booking/series/preview","/api/liff/member-card","/api/liff/booking/pass-plans/:id/checkout","/api/liff/forms/:id/routing/resolve","/api/liff/events/bookings/:id/absence","/api/liff/events/makeup-credits","/api/liff/events/makeup-credits/:id/options","/api/liff/events/makeup-credits/:id/use","/api/liff/booking/cancellation-quote","/api/liff/booking/setup-intent",'/api/liff/notification-preferences', '/api/liff/notification-preferences/:purpose', '/api/liff/restaurant/courses', '/api/liff/restaurant/referrals', '/api/liff/restaurant/form-booking'].includes(entry.honoPath);
      if (verifiedLiff) {
        if (JSON.stringify(operation?.security) !== '[{"liffIdToken":[]}]') problems.push(`${key}: LINE IDトークンの表示が無い`);
      } else if (classification?.kind === 'public') {
        if (JSON.stringify(operation?.security ?? null) !== '[]') {
          problems.push(`${key}: 認証なし公開口なのに security: [] が無い`);
        }
      } else if (operation?.security !== undefined && operation.security.length === 0) {
        problems.push(`${key}: 認証が必要なのに security: [] になっている`);
      }
    }
    expect(problems, `認証表示の不一致が ${problems.length} 件あります:\n${formatKeys(problems)}`).toEqual([]);
  });

  test('主要responseの形がある（2xxと説明文）', async () => {
    const spec = await loadSpec();
    const problems: string[] = [];
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
      for (const [method, operation] of Object.entries(item ?? {})) {
        if (!OPERATION_METHODS.has(method) || operation == null) continue;
        const key = `${method.toUpperCase()} ${path}`;
        const responses = operation.responses ?? {};
        const codes = Object.keys(responses);
        if (codes.length === 0) {
          problems.push(`${key}: responses が空`);
          continue;
        }
        if (!codes.some((code) => code.startsWith('2') || code === 'default')) {
          problems.push(`${key}: 成功時（2xx）の response が無い`);
        }
        for (const code of codes) {
          if (!responses[code]?.description) problems.push(`${key} [${code}]: description が無い`);
        }
      }
    }
    expect(problems, `responseの不足が ${problems.length} 件あります:\n${formatKeys(problems)}`).toEqual([]);
  });

  test('予約設備PATCHは版に加えて変更項目を1つ以上要求する', async () => {
    const spec = await loadSpec();
    const operation = spec.paths['/api/booking/admin/resources/{id}']?.patch as {
      requestBody?: { content?: { 'application/json'?: { schema?: {
        required?: string[];
        anyOf?: Array<{ required?: string[] }>;
      } } } };
    } | undefined;
    const schema = operation?.requestBody?.content?.['application/json']?.schema;
    expect(schema?.required).toEqual(['expectedVersion']);
    expect(schema?.anyOf).toEqual([
      { required: ['name'] },
      { required: ['type'] },
      { required: ['capacity'] },
      { required: ['isActive'] },
    ]);
  });

  test('$refの指す先がすべて存在する', async () => {
    const spec = await loadSpec();
    const broken: string[] = [];
    const resolve = (pointer: string): unknown => {
      if (!pointer.startsWith('#/')) return 'external';
      let node: unknown = spec;
      for (const raw of pointer.slice(2).split('/')) {
        // JSON Pointer (RFC 6901) のエスケープを戻す
        const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
        if (typeof node !== 'object' || node === null || !(segment in node)) return undefined;
        node = (node as Record<string, unknown>)[segment];
      }
      return node;
    };
    const walk = (node: unknown, at: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => walk(item, `${at}[${index}]`));
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      for (const [k, v] of Object.entries(node)) {
        if (k === '$ref' && typeof v === 'string') {
          if (resolve(v) === undefined) broken.push(`${at}: ${v}`);
        } else walk(v, `${at}.${k}`);
      }
    };
    walk(spec, '$');
    expect(broken, `参照切れが ${broken.length} 件あります:\n${formatKeys(broken)}`).toEqual([]);
  });
});
