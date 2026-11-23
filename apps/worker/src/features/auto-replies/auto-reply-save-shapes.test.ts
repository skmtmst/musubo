import { describe, expect, it } from 'vitest';
import { compareAutoReplyCandidates, keywordMatches } from './auto-reply.js';
import type { AutoReply } from '@line-crm/db';

/**
 * 一致方法の選択が保存され、判定にも反映されることを確かめる。画面側の保存の形と対になる。
 * ここでは「保存された形が選んだとおりに判定される」ことを守る。
 * 新規作成・編集・複数キーワードの3経路は、保存後はどれも
 * `keyword / match_type` と `keywords_json` が同じ当て方になる。
 */

function savedRule(parts: {
  keyword?: string;
  match_type?: string;
  keywords?: Array<{ keyword: string; matchType: 'exact' | 'contains' }>;
  keyword_match_mode?: string;
}) {
  return {
    keyword: parts.keyword ?? '',
    match_type: parts.match_type ?? 'exact',
    keywords_json: parts.keywords ? JSON.stringify(parts.keywords) : null,
    keyword_match_mode: parts.keyword_match_mode ?? null,
  };
}

describe('R29 新規作成：部分一致を選んだら「予約について」に当たる', () => {
  // 新規作成の保存形。1行でも keywords_json を持つ。
  const rule = savedRule({
    keyword: '予約',
    match_type: 'contains',
    keywords: [{ keyword: '予約', matchType: 'contains' }],
  });

  it('「予約について」に当たる', () => {
    expect(keywordMatches(rule, '予約について')).toBe(true);
  });

  it('「予約」そのものにも当たる', () => {
    expect(keywordMatches(rule, '予約')).toBe(true);
  });

  it('関係ない文には当たらない', () => {
    expect(keywordMatches(rule, '営業時間を教えて')).toBe(false);
  });
});

describe('R29 編集：完全一致から部分一致へ変えたら広く当たる', () => {
  const rule = savedRule({
    keyword: '予約',
    match_type: 'contains',
    keywords: [{ keyword: '予約', matchType: 'contains' }],
  });

  it('「予約を変更したい」に当たる', () => {
    expect(keywordMatches(rule, '予約を変更したい')).toBe(true);
  });
});

describe('R29 複数キーワード：どの行も選んだ当て方で判定する', () => {
  const anyRule = savedRule({
    keyword: '渋谷',
    match_type: 'contains',
    keywords: [
      { keyword: '渋谷', matchType: 'contains' },
      { keyword: '新宿', matchType: 'contains' },
    ],
    keyword_match_mode: 'any',
  });

  it('2行目への部分一致でも当たる', () => {
    expect(keywordMatches(anyRule, '新宿に行きたい')).toBe(true);
  });

  it('all なら両方が入った文だけ当たる', () => {
    const allRule = { ...anyRule, keyword_match_mode: 'all' };
    expect(keywordMatches(allRule, '渋谷から新宿へ行きたい')).toBe(true);
    expect(keywordMatches(allRule, '渋谷店はどこ')).toBe(false);
  });
});

describe('R29 旧不具合の形：match_type だけ contains で行が exact のまま', () => {
  // 監査で見つかった保存形。判定側は行を優先するので、
  // 「部分一致を選んだのに当たらない」がここで再現する。
  // 保存済みの食い違いを検出できるよう、不整合な入力の形も試す。
  // （報告の手順）の根拠として残す。
  const mismatched = savedRule({
    keyword: '予約',
    match_type: 'contains',
    keywords: [{ keyword: '予約', matchType: 'exact' }],
  });

  it('行が優先され「予約について」に当たらない（不具合の再現）', () => {
    expect(keywordMatches(mismatched, '予約について')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 実際の判定順は priority の小さい順。一覧と窓の説明はこれに合わせる。
// ---------------------------------------------------------------------------

function candidate(parts: {
  id: string;
  line_account_id?: string | null;
  priority?: number;
  respond_to_all?: number;
  created_at?: string;
}): AutoReply {
  return {
    id: parts.id,
    line_account_id: parts.line_account_id ?? 'account-1',
    priority: parts.priority ?? 0,
    respond_to_all: parts.respond_to_all ?? 0,
    created_at: parts.created_at ?? '2026-09-01T00:00:00.000Z',
  } as AutoReply;
}

describe('R28 判定順は priority の小さい順（Worker の ORDER BY と同じ）', () => {
  it('小さいほど先。監査の例（14 と 3）では 3 が先', () => {
    const ordered = [candidate({ id: 'p14', priority: 14 }), candidate({ id: 'p3', priority: 3 })].sort(
      compareAutoReplyCandidates,
    );
    expect(ordered.map((r) => r.id)).toEqual(['p3', 'p14']);
  });

  it('同じ数字なら作った順', () => {
    const ordered = [
      candidate({ id: 'new', priority: 10, created_at: '2026-09-02T00:00:00.000Z' }),
      candidate({ id: 'old', priority: 10, created_at: '2026-09-01T00:00:00.000Z' }),
    ].sort(compareAutoReplyCandidates);
    expect(ordered.map((r) => r.id)).toEqual(['old', 'new']);
  });
});
