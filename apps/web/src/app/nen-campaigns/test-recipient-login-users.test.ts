import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(directory, 'page.tsx'), 'utf8');
const overview = readFileSync(join(directory, '../../v8/nen-campaigns/list.tsx'), 'utf8');
const editor = readFileSync(join(directory, '../../v8/nen-campaigns/edit.tsx'), 'utf8');
const api = readFileSync(join(directory, '../../lib/api.ts'), 'utf8');

describe('NEN配信のテスト送信先', () => {
  test('候補は「設定 › アカウント › テスト送信先」に登録した人だけ（実口 getTestRecipient と同じ範囲）', () => {
    // 登録されていない友だちを候補に並べると、押しても届かず理由も分からない（2026-09-19 検証環境で発生）。
    expect(page).toContain('api.accountSettings.getTestRecipients(selectedAccountId)');
    expect(page).not.toContain('api.friends.list({ accountId: selectedAccountId, limit: 100');
    expect(overview).toContain('テスト送信先が未登録です');
    expect(overview).toContain('/accounts/detail?id=');
    // 送信先の問題（未登録・友だち解除）は直し方まで言う。
    expect(page).toContain("caught.code === 'test_recipient_unavailable'");
  });

  test('設定・履歴・コラム・実績・クーポンを選択中LINEアカウントへ限定する', () => {
    expect(page).toContain('api.nenCampaigns.settings(selectedAccountId)');
    expect(page).toContain('api.nenCampaigns.deliveries(selectedAccountId, { limit: 20 })');
    expect(page).toContain('api.nenCampaigns.flowMetrics(selectedAccountId, { from: thisMonth.from, to: thisMonth.to })');
    expect(page).toContain('api.nenCampaigns.columnMetrics(selectedAccountId, { from: thisMonth.from, to: thisMonth.to })');
    expect(page).toContain('api.nenCampaigns.columns(selectedAccountId)');
    expect(page).toContain('api.nenCampaigns.birthdayCoupon(selectedAccountId)');
    expect(page).toContain('api.nenCampaigns.columnAudience(selectedAccountId, selectedColumn.targetMode, selectedColumn.targetTagId)');
    expect(editor).toContain('api.nenCampaigns.settings(selectedAccountId)');
    expect(api).toContain('lineAccountId=${encodeURIComponent(accountId)}');
  });

  test('配信履歴では内部の英語状態を運用者向けの日本語へ変える', () => {
    expect(overview).toContain("pending: 'これから送ります'");
    expect(overview).toContain("failed: '届きませんでした'");
    expect(overview).not.toContain('>{job.status}</span>');
  });

  test("誕生日クーポンは管理画面どおり3日前10時と案内する", () => {
    expect(overview).toContain('誕生日は3日前の10:00に送ります');
    expect(overview).not.toContain('誕生日月の1日に自動送信');
    expect(overview).toContain('formatCampaignTiming(setting)');
  });

  test('取得済みの失敗・待機件数を表示し、配信日時を日本時間へ変える', () => {
    expect(overview).toContain('summary.pending + summary.processing');
    expect(page).toContain('undelivered: thisMonthRes.data.summary.failed');
    expect(overview).toContain('jstDateTime(delivery.sentAt || delivery.scheduledAt)');
    expect(overview).not.toContain('予定：{delivery.scheduledAt}');
  });

  test('一覧の読込失敗を0件や空状態として表示しない', () => {
    // 1件の失敗で画面全体をエラーにしない(点検 #512 の中3)。
    // ★管理画面 `x63W5x`：失敗はそのタブの一覧の場所の1枚で示す（帯は出さない）。
    expect(page).toContain('tabErrors');
    expect(page).toContain('tabError');
    expect(overview).toContain('tabError');
    expect(overview).toContain('onRetryTab');
    expect(page).not.toContain('loadError');
  });
});
