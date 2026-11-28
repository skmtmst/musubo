import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import ListState from './list-state'
import Pagination from './pagination'

/**
 * **中身を出せないときの1枚と、ページ送り。**
 *
 * 一覧が「1件も無い」「読み込めなかった」「権限が無い」を言い分けられないと、
 * 運用者からは**どれも「登録したものが消えた」に見える。**
 *
 * さらに、失敗したときに**運用者にできることが無かった。** 「表示できません
 * でした」とだけ出て、直す手がない。画面を丸ごと読み直すしかなく、それだと
 * 入力中の絞り込みまで消える。
 */
describe('一覧の状態とページ送り', () => {
  it('4つの状態を言い分ける', () => {
    for (const kind of ['loading', 'empty', 'error', 'forbidden'] as const) {
      const html = renderToStaticMarkup(<ListState kind={kind} />)
      expect(html, `${kind} の印が付いていない`).toContain(`data-list-state="${kind}"`)
    }
  })

  it('読み込み中と失敗・権限不足を、読み上げにも伝える', () => {
    expect(renderToStaticMarkup(<ListState kind="loading" />)).toContain('aria-busy="true"')
    // 失敗と権限不足は、その場で読ませる（あとから探しに行かせない）。
    expect(renderToStaticMarkup(<ListState kind="error" />)).toContain('role="alert"')
    expect(renderToStaticMarkup(<ListState kind="forbidden" />)).toContain('role="alert"')
  })

  it('失敗時の再読み込みを、画面に合う言葉で渡せる', () => {
    const html = renderToStaticMarkup(
      <ListState kind="error" action={<button type="button">予約一覧を再読み込み</button>} />,
    )
    expect(html).toContain('予約一覧を再読み込み')
    // 渡さない画面では、重複する一律の押し口を勝手に出さない。
    expect(renderToStaticMarkup(<ListState kind="error" />)).toContain('<button')
  })

  it('権限不足は「無い」ではなく「見られない」と言う', () => {
    const html = renderToStaticMarkup(<ListState kind="forbidden" />)
    expect(html).toContain('権限がありません')
    expect(html).not.toContain('データがありません')
  })

  it('指定された説明を権限不足の定型文で上書きしない', () => {
    const html = renderToStaticMarkup(<ListState kind="forbidden" description="設定で有効にすると使えます。" />)
    expect(html).toContain('設定で有効にすると使えます。')
    expect(html).not.toContain('この操作の権限がありません')
  })

  it('画面から作れない記録一覧では作成を促さない', () => {
    const html = renderToStaticMarkup(<ListState kind="empty" emptyPreset="readonly" />)
    expect(html).toContain('記録が増えると')
    expect(html).not.toContain('新しく作成')
  })

  it('R38: 絞り込みの0件は「まだありません」と言わず、条件を外す口と出す', () => {
    const html = renderToStaticMarkup(
      <ListState kind="empty" emptyPreset="filtered" action={<button type="button">条件を外す</button>} />,
    )
    expect(html).toContain('条件に合うものがありません')
    expect(html).toContain('条件を外す')
    expect(html).not.toContain('まだありません')
    // 作る口は出さない。保存済みが消えたと誤読される。
    expect(html).not.toContain('登録')
    expect(html).not.toContain('作る')
  })

  it('1ページ以下では移動を出さず、2ページあれば移動できる', () => {
    const html = renderToStaticMarkup(<Pagination page={1} pageCount={1} onPageChange={vi.fn()} />)
    expect(html).toBe('')
    expect(renderToStaticMarkup(<Pagination page={1} pageCount={0} onPageChange={vi.fn()} />)).toBe('')
    expect(renderToStaticMarkup(<Pagination page={1} pageCount={2} onPageChange={vi.fn()} />)).toContain('次へ')
  })

})
