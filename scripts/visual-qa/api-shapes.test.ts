/*
 * 画面確認モックが「配列で返る口」を取り違えていないかの試験。
 *
 * ここを取り違えると、**画面が真っ白になる**。一覧の口が
 * `{items:[],total:0}` に落ちれば `xxx.filter is not a function`、
 * 1件返す口が `[]` に落ちれば `undefined.toLocaleString()` になる。
 * どちらも実際に起きた（2026-08-26）。
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { readArrayGetPaths } from './api-shapes.mjs';
// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { IDENTITY_CANDIDATE_DETECTION, IDENTITY_CANDIDATE_EC, IDENTITY_CANDIDATE_ERROR, IDENTITY_CANDIDATE_FRIEND, IDENTITY_CANDIDATE_LISTS } from './fixtures.mjs';
// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { MERGED_PERSON_DETAIL, MERGED_PERSON_EMPTY, MERGED_PERSON_ERROR } from './fixtures.mjs';
// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { DUPLICATE_STATS, USERS_GROUPED } from './fixtures.mjs';
// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { AUTOMATIONS, AUTOMATION_TEMPLATES, COMMON_ACTION_DETAIL, COMMON_ACTIONS } from './fixtures.mjs';
// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { CONVERSION_POINTS, CONVERSION_REPORT_CURRENT, CONVERSION_REPORT_PREVIOUS } from './fixtures.mjs';
// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { MEDIA_DELETE_IMPACT, MEDIA_FOLDERS, MEDIA_ITEMS } from './fixtures.mjs';
// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { BROADCAST_LIST_META, TEMPLATES } from './fixtures.mjs';
// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { NEN_CAMPAIGN_SETTINGS, NEN_COLUMNS, NEN_PETS, NEN_JOBS, NEN_FLOW_METRICS, NEN_COLUMN_METRICS, NEN_PET_METRICS, NEN_DELIVERIES, NEN_DELIVERY_DETAILS } from './fixtures.mjs';
// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { COMMON_VAR_DETAIL, COMMON_VAR_REPLACEMENT_CANDIDATES, COMMON_VAR_REPLACEMENT_PREVIEW, COMMON_VAR_REPLACEMENT_RESULT } from './fixtures.mjs';
// @ts-expect-error 画面確認用のスクリプトは素のJS。型定義は持たない。
import { WEBINAR_FOLDERS } from './fixtures.mjs';

describe('画面確認モックの口の形', () => {
  const paths: Set<string> = readArrayGetPaths();

  it('一覧が配列で返る口を拾い、共通一覧契約の口は配列扱いしない', () => {
    for (const path of ['/api/tags', '/api/tag-groups', '/api/chats', '/api/broadcasts', '/api/automations']) {
      expect(paths.has(path), `${path} を配列の口として拾えていない`).toBe(true);
    }
    expect(paths.has('/api/scenarios'), '/api/scenarios を共通一覧契約ではなく配列として拾っている').toBe(false);
    expect(paths.has('/api/rich-menu-groups'), '/api/rich-menu-groups を共通一覧契約ではなく配列として拾っている').toBe(false);
  });

  it('頁形式へ移した口は配列の既定器に落とさない', () => {
    /*
      `/api/webinars` は頁形式(`{items,total,limit,sort}`)へ移したので、
      配列の口としては拾わない。代わりにモック内の専用処理が同じ器を返す。
      配列のまま拾うと、頁の器が既定の `{items:[],total:0}` で潰れて
      **画面が丸ごと「画面を表示できませんでした」になる。**
    */
    expect(paths.has('/api/webinars'), '/api/webinars を配列の口として拾ってしまっている').toBe(false);
  });

  it('交差型で書かれた一覧の口も拾う', () => {
    /*
      `fetchApi<ApiResponse<EcCommerceEvent[]> & { pagination: … }>` は
      型の末尾が `}` なので `^ApiResponse<…>$` に当たらず、この1件だけ
      黙って抜けていた。抜けると `{items:[],total:0}` が返り、`/ec-commerce`
      が描画の途中で `events.map is not a function` を投げて、本文が丸ごと
      「画面を表示できませんでした」に置き換わる。**撮ると空の絵になる。**
    */
    expect(paths.has('/api/ec-commerce/events'), '交差型の口を配列として拾えていない').toBe(true);
  });

  it('1件だけ返す口を配列にしない', () => {
    // `/api/friends` は `PaginatedResponse`。配列にすると友だち一覧が落ちる。
    // `/api/friends/${id}/site-events` が `/api/friends` に化けて起きた。
    for (const path of ['/api/friends', '/api/dashboard/overview', '/api/list-stats', '/api/settings/features']) {
      expect(paths.has(path), `${path} を配列の口として拾ってしまっている`).toBe(false);
    }
  });

  it('読み取りが壊れたら黙って空にせず止める', () => {
    // 静かに0件になると、全部の口が `{items:[],total:0}` に落ちて
    // 全画面が真っ白になる。原因はどこにも出ない。
    expect(() => readArrayGetPaths('// api.ts が読めなかった場合')).toThrow(/配列の口/);
  });
});

