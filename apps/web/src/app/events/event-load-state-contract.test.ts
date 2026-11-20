/*
 * イベントと申込者の一覧で、**読めなかったのか 0件なのか**を分ける。
 *
 * 0 は「無い」という事実の表示。取れなかったところに 0 を書くと、
 * **承認待ちの人を見落とし、締め切りの判断を誤る。**
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVENTS = readFileSync(join(HERE, '../../v8/events/list.tsx'), 'utf8')
const BOOKINGS = readFileSync(join(HERE, '../../v8/events/bookings.tsx'), 'utf8')
const RECORDS = readFileSync(join(HERE, '../../v8/events/booking-records.tsx'), 'utf8')
const REQUESTS = readFileSync(join(HERE, '../../v8/events/booking-requests.ts'), 'utf8')
const EDIT = readFileSync(join(HERE, '../../v8/events/edit.tsx'), 'utf8')

/** 説明の文だけで通ってしまわないよう、判定の前にコメントを落とす。 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('V8 イベント・申込者一覧の状態', () => {
  for (const [name, source] of [['イベント', EVENTS], ['申込者', BOOKINGS]] as const) {
    const body = code(source)

    it(`${name}は読込・成功・失敗を別の状態として持つ`, () => {
      expect(body).toContain(name === 'イベント' ? "setLoadStatus('ready')" : "setApplicantsStatus('ready')")
      expect(body).toContain(name === 'イベント' ? "loadStatus === 'error'" : "applicantsStatus === 'error'")
    })

    it(`${name}は切替前の遅い応答を採用しない`, () => {
      // 前のアカウント・前の絞り込みの応答が、次の一覧に混ざらないこと。
      if (name === 'イベント') {
        expect(body).toContain('loadRequestRef')
        expect(body).toContain('if (requestId !== loadRequestRef.current || accountScope.current !== scope) return')
      } else {
        expect(body).toContain('useBookingRequests(operationScope)')
        expect(body).toContain('if (!request.isCurrent()) return')
        expect(REQUESTS).toContain('current.current === frame')
      }
    })

    it(`${name}は失敗したときに一覧を0件と同じ文で出さない`, () => {
      expect(body).toContain('ListState')
      expect(body).toContain('消えていません')
    })
  }

  it('申込者は失敗を error 状態として持つ', () => {
    expect(code(BOOKINGS)).toContain("setApplicantsStatus('error')")
  })

  // イベント一覧の読み込み・失敗・店舗切替は event-list-auth-error.test.tsx で描画して確かめる。

  it('申込者一覧は未取得の帯を0件にしない', () => {
    const body = code(BOOKINGS)
    expect(body).toContain('value={ready ? (occurrence?.activeSeats ?? confirmedSeats + requestedSeats) : null}')
    expect(body).toContain('value={ready ? requestedSeats : null}')
    expect(body).toContain('value={ready ? cancelledCount : null}')
    expect(body).toContain('申込者は消えていません。')
  })

  it('申込者一覧は定員と全状態の件数を小さい集計APIから読む', () => {
    const body = code(BOOKINGS)
    expect(code(RECORDS)).toContain('eventsApi.getBookingSummary(accountId, eventId)')
    expect(body).not.toContain('.listSlots(selectedAccountId, eventId)')
    expect(body).not.toContain('.listWaitlist(selectedAccountId, eventId)')
    // IDEA-29: 残席は行数ではなく、席を消費中の人数(activeSeats)から引く。
    expect(code(RECORDS)).toContain('describeBookingCapacity(activeSeats, summary.totalCapacity ?? null)')
    expect(body).toContain('capacity - (occurrence?.activeSeats ?? 0)')
  })

  it('申込者一覧は切替後に前のイベント名と定員を残さない', () => {
    const body = code(BOOKINGS)
    expect(body).toContain('setEvent(null)')
    expect(body).toContain('setApplicants(null)')
    // 控えがあれば取りに行かない、をやめる（前のイベント名が残る）。
    expect(body).not.toContain('Promise.resolve(event)')
  })

  it('イベントと申込者は共通のoffsetページ送りを使う(点検#520の中8)', () => {
    const body = code(RECORDS)
    expect(body).not.toContain('eventsApi.listEvents(')
    expect(body).toContain('setTotal')
    expect(body).toContain('page,')
    expect(body).toContain('limit: PAGE_SIZE')
    expect(body).toContain('<Pagination')
    const list = code(EVENTS)
    expect(list).toContain('setListTotal')
    // #625: 検索語は上限へ切り詰めてから送る
    expect(list).toContain('clampSearchQuery(query.trim())')
    expect(list).toContain("params.set('q', trimmed)")
    expect(list).toContain("params.set('filter', filter)")
    expect(list).toContain("params.set('sort', sort)")
    expect(EVENTS).not.toContain('200件まで表示しています')
  })

  it('編集画面は取得失敗を黙って0件にせず帯と読み直しを出す(点検#520の中10)', () => {
    const body = code(EDIT)
    expect(body).toContain('setLoadError')
    expect(body).toContain('setReloadSeq')
    expect(EDIT).toContain('一部を読み込めませんでした。読み込めなかった数は「—」で表示しています。')
    expect(EDIT).toContain('読み直す')
    expect(body).toContain('eventsApi.getBookingSummary(accountId, eventId)')
    expect(body).not.toContain('eventsApi.listBookings(accountId, eventId)')
  })

  it('操作の失敗を内部の文字で出さず、一覧は残す', () => {
    const body = code(BOOKINGS)
    expect(body).not.toContain('setError(e instanceof Error ? e.message : String(e))')
    expect(body).toContain('const [actionError, setActionError]')
    // 確定と拒否は出す場所が違う（拒否は窓の中）ので、文も分けた。
    expect(body).toContain('予約を確定できませんでした。')
    expect(body).toContain('予約を拒否できませんでした。')
    expect(body).toContain('{actionError}')
  })
})
