import { readFileSync as readRawFileSync } from 'node:fs'
import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, 'page.tsx'), 'utf8')
const CREATE = readFileSync(join(HERE, 'new/page.tsx'), 'utf8')

/** 名前で見つけた関数の本体だけを切り出す。ファイル全体を見ると素通しになる。 */
function fnBody(src: string, decl: string): string {
  const start = src.indexOf(decl)
  if (start < 0) throw new Error(`${decl} が見つかりません`)
  const arrow = src.indexOf('=> {', start)
  if (arrow < 0) throw new Error(`${decl} の本体が見つかりません`)
  const open = arrow + 3
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

describe('新規プール窓の送信 (#1058)', () => {
  it('APIが例外を投げても「作成中…」のまま固まらない', () => {
    const body = fnBody(CREATE, 'const save = async (event?: FormEvent)')
    expect(body, '送信をtryで囲んでいない').toMatch(/try\s*\{[\s\S]*await api\.pools\.create/)
    expect(body, 'APIの例外を受けていない').toContain('} catch (e) {')
    expect(body, '失敗の理由を窓に出していない').toContain('setError(createPageErrorMessage(e))')
    expect(body, '処理中の印を必ず戻していない').toMatch(/finally\s*\{[\s\S]*setSaving\(false\)/)
  })

  it('400系の理由はAPIの言葉、403・5xxは運用の言葉で出す（WRITE-01）', () => {
    expect(CREATE).toContain('createPageErrorMessage(e)')
    expect(readRawFileSync(new URL('../../components/shared/create-page.tsx', import.meta.url), 'utf8')).toContain('return describeSaveFailure(error)')
    const body = fnBody(CREATE, 'const save = async (event?: FormEvent)')
    expect(body, '生の例外文をそのまま出している')
      .not.toMatch(/setError\(\s*(err\.message|String\(err\)|err\s*\))/s)
  })

  it('APIの返事(success:false)と画面の失敗表示を従来どおり分ける', () => {
    const body = fnBody(CREATE, 'const save = async (event?: FormEvent)')
    expect(body).toContain('if (!res.success) throw new Error(res.error)')
    expect(body.indexOf('router.push(')).toBeGreaterThan(body.indexOf('throw new Error(res.error)'))
    expect(body).toContain('setError(createPageErrorMessage(e))')
  })
})

describe('プール所属アカウントの読み込み・追加 (#1058)', () => {
  it('一覧の読み直しに失敗したら握りつぶさず、行の下へ出す', () => {
    const body = fnBody(PAGE, 'const reload = useCallback(async (options?: { force?: boolean })')
    expect(body, '読み直しをtryで囲んでいない').toMatch(/try\s*\{[\s\S]*await api\.pools\.accounts\.list/)
    expect(body, '失敗を受けていない').toContain('} catch {')
    expect(body, '失敗を画面に出していない').toContain('setListError(')
    expect(PAGE).toContain('{listError ? (')
    // 取れなかったのに「所属アカウントなし」と見せない
    expect(PAGE).toContain('members.length === 0 && !listError')
  })

  it('追加に失敗したら静かに無視せず、理由を画面へ出す', () => {
    const body = fnBody(PAGE, 'const onAdd = async (lineAccountId: string)')
    expect(body, '返事を確かめていない').toContain('if (!res.success) throw new Error(res.error)')
    expect(body, '失敗を受けていない').toContain('} catch {')
    expect(body, '失敗を画面に出していない').toContain('setListError(')
    expect(body, '生のAPIエラーをそのまま出している')
      .not.toMatch(/setListError\(\s*(res\.error|String\(|e\b)/)
  })

  it('選択からの呼び出しもPromiseを宙に浮かせない', () => {
    // 選び欄は共通 Select。onChange は値そのものを受け取る。
    expect(PAGE).toContain('void onAdd(a.id)')
  })
})