describe('ウェビナーフォルダの画面確認データ', () => {
  it('選択中アカウントと件数を持つ', () => {
    expect(WEBINAR_FOLDERS).toHaveLength(3);
    for (const folder of WEBINAR_FOLDERS) {
      expect(folder).toMatchObject({
        kind: 'webinar', accountId: 'visual-qa-account', count: expect.any(Number),
      });
    }
  });
});

describe('オートメーションの画面確認データ', () => {
  it('V8 の板（LWQXd）と同じ稼働5本・停止1本・見本12件を返す', () => {
    expect(AUTOMATIONS.filter((item: { isActive: boolean }) => item.isActive)).toHaveLength(5);
    expect(AUTOMATIONS.filter((item: { isActive: boolean }) => !item.isActive)).toHaveLength(1);
    expect(AUTOMATION_TEMPLATES).toHaveLength(12);
  });

  it('一覧の30日実績を設計と同じ合計で返す', () => {
    expect(AUTOMATIONS.reduce((sum: number, item: { executionCount30d: number }) => sum + item.executionCount30d, 0)).toBe(2_988);
    expect(AUTOMATIONS.reduce((sum: number, item: { failureCount30d: number }) => sum + item.failureCount30d, 0)).toBe(6);
    expect(AUTOMATIONS.filter((item: { executionCount30d: number }) => item.executionCount30d === 0)).toHaveLength(1);
  });

  it('共通アクションの件数・呼び出し元・今月実績を V8 の板（LnGNw）と同じ合計で返す', () => {
    expect(COMMON_ACTIONS).toHaveLength(8);
    expect(COMMON_ACTIONS.filter((item: { status: string }) => item.status === 'published')).toHaveLength(5);
    expect(COMMON_ACTIONS.filter((item: { status: string }) => item.status === 'draft')).toHaveLength(1);
    expect(COMMON_ACTIONS.filter((item: { status: string }) => item.status === 'archived')).toHaveLength(2);
    expect(COMMON_ACTIONS.reduce((sum: number, item: { bindingCount: number }) => sum + item.bindingCount, 0)).toBe(12);
    expect(COMMON_ACTIONS.reduce((sum: number, item: { executionCountThisMonth: number }) => sum + item.executionCountThisMonth, 0)).toBe(3_210);
    expect(COMMON_ACTIONS.reduce((sum: number, item: { failureCountThisMonth: number }) => sum + item.failureCountThisMonth, 0)).toBe(2);
  });

  it('共通アクションの公開4版と5つの利用先を同じ契約で返す', () => {
    expect(COMMON_ACTION_DETAIL.currentPublishedVersionId).toBe('cav-4');
    expect(COMMON_ACTION_DETAIL.versions).toHaveLength(4);
    expect(COMMON_ACTION_DETAIL.bindings).toHaveLength(5);
    expect(COMMON_ACTION_DETAIL.bindings.filter((item: { hasNewerVersion: boolean }) => item.hasNewerVersion)).toHaveLength(1);
  });
});

