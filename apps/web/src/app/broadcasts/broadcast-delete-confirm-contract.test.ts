import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PAGE = readFileSync(new URL('../../v8/broadcasts/list.tsx', import.meta.url), 'utf8')

/** 名前で見つけた関数の本体だけを切り出す。ファイル全体を見ると素通しになる。 */
function fnBody(src: string, decl: string): string {
  const start = src.indexOf(decl)
  if (start < 0) throw new Error(`${decl} が見つかりません`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error(`${decl} の本体が閉じていません`)
}

function dialog(src: string): string {
  const open = src.indexOf('open={deleteTarget !== null && renderedDeleteScope?.generation === accountScope.current.generation}')
  const from = src.lastIndexOf('<ConfirmDialog', open)
  if (from < 0) throw new Error('<ConfirmDialog が見つかりません')
  const pairedTo = src.indexOf('</ConfirmDialog>', from)
  const selfClosingTo = src.indexOf('/>', from)
  const to = pairedTo >= 0 && pairedTo < selfClosingTo ? pairedTo : selfClosingTo
  if (to < 0) throw new Error('ConfirmDialog の終わりが見つかりません')
  return src.slice(from, to)
}

describe('一斉配信一覧の削除確認', () => {
  it('ブラウザのconfirmを使わず、共通の確認窓へ移す', () => {
    expect(PAGE).toContain("import ConfirmDialog from '@/components/shared/confirm-dialog'")
    expect(PAGE.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))
      .not.toMatch(/[^.\w]confirm\(/)
  })

  it('削除の処理が二度押しを受け付けない', () => {
    const body = fnBody(PAGE, 'const handleDelete = async ()')
    expect(body, '押している間の二度押しを止めていない').toContain('if (!deleteTarget || deleting || !renderedDeleteScope || renderedDeleteScope !== deleteScope.current || renderedDeleteScope.generation !== accountScope.current.generation) return')
    expect(body).toContain('setDeleting(true)')
    expect(body, '処理中の印を必ず戻していない').toMatch(/finally\s*\{[\s\S]*setDeleting\(false\)/)
  })

  it('削除の失敗を握りつぶさず、窓の中に運用の言葉で出す', () => {
    const body = fnBody(PAGE, 'const handleDelete = async ()')
    expect(body, '返事を確かめていない').toContain('if (!res.success) throw new Error(res.error)')
    expect(body, '失敗を窓に出していない').toContain(
      "setDeleteError('この配信を削除できませんでした。状態を読み直してから、もう一度お試しください。')",
    )
    expect(body, '生のAPIエラーをそのまま出している').not.toMatch(/setDeleteError\(\s*(res\.error|String\(|e\b)/)
    expect(body, '成功していないのに窓を閉じている').toMatch(
      /throw new Error\(res\.error\)[\s\S]*setDeleteTarget\(null\)/,
    )
  })

  it('予約の中止と、取り消せない操作であることを一文で伝える', () => {
    const jsx = dialog(PAGE)
    expect(jsx, '予約中の配信が止まることを書いていない').toContain('予約中の配信は中止され')
    expect(jsx).toContain('この操作は取り消せません。')
  })

  it('送信済みの配信に、下書きの言い方を出さない', () => {
    /*
     * 窓の本文は「予約中かどうか」で分岐する。**送信済みにも削除を出すと、
     * else の枝が「まだ送っていないので、友だちには何も届きません。」という
     * 嘘の文を出す。** 削除の口（…メニューの中の危ない操作）は下書きと
     * 予約中だけに置く（★管理画面 Xn1Mz：行にゴミ箱ボタンは置かない）。
     */
    expect(PAGE).toContain("broadcast.status === 'draft' || broadcast.status === 'scheduled'")
  })

  it('何を消すのかを、配信名と影響で読み合わせる', () => {
    const jsx = dialog(PAGE)
    expect(jsx, '配信名を読ませていない').toContain('deleteTarget?.title')
    expect(jsx, '配信設定と確認画面から消えることを書いていない').toContain('配信設定と確認画面から消えます')
  })

  it('確認窓が取り消せない操作として出て、処理中は閉じられない', () => {
    const jsx = dialog(PAGE)
    expect(jsx).toContain('destructive')
    expect(jsx).toContain("busy={deleting}")
    expect(jsx).toContain("destructive")
    expect(jsx).toContain('confirmLabel="削除する"')
    expect(jsx, '処理中でも押せてしまう').toContain('busy={deleting}')
    expect(jsx, '失敗が窓の中に出ない').toContain('error={deleteError}')
    expect(jsx, '処理中に閉じられてしまう').toContain('if (deleting) return')
  })

})
