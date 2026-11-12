import {
  getRichMenuManualPublishShells,
  jstNow,
  listAccountReferencedLineRichMenuIds,
  listRichMenuManualPublishRequests,
  type RichMenuGroupWithPages,
} from '@line-crm/db';

import { deleteRichMenuShells, type LineRichMenuClient } from './rich-menu-publisher.js';

// DBの記録とLINE上の実体の照合。ずれの種類ごとに直し方を1つ決める。
// 画面の「どうするか」欄は fix.label をそのまま出す。

export type ReconcileDiffKind =
  | 'stale_page_richmenu_id'
  | 'status_mismatch'
  | 'default_mismatch'
  | 'orphan_shell'
  | 'external_only';

export type ReconcileDiff = {
  kind: ReconcileDiffKind;
  detail: string;
  pageId?: string;
  richMenuId?: string;
  /** ずれの種類ごとの直し方（1つ）。画面はそのまま出す。 */
  fix: { label: string; action: string };
};

const RECONCILE_FIX: Record<ReconcileDiffKind, { label: string; action: string }> = {
  stale_page_richmenu_id: { label: '記録を直す', action: 'clear-page-ref' },
  status_mismatch: { label: '下書きに戻す', action: 'reset-status' },
  default_mismatch: { label: 'こちらに合わせる', action: 'relink-default' },
  orphan_shell: { label: 'LINEから消す', action: 'delete-shell' },
  external_only: { label: 'こちらに取り込む', action: 'import-external' },
};

function diff(
  kind: ReconcileDiffKind,
  detail: string,
  extra: { pageId?: string; richMenuId?: string } = {},
): ReconcileDiff {
  return { kind, detail, ...extra, fix: RECONCILE_FIX[kind] };
}

export type RichMenuReconcileComputed = {
  diffs: ReconcileDiff[];
  stalePageIds: string[];
  expectedDefault: string | null;
  orphanRichMenuIds: string[];
  hasDefaultDiff: boolean;
  hasStatusDiff: boolean;
  /** 照合時に読んだLINE側のID一覧。修復時の再読みはしない（同じ照合の結果で直す）。 */
  lineIds: string[];
};

/**
 * ずれを列挙するだけで何も変えない。route の dryRun と毎日の自動照合が使う。
 * LINE が読めないときは投げる（呼び出し側で 502 等にする）。
 */
export async function computeRichMenuDiffs(
  db: D1Database,
  line: LineRichMenuClient,
  group: RichMenuGroupWithPages,
): Promise<RichMenuReconcileComputed> {
  const lineMenus = await line.listRichMenus();
  const currentDefault = await line.getCurrentDefaultRichMenuId();
  const lineIds = new Set(lineMenus.map((menu) => menu.richMenuId));

  const diffs: ReconcileDiff[] = [];

  // 1) ページが指すLINE IDが実在するか。
  const stalePages = group.pages.filter(
    (page) => page.line_richmenu_id && !lineIds.has(page.line_richmenu_id),
  );
  for (const page of stalePages) {
    diffs.push(diff('stale_page_richmenu_id', `ページ「${page.name}」が記録するLINEメニュー ${page.line_richmenu_id} はLINE上にありません`, {
      pageId: page.id,
      richMenuId: page.line_richmenu_id ?? undefined,
    }));
  }

  // 2) 公開中なのにLINEに実体が無い。
  const livePages = group.pages.filter(
    (page) => page.line_richmenu_id && lineIds.has(page.line_richmenu_id),
  );
  const hasStatusDiff = group.status === 'published' && livePages.length === 0;
  if (hasStatusDiff) {
    diffs.push(diff('status_mismatch', '公開中と記録されていますが、LINE上にこのメニューの実体がありません'));
  }

  // 3) 全員既定の張り先がずれている。
  const defaultPage = group.pages.find((page) => page.id === group.default_page_id)
    ?? [...group.pages].sort((a, b) => a.order_index - b.order_index)[0];
  const expectedDefault = defaultPage?.line_richmenu_id ?? null;
  const hasDefaultDiff = group.is_default_for_all === 1 && expectedDefault !== currentDefault;
  if (hasDefaultDiff) {
    diffs.push(diff(
      'default_mismatch',
      expectedDefault
        ? `LINEの全員既定がこのメニューを指していません（現在: ${currentDefault ?? 'なし'}）`
        : '全員既定と記録されていますが、既定ページにLINEメニューがありません',
      { richMenuId: currentDefault ?? undefined },
    ));
  }

  // 4) 失敗・中断した公開runが残した孤児メニュー。running のrunのものは触らない。
  const requests = await listRichMenuManualPublishRequests(db, group.id, 50);
  const orphanShells: Array<{ requestId: string; richMenuId: string }> = [];
  for (const request of requests) {
    if (request.status === 'running') continue;
    const shells = await getRichMenuManualPublishShells(db, request.id);
    for (const shell of shells) {
      const stillReferenced = group.pages.some(
        (page) => page.line_richmenu_id === shell.new_richmenu_id,
      );
      if (!stillReferenced && lineIds.has(shell.new_richmenu_id)) {
        orphanShells.push({ requestId: request.id, richMenuId: shell.new_richmenu_id });
      }
    }
  }
  for (const orphan of orphanShells) {
    diffs.push(diff(
      'orphan_shell',
      `完了・失敗した公開runが残したLINEメニュー ${orphan.richMenuId} が残っています`,
      { richMenuId: orphan.richMenuId },
    ));
  }

  // 5) LINEにだけあるメニュー（別groupの公開版を除く）。直し方は取り込みで、
  // 自動では直さない（取り込みは運用者の判断が要る）。
  const referenced = new Set(await listAccountReferencedLineRichMenuIds(db, group.account_id));
  for (const menu of lineMenus) {
    if (!referenced.has(menu.richMenuId)) {
      const name = menu.name ? `「${menu.name}」` : '';
      diffs.push(diff(
        'external_only',
        `LINEにだけあるメニュー${name}（${menu.richMenuId}）があります`,
        { richMenuId: menu.richMenuId },
      ));
    }
  }

  return {
    diffs,
    stalePageIds: stalePages.map((page) => page.id),
    expectedDefault,
    orphanRichMenuIds: orphanShells.map((o) => o.richMenuId),
    hasDefaultDiff,
    hasStatusDiff,
    lineIds: [...lineIds],
  };
}