describe('NEN配信の新しい集計・履歴契約', () => {
  it('既存の配信・コラム・ペットと同じIDで集計を返す', () => {
    expect(NEN_FLOW_METRICS.flows.map((item: { campaignKey: string }) => item.campaignKey))
      .toEqual(NEN_CAMPAIGN_SETTINGS.map((item: { campaignKey: string }) => item.campaignKey));
    expect(NEN_COLUMN_METRICS.columns.map((item: { id: string }) => item.id))
      .toEqual(NEN_COLUMNS.map((item: { id: string }) => item.id));
    expect(NEN_PET_METRICS.pets.map((item: { id: string }) => item.id))
      .toEqual(NEN_PETS.map((item: { id: string }) => item.id));
  });

  it('range・summary・ページ情報と配信詳細を実契約の形で持つ', () => {
    expect(NEN_FLOW_METRICS).toMatchObject({
      range: { days: 30 },
      summary: { active: 6, paused: 2, planned: 2640, sent: 2486 },
    });
    expect(NEN_PET_METRICS).toMatchObject({
      summary: { pets: 864, birthdayMissing: 42, friendsWithoutPet: 420 },
    });
    expect(NEN_DELIVERIES).toMatchObject({
      summary: { pending: 148, sent: 2486, failed: 6, retryRequired: 0 },
      pagination: { total: 2640, limit: 20, cursor: '0', nextCursor: '20' },
    });
    expect(NEN_DELIVERIES.deliveries.map((item: { id: string }) => item.id))
      .toEqual(NEN_JOBS.map((item: { id: string }) => item.id));
    for (const job of NEN_JOBS as Array<{ id: string }>) {
      expect(NEN_DELIVERY_DETAILS[job.id]).toMatchObject({ id: job.id, version: 1 });
    }
  });

  it('集計値と固定行の合計が食い違わない', () => {
    const flowTotals = NEN_FLOW_METRICS.flows.reduce(
      (sum: { planned: number; sent: number; conversions: number }, item: { planned: number; sent: number; associatedConversions: number }) => ({
        planned: sum.planned + item.planned,
        sent: sum.sent + item.sent,
        conversions: sum.conversions + item.associatedConversions,
      }),
      { planned: 0, sent: 0, conversions: 0 },
    );
    expect(flowTotals).toEqual({ planned: 2640, sent: 2486, conversions: 142 });
    const unread = NEN_COLUMN_METRICS.columns.reduce(
      (sum: number, item: { unread: number | null }) => sum + (item.unread ?? 0),
      0,
    );
    expect(unread).toBe(NEN_COLUMN_METRICS.summary.unread);
  });
});

describe('テンプレートの画面確認データ', () => {
  it('全行に今月と累計の送信数があり、設計の先頭行を再現する', () => {
    expect(TEMPLATES).toHaveLength(26);
    expect(TEMPLATES[0]).toMatchObject({ monthlySendCount: 1240, totalSendCount: 18300 });
    for (const template of TEMPLATES) {
      expect(template.monthlySendCount).toBeGreaterThanOrEqual(0);
      expect(template.totalSendCount).toBeGreaterThanOrEqual(template.monthlySendCount);
    }
  });
});

describe('一斉配信一覧の画面確認データ', () => {
  it('開封率を割合ではなくAPI契約どおりのパーセント値で返す', () => {
    expect(BROADCAST_LIST_META.kpis.openRate).toBe(69.4);
  });
});

