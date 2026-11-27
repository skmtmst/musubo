import { readUiSource as readFileSync } from '../../../../scripts/test-ui-source.mjs'
import { describe, expect, it } from 'vitest'

const PAGE = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

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

describe('プール作成の受け入れ先の読み込み (#1058)', () => {
  it('一覧取得の失敗を握りつぶさず、選ぶ場所の下へ出す', () => {
    const body = fnBody(PAGE, 'const loadAccounts = useCallback(async ()')
    expect(body, '取得をtryで囲んでいない').toMatch(/try\s*\{[\s\S]*await api\.lineAccounts\.list\(\)/)
    expect(body, '例外を受けていない').toContain('} catch (saveFailure) {')
    expect(body, '失敗を画面に出していない').toContain('setAccountsError(')
    expect(body, '返事の失敗も画面に出していない').toContain("setAccountsError('LINEアカウントを読み込めませんでした。もう一度お試しください。')")
  })

  it('.then だけの呼び出しを残さない（拒否が宙に浮く）', () => {
    expect(PAGE).not.toContain('api.lineAccounts.list().then(')
  })

  it('読み直しても選んだアカウントを上書きしない', () => {
    const body = fnBody(PAGE, 'const loadAccounts = useCallback(async ()')
    expect(body).toContain('setAccountIds((current) => (current.length > 0 ? current : [res.data[0].id]))')
  })
})
