import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IdentityCandidateDetail } from '@line-crm/shared'
import type { IdentityCandidateWithProfiles } from '@/lib/api'
import IdentityDecisionDialog from './identity-decision-dialog'
import {
  IdentityAssurance,
  IdentityEvidenceList,
  IdentityHistoryList,
  IdentityImpactList,
  IdentitySubjectCard,
} from './identity-parts'
import { IdentityStateBlock } from './identity-state'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')

const FRIEND_SCREEN = 'app/friends/identity-candidates/page.tsx'
const EC_SCREEN = 'app/ec-commerce/identity-candidates/page.tsx'

/**
 * 画面確認（`scripts/visual-qa/fixtures.mjs`）が返すのと同じ形。
 *
 * 別の形で書くと、試験は通るのに画面は落ちる。型を通して固定する。
 */
const CANDIDATE: IdentityCandidateDetail = {
  id: 'identity-friend-1',
  kind: 'friend_duplicate',
  status: 'pending',
  version: 1,
  confidence: { score: 92, label: 'very_high' },
  left: {
    kind: 'friend', id: 'friend-identity-left', label: '見本 161', detail: '支店',
    lineAccountId: 'visual-qa-account', lineAccountName: '画面確認アカウント', shopKey: null,
    attributes: [
      { label: 'メールアドレス', valuePreview: 'ta***@example.com', verified: true },
      { label: '電話番号', valuePreview: null, verified: false },
    ],
  },
  right: {
    kind: 'friend', id: 'friend-identity-right', label: '見本 171', detail: '本店',
    lineAccountId: 'visual-qa-account', lineAccountName: '画面確認アカウント', shopKey: null,
    attributes: [{ label: 'メールアドレス', valuePreview: 'ta***@example.com', verified: true }],
  },
  evidence: [
    { key: 'verified_email', label: '確認済みのメールアドレスが同じ', strength: 'strong', verified: true, valuePreview: 'ta***@example.com' },
    { key: 'similar_name', label: '表示名が似ている', strength: 'weak', verified: false, valuePreview: null },
  ],
  impact: [
    { key: 'duplicate_deliveries', label: '重複配信', value: 3, unit: '通', note: null },
    { key: 'past_messages', label: '過去のLINE送信', value: 0, unit: '通', note: '再送しません' },
    { key: 'orders', label: '注文', value: null, unit: '件', note: '取得元を接続後に表示' },
  ],
  history: [],
  detectedAt: '2026-08-30T10:00:00.000Z',
  reviewedAt: null,
  canDecide: true,
  canUndo: false,
  undoNote: '判定を取り消すと、根拠を確認する候補へ戻ります。',
}

const CANDIDATE_WITH_PROFILES: IdentityCandidateWithProfiles = {
  ...CANDIDATE,
  profileCandidates: [{
    fieldKey: 'display_name',
    fieldLabel: 'LINE表示名',
    options: [
      { sourceFriendId: CANDIDATE.left.id, sourceLabel: '候補A', valuePreview: '見本 161', verified: false },
      { sourceFriendId: CANDIDATE.right.id, sourceLabel: '候補B', valuePreview: '見本 171', verified: false },
    ],
  }],
  tagCandidates: [{ id: 'tag-vip', name: 'VIP', color: null, sourceFriendIds: [CANDIDATE.left.id] }],
}

describe('本人照合の候補部品', () => {
  it('未取得と実値0を別々に出す', () => {
    const html = renderToStaticMarkup(<IdentityImpactList impact={CANDIDATE.impact} />)
    expect(html).toContain('3通')
    expect(html).toContain('0通')
    expect(html).toContain('—（未取得）')
    // 「0通」と「—（未取得）」が同じ扱いになっていないこと。
    expect(html).toMatch(/data-identity-impact="past_messages"[^>]*>0通</)
    expect(html).toMatch(/data-identity-impact="orders"[^>]*>—（未取得）</)
  })

  it('根拠の強さと確認済みかどうかを出す', () => {
    const html = renderToStaticMarkup(
      <IdentityEvidenceList evidence={CANDIDATE.evidence} confidence={CANDIDATE.confidence} />,
    )
    expect(html).toContain('確からしさ とても高い')
    expect(html).toContain('決め手になる')
    expect(html).toContain('参考')
    expect(html).toContain('確認済み')
    expect(html).toContain('未確認')
  })

  it('候補の値はマスク済みのまま出し、無い項目は「—（未取得）」にする', () => {
    const html = renderToStaticMarkup(<IdentitySubjectCard side="候補A" subject={CANDIDATE.left} />)
    expect(html).toContain('ta***@example.com')
    expect(html).toContain('—（未取得）')
    // 内部IDは操作に使うだけで、本文には出さない。
    expect(html).not.toContain('friend-identity-left')
    expect(html).not.toContain('visual-qa-account')
  })

  it('元の記録を消さないことと、取り消しても履歴が残ることを言う', () => {
    const html = renderToStaticMarkup(<IdentityAssurance>結び付けます。</IdentityAssurance>)
    expect(html).toContain('元の友だち・注文・LINEアカウントは消えません')
    expect(html).toContain('判定を取り消しても、元の友だち・注文と判断の履歴は残ります。')
  })

  it('まだ判断していない候補で、履歴を空欄にしない', () => {
    const html = renderToStaticMarkup(<IdentityHistoryList history={[]} />)
    expect(html).toContain('判断の履歴')
    expect(html).toContain('まだ判断していません。')
  })
})

