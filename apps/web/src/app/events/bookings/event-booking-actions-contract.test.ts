/*
 * 申込者一覧（`i5SN2j`）で守りたいこと。
 *
 * この面の押し口はどれも**友だちへLINEが飛ぶ**。押す前に、誰に何が
 * 起きるのかを読めないといけない。ブラウザ標準の窓では、それを書く
 * 場所が無いうえ、**画像比較にも写らないので絵を撮れない。**
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PAGE = readFileSync(new URL('../../../v8/events/bookings.tsx', import.meta.url), 'utf8')

/** 説明の文だけで通ってしまわないよう、判定の前にコメントを落とす。 */
const RECORDS = readFileSync(new URL('../../../v8/events/booking-records.tsx', import.meta.url), 'utf8')
const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('V8 Mu8qW イベント申込者の次行動と安全なキャンセル', () => {
  it('運営キャンセルをブラウザ標準の窓で直に実行しない', () => {
    expect(CODE).not.toContain("confirm('運営側でキャンセルしますか？")
    // 窓を開ける押し口に目印。これが無いと撮影から辿れない。
    expect(CODE).toContain('setCancelApplicant({ applicant: row, accountId: selectedAccountId })')
    expect(CODE).toContain('open={cancelApplicant !== null}')
    // 何が起きるか・何が残るか・戻せないこと。
    expect(CODE).toContain('友だちへLINEでお知らせが届き')
    expect(CODE).toContain('送ったお知らせは取り消せません')
  })

  it('拒否理由をブラウザ標準の窓で聞かず、届く範囲が分かる窓で確認する', () => {
    expect(CODE).not.toContain('window.prompt')
    expect(CODE).toMatch(/setRejectApplicant\(\{ applicant: row, accountId: selectedAccountId \}\)[\s\S]*?onConfirm=\{\(\) => rejectApplicant && rejectApplicant\.accountId === selectedAccountId && void decide\(rejectApplicant\.applicant, 'reject'\)/)
    expect(CODE).toContain('open={rejectApplicant !== null}')
    // 書いた理由がどこへ行くのか。prompt には書く場所が無かった。
    expect(CODE).toContain('理由は内部にだけ残り')
    expect(CODE).toContain('友だちには決まったお知らせの文が届き')
    expect(CODE).toContain('rejectReason.trim() || undefined')
    expect(CODE).toContain('error={rejectError}')
  })

  it('二重実行を止め、失敗しても窓を閉じず画面の言葉を出す', () => {
    expect(CODE).toContain('busy')
    expect(CODE).toContain('error={cancelError}')
    expect(CODE).toContain('予約をキャンセルできませんでした')
    expect(CODE).toContain('予約を拒否できませんでした')
  })

  it('名前を取れない行に内部IDを出さない', () => {
    // `er-1` のような目印は、運用者にとって手がかりにならない。
    expect(CODE).not.toContain('friend_id.slice(0, 8)')
    expect(CODE).not.toContain("(b.line_account_id ?? '').slice(0, 8)")
    expect(CODE).toContain('友だちは未取得')
    expect(RECORDS).toContain('アカウントは未取得')
  })

  it('タブ切替では申込一覧だけ取り直す(点検#520軽13)', () => {
    // 詳細・待ち列はタブと無関係。切替のたびに3つ取り直すと遅く、裏も重い。
    expect(RECORDS).toContain('eventsApi.listBookings(accountId, eventId,')
    expect(RECORDS).toContain('function RecordSummary(')
    expect(RECORDS).toContain('useBookingRequests(JSON.stringify([accountId, eventId, revision, retry]))')
    expect(CODE).toContain('void refreshEvent()')
  })
})
