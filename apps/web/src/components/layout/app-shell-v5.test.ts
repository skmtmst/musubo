import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import FriendTrendTable from '../dashboard/friend-trend-table'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PENDING_INBOX = join(ROOT, '..', 'support', 'pending-inbox-card.tsx')
const FRIEND_TREND = join(ROOT, '..', 'dashboard', 'friend-trend-table.tsx')
const CHATS = join(ROOT, '..', '..', 'app', 'chats', 'page.tsx')
const MENU = join(ROOT, '..', '..', 'lib', 'menu.ts')
const DATA_TABLE_CSS = join(ROOT, '..', 'shared', 'data-table.module.css')

// 描画して数えるための見本。1行だけ推定（行に「推定」の文字が残る形）。
const TREND_SAMPLE = [
  { date: '2026-09-27', added: 5, blocked: 1, active: 100, estimated: false },
  { date: '2026-09-20', added: 3, blocked: 0, active: 95, estimated: true },
]
// 全行が推定の日（行の「推定」は消え、見出しの「？」の中で言う形）。
const ALL_ESTIMATED_SAMPLE = [
  { date: '2026-09-27', added: 5, blocked: 1, active: 100, estimated: true },
  { date: '2026-09-20', added: 3, blocked: 0, active: 95, estimated: true },
]

describe("Pen.dev 管理画面を共通レイアウトの正本にする", () => {
  const pendingInbox = readFileSync(PENDING_INBOX, 'utf8')
  const friendTrend = readFileSync(FRIEND_TREND, 'utf8')
  const chats = readFileSync(CHATS, 'utf8')
  const menu = readFileSync(MENU, 'utf8')

  it('対応が必要な受信はV4の4列だけを出し、件数に合わせて高さを縮める', () => {
    for (const label of ['お名前', '内容', '待ち時間', '状態', 'h-fit']) {
      expect(pendingInbox).toContain(label)
    }
    expect(pendingInbox).not.toContain('h-[440px]')
    /*
      1ページの数は**固定にしない**。5件に固定していたころ、総数5件でも
      2行しか出せず、残りへ行く手段が無かった。設計（`NjK9q`）は表示件数を
      選べて、下に番号のページ送りが出る。ページ送りは共通部品へ寄せた。
    */
    expect(pendingInbox).toContain('PAGE_SIZE_OPTIONS')
    expect(pendingInbox).toContain('表示件数')
    expect(pendingInbox).toContain("from '@/components/shared/pagination'")
    expect(pendingInbox).toContain('offset=${(page - 1) * pageSize}')
    expect(pendingInbox).not.toContain('一括で確認済みにする')
    expect(pendingInbox).not.toContain('すべて選択')
  })

  it('推定の説明は表の下ではなく見出しの日付のヘルプに表示する', () => {
    /*
      ★管理画面（2026-09-27 オーナー決定）: 「推定」の「？」は7行に繰り返さず、
      見出しの日付の横の共通部品に1つだけ置く。行ごとの開閉はやめたので
      行内の `aria-expanded` は無い。表の下の注釈に戻さない。
      DASH-17（ホバー専用の吹き出しに戻さない）は共通部品側が守る。
    */
    expect(friendTrend).not.toContain('aria-expanded={open}')
    expect(friendTrend).not.toContain('border-t px-5 py-3')
    expect(friendTrend).toContain('Date.UTC(year, month - 1, day)')
    // 描画して数える：見出しに「？」1つ、行に0（行は「推定」の文字だけ）。
    const html = renderToStaticMarkup(
      createElement(FriendTrendTable, { trend: TREND_SAMPLE }),
    )
    const thead = html.slice(0, html.indexOf('</thead>'))
    const tbody = html.slice(html.indexOf('<tbody'))
    expect(thead.match(/<button/g) ?? []).toHaveLength(1)
    expect(thead).toContain('aria-label="日付の推定値の説明"')
    expect(tbody.match(/<button/g) ?? []).toHaveLength(0)
    expect(tbody).toContain('推定')
    // 全行が推定の日も、見出し1つ・行0は変わらない（行の「推定」は消える）。
    const allEstimatedHtml = renderToStaticMarkup(
      createElement(FriendTrendTable, { trend: ALL_ESTIMATED_SAMPLE }),
    )
    const allTbody = allEstimatedHtml.slice(allEstimatedHtml.indexOf('<tbody'))
    expect(allTbody.match(/<button/g) ?? []).toHaveLength(0)
    expect(allTbody).not.toContain('推定')
  })

  it('推移表の見出しは狭い画面でも折り返さない（DASH-27）', () => {
    const body = friendTrend.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    /*
      ★管理画面（2026-09-27 オーナー決定）: 日付の見出しに共通部品の「？」が
      入ったため、文言直前の `">` では見出しを特定できない。見出し5つ
      全てに `whitespace-nowrap` があることと、表が横にスクロールできる
      こと（`overflow-x-auto`）で同じ意図を守る。案内文と流入元列
      （「すべて表示」）は ★管理画面 で外れた。
    */
    // 見出しは共通 Th（大文字）で書く。素の th も同じ形とみなす。
    const headers = body.match(/<[tT]h[\s>][^>]*>/g) ?? []
    expect(headers).toHaveLength(5)
    for (const header of headers) expect(header).toContain('whitespace-nowrap')
    for (const label of ['日付', '前日比', '登録', 'ブロック', '有効友だち']) {
      expect(body).toContain(label)
    }
    // 表は共通 DataTable。狭い幅の横スクロールは外枠（frame）が持つ。
    expect(body).toContain('<DataTable')
    const frame = readFileSync(DATA_TABLE_CSS, 'utf8')
    expect(frame).toContain('overflow-x: auto')
    // 日付の見出しは「？」と一緒でも折り返さない：日付を含む th が nowrap で HelpTip を持つ。
    const cells = body.match(/<[tT]h[^>]*>[\s\S]*?<\/[tT]h>/g) ?? []
    const dateCell = cells.find((cell) => cell.includes('日付')) ?? ''
    expect(dateCell).toContain('whitespace-nowrap')
    expect(dateCell).toContain('日付の推定値の説明')
    // 描画した表でも、日付の th が nowrap のまま。
    const html = renderToStaticMarkup(
      createElement(FriendTrendTable, { trend: TREND_SAMPLE }),
    )
    const renderedDateCell = html.match(/<th[^>]*>[\s\S]*?日付[\s\S]*?<\/th>/)?.[0] ?? ''
    expect(renderedDateCell).toContain('whitespace-nowrap')
  })

  it('ダッシュボードの名前からLINE・メールそれぞれの受信内容を開く', () => {
    expect(pendingInbox).toContain('/chats?channel=email&thread=')
    expect(pendingInbox).toContain('/chats?friend=')
    expect(chats).toContain("params.get('thread')")
  })

  it('V4で追加した店舗運用メニューが実装から消えていない', () => {
    // D-3で統括へ集約した「アカウント」「データ移行」は店舗メニューの対象外。
    for (const label of ['コンバージョン', '専用機能', 'NEN配信', '写真審査', 'EC連携']) {
      expect(menu).toContain(label)
    }
  })
})