describe('本人照合の状態部品', () => {
  it('読込・空・失敗・権限不足を言い分ける', () => {
    const empty = renderToStaticMarkup(
      <IdentityStateBlock state="empty" failure={null} emptyTitle="候補はありません" emptyDescription="見つかると並びます。" />,
    )
    expect(empty).toContain('候補はありません')

    const loading = renderToStaticMarkup(
      <IdentityStateBlock state="loading" failure={null} emptyTitle="x" emptyDescription="y" />,
    )
    expect(loading).toContain('読み込んでいます')
    expect(loading).not.toContain('候補はありません')

    const forbidden = renderToStaticMarkup(
      <IdentityStateBlock
        state="forbidden"
        failure={{ kind: 'forbidden', title: 'この候補を見る権限がありません', description: '追加を依頼してください。' }}
        emptyTitle="x"
        emptyDescription="y"
      />,
    )
    expect(forbidden).toContain('data-list-state="forbidden"')
    expect(forbidden).toContain('この候補を見る権限がありません')

    const error = renderToStaticMarkup(
      <IdentityStateBlock
        state="error"
        failure={{ kind: 'error', title: '本人照合の候補を表示できませんでした', description: '時間をおいて読み直してください。' }}
        emptyTitle="x"
        emptyDescription="y"
      />,
    )
    expect(error).toContain('data-list-state="error"')
  })

  it('通常のときは状態の1枚を描かない', () => {
    const html = renderToStaticMarkup(
      <IdentityStateBlock state="ready" failure={null} emptyTitle="x" emptyDescription="y" />,
    )
    expect(html).toBe('')
  })
})

describe('判定窓', () => {
  it('採用値と利用目的の3確認を判定前に出す', () => {
    const html = renderToStaticMarkup(
      <IdentityDecisionDialog open candidate={CANDIDATE_WITH_PROFILES} busy={false} onCancel={() => {}} onSubmit={() => {}} />,
    )
    expect(html).toContain('統合プロフィールに採用する値')
    expect(html).toContain('画面確認アカウント・見本 161：見本 161')
    expect(html).toContain('利用目的と同意・規約の確認')
    expect(html.match(/type="checkbox"/g)).toHaveLength(3)
  })
  it('3つの判定と理由入力を出し、理由が空なら送れない', () => {
    const html = renderToStaticMarkup(
      <IdentityDecisionDialog
        open
        candidate={CANDIDATE}
        busy={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    )
    expect(html).toContain('同じ人として結び付ける')
    expect(html).toContain('別人として記録する')
    expect(html).toContain('保留にする')
    // #976 U086: 「（必須）」の文字列ではなく共通の必須札を出す
    expect(html).toMatch(/判定の理由<span[^>]*>必須<\/span>/)
    expect(html).toContain('別人として記録し、根拠が変わるまで候補へ戻しません。')
    expect(html).toContain('理由を書くと判定できます。')
    // 理由が空のうちは押せない。
    expect(html).toMatch(/<button[^>]*disabled[^>]*>同じ人として結び付ける</)
  })

  it('友だち同士の判定では再処理の範囲を出さない', () => {
    // Worker は友だち同士に `reprocess` を送ると 422 を返す。
    const html = renderToStaticMarkup(
      <IdentityDecisionDialog open candidate={CANDIDATE} busy={false} onCancel={() => {}} onSubmit={() => {}} />,
    )
    expect(html).not.toContain('過去の扱い')
  })

  it('ECの照合では、既定が「今後だけ」であることを出す', () => {
    const html = renderToStaticMarkup(
      <IdentityDecisionDialog
        open
        candidate={{ ...CANDIDATE, kind: 'ec_member' }}
        busy={false}
        onCancel={() => {}}
        onSubmit={() => {}}
      />,
    )
    expect(html).toContain('過去の扱い')
    expect(html).toContain('今後の注文だけ結び付ける（過去のLINE送信は再送しません）')
  })
})

describe('2画面が同じ部品で組まれている', () => {
  const friend = read(FRIEND_SCREEN)
  const ec = read(EC_SCREEN)

  it('V8は同じ判定の読み口・状態部品を使い、ECの候補部品は維持する', () => {
    expect(friend).toContain('IdentityStateBlock')
    expect(friend).toContain('useIdentityReview')
    for (const source of [ec]) {
      expect(source).toContain('IdentityStateBlock')
      expect(source).toContain('IdentityDecisionDialog')
      expect(source).toContain('IdentityEvidenceList')
      expect(source).toContain('IdentityImpactList')
      expect(source).toContain('IdentitySubjectCard')
      expect(source).toContain('useIdentityReview')
    }
  })

  it('それぞれの種類だけを読む', () => {
    expect(friend).toContain("useIdentityReview('friend_duplicate')")
    expect(ec).toContain("useIdentityReview('ec_member', { lineAccountId: selectedAccountId })")
  })

  it('中身は「通常」のときだけ描く', () => {
    // 失敗・権限不足のときに候補の名前やマスク値が断片で見えないこと。
    expect(friend).toContain("review.state === 'ready'")
    expect(ec).toContain("review.state !== 'ready'")
    expect(ec).toContain("if (pageState !== 'ready')")
  })
})

describe('R600 運用集計の失敗でも会員候補を残す（ECのみ）', () => {
  const ec = read(EC_SCREEN)

  it('候補の有無は候補の読み口で決め、集計の失敗で画面を隠さない', () => {
    // 全面の成否は候補の読み口が持つ。集計の失敗は集計欄だけに出す。
    expect(ec).toContain("review.state !== 'ready'")
    expect(ec).toContain('operationsReady')
  })

  it('集計欄に取得失敗と再試行を示し、読めていない数を0件と書かない', () => {
    expect(ec).toContain('読み込めませんでした')
    expect(ec).toContain("onRetry={operationsState === 'error' ? () => { void loadOperations() }")
    expect(ec).toContain('結びついていない —')
  })

  it('集計の権限不足は再試行を出さず、候補は残す', () => {
    expect(ec).toContain('表示する権限がありません')
  })
})