export type RichMenuReconcileApplied = {
  applied: ReconcileDiff[];
  failed: Array<{ diff: ReconcileDiff; error: string }>;
  /** 自動で直さないずれ（取り込み候補）。運用者が画面で直す。 */
  unapplied: Array<{ diff: ReconcileDiff; reason: string }>;
};

/**
 * 列挙したずれのうち、自動で直せるものだけ直す。external_only（取り込み）は
 * 運用者の判断が要るため直さず、unapplied として返す。
 */
export async function applyRichMenuDiffs(
  db: D1Database,
  line: LineRichMenuClient,
  groupId: string,
  computed: RichMenuReconcileComputed,
  now: string = jstNow(),
): Promise<RichMenuReconcileApplied> {
  const { diffs } = computed;
  const applied: ReconcileDiff[] = [];
  const failed: Array<{ diff: ReconcileDiff; error: string }> = [];
  const unapplied = diffs
    .filter((d) => d.kind === 'external_only')
    .map((d) => ({ diff: d, reason: '取り込みは「外部メニューの取り込み」画面で運用者が行います' }));

  if (computed.orphanRichMenuIds.length > 0) {
    await deleteRichMenuShells(line, computed.orphanRichMenuIds);
    applied.push(...diffs.filter((d) => d.kind === 'orphan_shell'));
  }

  const defaultDiff = diffs.find((d) => d.kind === 'default_mismatch');
  if (defaultDiff) {
    if (computed.expectedDefault && computed.lineIds.includes(computed.expectedDefault)) {
      try {
        await line.setDefaultRichMenu(computed.expectedDefault);
        applied.push(defaultDiff);
      } catch (error) {
        failed.push({ diff: defaultDiff, error: error instanceof Error ? error.message : String(error) });
      }
    } else {
      // 既定へ張るべき実体が無い。フラグだけ下ろす。
      await db
        .prepare(`UPDATE rich_menu_groups SET is_default_for_all = 0, confirmation_revision = confirmation_revision + 1, updated_at = ? WHERE id = ?`)
        .bind(now, groupId)
        .run();
      applied.push(defaultDiff);
    }
  }

  const statusDiff = diffs.find((d) => d.kind === 'status_mismatch');
  if (statusDiff) {
    await db
      .prepare(
        `UPDATE rich_menu_groups SET status = 'draft', is_default_for_all = 0, confirmation_revision = confirmation_revision + 1, updated_at = ? WHERE id = ?`,
      )
      .bind(now, groupId)
      .run();
    applied.push(statusDiff);
  }

  for (const pageId of computed.stalePageIds) {
    await db.batch([
      db.prepare(`UPDATE rich_menu_pages SET line_richmenu_id = NULL, updated_at = ? WHERE id = ?`).bind(now, pageId),
      db.prepare(`UPDATE rich_menu_groups SET confirmation_revision = confirmation_revision + 1 WHERE id = (SELECT group_id FROM rich_menu_pages WHERE id = ?)`).bind(pageId),
    ]);
  }
  applied.push(...diffs.filter((d) => d.kind === 'stale_page_richmenu_id'));

  return { applied, failed, unapplied };
}