describe('共通情報の詳細・差し替え契約', () => {
  it('詳細はメモ・版・使用先・変更履歴を同じ対象で返す', () => {
    expect(COMMON_VAR_DETAIL).toMatchObject({
      id: 'common-var-delete-target',
      memo: expect.any(String),
      version: 3,
      usageCount: 15,
      usageByKind: { template: 12, form: 3 },
      usagePage: { total: 15, shown: 6, hasMore: true, unavailableCount: 0 },
    });
    expect(COMMON_VAR_DETAIL.usages).toHaveLength(COMMON_VAR_DETAIL.usagePage.shown);
    expect(COMMON_VAR_DETAIL.history[0]).toMatchObject({ version: 3, changeReason: expect.any(String) });
  });

  it('候補・影響・実行完了でIDと件数が食い違わない', () => {
    expect(COMMON_VAR_REPLACEMENT_CANDIDATES.source).toMatchObject({
      id: COMMON_VAR_DETAIL.id,
      version: COMMON_VAR_DETAIL.version,
    });
    expect(COMMON_VAR_REPLACEMENT_PREVIEW).toMatchObject({
      source: { id: COMMON_VAR_DETAIL.id },
      replacement: { id: COMMON_VAR_REPLACEMENT_CANDIDATES.candidates[0].id },
      usageTotal: COMMON_VAR_DETAIL.usageCount,
      replaceableTotal: COMMON_VAR_DETAIL.usageCount,
      blockedTotal: 0,
      canReplace: true,
    });
    expect(COMMON_VAR_REPLACEMENT_PREVIEW.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(COMMON_VAR_REPLACEMENT_RESULT).toMatchObject({
      sourceId: COMMON_VAR_DETAIL.id,
      replacementId: COMMON_VAR_REPLACEMENT_PREVIEW.replacement.id,
      replacedUsageCount: COMMON_VAR_REPLACEMENT_PREVIEW.replaceableTotal,
      remainingUsageCount: 0,
      verification: 'verified',
    });
  });
});

describe('成果地点の画面確認データ', () => {
  it('一覧と現期間・前期間の集計が同じ成果地点を使う', () => {
    const pointIds = CONVERSION_POINTS.map((point: { id: string }) => point.id);
    expect(CONVERSION_REPORT_CURRENT.map((row: { conversionPointId: string }) => row.conversionPointId)).toEqual(pointIds);
    expect(CONVERSION_REPORT_PREVIOUS.map((row: { conversionPointId: string }) => row.conversionPointId)).toEqual(pointIds);
  });

  it('設計比較に使う件数と金額を固定する', () => {
    const total = (rows: Array<{ totalCount: number; totalValue: number }>) => rows.reduce(
      (sum, row) => ({ count: sum.count + row.totalCount, value: sum.value + row.totalValue }),
      { count: 0, value: 0 },
    );
    expect(total(CONVERSION_REPORT_CURRENT)).toEqual({ count: 148, value: 466000 });
    expect(total(CONVERSION_REPORT_PREVIOUS)).toEqual({ count: 127, value: 435000 });
  });

  it('新規作成の購入欄に、注文確定の既存実績を表示できる', () => {
    const purchase = CONVERSION_POINTS.find((point: { eventType: string }) => (
      point.eventType === 'ec_order_confirmed'
    ));
    const report = CONVERSION_REPORT_CURRENT.find((row: { conversionPointId: string }) => (
      row.conversionPointId === purchase?.id
    ));
    expect(report).toMatchObject({ totalCount: 52, totalValue: 412000 });
  });
});

describe('登録メディアの画面確認データ', () => {
  it('設計比較に必要なフォルダ・通常一覧・使用先を空にしない', () => {
    expect(MEDIA_FOLDERS.map((folder: { name: string }) => folder.name)).toEqual([
      '01_商品写真', '02_バナー', '03_動画',
    ]);
    expect(MEDIA_ITEMS.filter((item: { archivedAt?: string | null }) => item.archivedAt == null)).toHaveLength(186);
    expect(MEDIA_ITEMS.filter((item: { folderId: string | null, archivedAt?: string | null }) => item.archivedAt == null && item.folderId === 'media-product')).toHaveLength(64);
    expect(MEDIA_ITEMS.filter((item: { folderId: string | null, archivedAt?: string | null }) => item.archivedAt == null && item.folderId === 'media-banner')).toHaveLength(38);
    expect(MEDIA_ITEMS.filter((item: { folderId: string | null, archivedAt?: string | null }) => item.archivedAt == null && item.folderId === 'media-video')).toHaveLength(12);
    expect(MEDIA_ITEMS.filter((item: { folderId: string | null, archivedAt?: string | null }) => item.archivedAt == null && item.folderId === null)).toHaveLength(72);
    expect(MEDIA_ITEMS.filter((item: { kind: string, archivedAt?: string | null }) => item.archivedAt == null && item.kind === 'file')).toHaveLength(32);
    expect(MEDIA_DELETE_IMPACT).toMatchObject({ usageCount: 3, canDelete: false });
    expect(MEDIA_DELETE_IMPACT.references).toHaveLength(3);
  });

  it('撮影データでも実装の登録上限を超えない', () => {
    const limits: Record<string, number> = {
      image: 10 * 1024 * 1024,
      audio: 30 * 1024 * 1024,
      video: 90 * 1024 * 1024,
      file: 20 * 1024 * 1024,
    };
    for (const item of MEDIA_ITEMS as Array<{ filename: string; kind: string; sizeBytes: number }>) {
      expect(item.sizeBytes, item.filename).toBeLessThanOrEqual(limits[item.kind]);
    }
  });
});

describe('本人照合候補の画面確認データ', () => {
  it('友だち同士とEC会員を同じ契約で返す', () => {
    expect(Object.keys(IDENTITY_CANDIDATE_FRIEND).sort())
      .toEqual(Object.keys(IDENTITY_CANDIDATE_EC).sort());
    expect(IDENTITY_CANDIDATE_FRIEND.kind).toBe('friend_duplicate');
    expect(IDENTITY_CANDIDATE_EC.kind).toBe('ec_member');
  });

  it('通常・空・失敗を別の形で用意する', () => {
    expect(IDENTITY_CANDIDATE_LISTS.friend_duplicate).toMatchObject({ total: 18, limit: 20, offset: 0 });
    // ★V8 重複検出 hn6Y8：絵どおり3組（最高・高・低）。状態別の数と根拠不足の数も持つ。
    expect(IDENTITY_CANDIDATE_LISTS.friend_duplicate.items).toHaveLength(3);
    expect(IDENTITY_CANDIDATE_LISTS.friend_duplicate).toMatchObject({ statusCounts: { pending: 11, deferred: 2, linked: 5, different: 0 }, lowConfidenceCount: 2 });
    expect(IDENTITY_CANDIDATE_LISTS.empty).toEqual({ items: [], total: 0, limit: 20, offset: 0 });
    expect(IDENTITY_CANDIDATE_ERROR).toMatchObject({ success: false, code: 'VISUAL_QA_ERROR' });
    expect(IDENTITY_CANDIDATE_DETECTION.normal).toEqual({
      processed: 1, hasMore: false, nextCursor: null,
    });
    expect(IDENTITY_CANDIDATE_DETECTION.empty).toEqual({
      processed: 0, hasMore: false, nextCursor: null,
    });
  });

  it('メールと電話を平文で置かない', () => {
    const serialized = JSON.stringify([
      IDENTITY_CANDIDATE_FRIEND,
      IDENTITY_CANDIDATE_EC,
    ]);
    expect(serialized).not.toContain('tanaka@example.com');
    expect(serialized).not.toContain('090-0000-5678');
    expect(serialized).toContain('***');
  });
});

describe('統合ユーザー詳細の画面確認データ', () => {
  it('通常・空・失敗を別の形で用意する', () => {
    expect(MERGED_PERSON_DETAIL.linkedFriends).toHaveLength(2);
    expect(MERGED_PERSON_DETAIL.profileValues).toHaveLength(2);
    expect(MERGED_PERSON_EMPTY).toMatchObject({
      profileValues: [], deliveryPriorities: [], history: [],
    });
    expect(MERGED_PERSON_ERROR).toMatchObject({ success: false, code: 'VISUAL_QA_ERROR' });
  });

  it('0件を未取得へ変えず、平文のメールと電話を置かない', () => {
    expect(MERGED_PERSON_EMPTY.profileValues).toEqual([]);
    const serialized = JSON.stringify([MERGED_PERSON_DETAIL, MERGED_PERSON_EMPTY]);
    expect(serialized).not.toContain('tanaka@example.com');
    expect(serialized).not.toContain('090-0000-5678');
    expect(serialized).toContain('***');
  });
});

describe('統合ユーザー一覧と重複集計の画面確認データ', () => {
  it('Workerと同じ器を持ち、通常状態を空の一覧で代用しない', () => {
    expect(USERS_GROUPED).toMatchObject({ total: 2, page: 1, pageSize: 50 });
    expect(USERS_GROUPED.rows).toHaveLength(2);
    expect(USERS_GROUPED.rows[0].accounts).toHaveLength(2);
    expect(DUPLICATE_STATS).toMatchObject({
      totalFollowing: 231,
      uniquePeople: 228,
      friendDups: 3,
      duplicateGroups: 3,
    });
    expect(DUPLICATE_STATS.perAccount).toHaveLength(4);
    expect(DUPLICATE_STATS.pairwiseOverlap).toHaveLength(12);
  });

  it('平文のメールと電話を固定データへ置かない', () => {
    const serialized = JSON.stringify(USERS_GROUPED);
    expect(serialized).not.toContain('tanaka@example.com');
    expect(serialized).not.toContain('090-0000-5678');
    expect(serialized).toContain('***');
  });
});
