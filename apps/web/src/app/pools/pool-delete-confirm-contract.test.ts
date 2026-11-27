import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = readFileSync(join(HERE, 'page.tsx'), 'utf8')

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

/** n番目（0始まり）の `<ConfirmDialog ... />` を切り出す。 */
function dialog(src: string, index: number): string {
  let from = -1
  for (let i = 0; i <= index; i++) from = src.indexOf('<ConfirmDialog', from + 1)
  if (from < 0) throw new Error(`${index + 1}つ目の <ConfirmDialog が見つかりません`)
  const to = src.indexOf('/>', from)
  if (to < 0) throw new Error('確認窓が閉じていません')
  return src.slice(from, to + 2)
}

describe('プールの削除確認', () => {
  it('ブラウザのconfirmもalertも使わず、共通の確認窓へ移す', () => {
    expect(PAGE).toContain("import ConfirmDialog from '@/components/shared/confirm-dialog'")
    const code = PAGE.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(code).not.toMatch(/[^.\w]confirm\(/)
    expect(code, 'alertで生のAPIエラーを出している').not.toMatch(/[^.\w]alert\(/)
  })

  it('プール削除が二度押しを受け付けず、既定のプールは消せない', () => {
    const body = fnBody(PAGE, 'const onDelete = async ()')
    expect(body, '既定のプールを止めていない').toContain('if (isMain || deleting || deleteLock.current || !deleteContext || !deleteContext.accounts || !alive.current || !canManageRef.current || deleteContext.ticket !== deleteTicket.current || deleteContext.poolId !== poolRef.current.id || deleteContext.updatedAt !== poolRef.current.updatedAt) return')
    expect(body).toContain('setDeleting(true)')
    expect(body, '処理中の印を必ず戻していない').toMatch(/finally\s*\{[\s\S]*setDeleting\(false\)/)
  })

  it('プール削除の失敗を握りつぶさず、窓の中に運用の言葉で出す', () => {
    const body = fnBody(PAGE, 'const onDelete = async ()')
    expect(body, '返事を確かめていない').toContain('if (!res.success) throw new Error(res.error)')
    expect(body, '失敗を窓に出していない').toContain(
      "setDeleteError('このプールを削除できませんでした。状態を読み直してから、もう一度お試しください。')",
    )
    expect(body, '生のAPIエラーをそのまま出している').not.toMatch(/setDeleteError\(\s*(res\.error|String\(|e\b)/)
    expect(body, '成功していないのに一覧を作り直している').toMatch(
      /throw new Error\(res\.error\)[\s\S]*onChange\(\)/,
    )
  })

  it('プール削除の窓が、止まる口と残る記録を読ませる', () => {
    const jsx = dialog(PAGE, 0)
    expect(jsx, 'プール名を読ませていない').toContain('pool.name')
    expect(jsx, 'どのURLが止まるのか読ませていない').toContain('公開URL ${publicUrl} は使えなくなり')
    expect(jsx, '残るものを言っていない').toContain(
      '所属していたLINEアカウントと、これまでの流入の記録は残ります。',
    )
    expect(jsx).toContain('この操作は取り消せません。')
    expect(jsx).toContain('destructive')
    expect(jsx).toContain('confirmLabel="削除する"')
    expect(jsx, '処理中でも押せてしまう').toContain('busy={deleting}')
    expect(jsx, '失敗が窓の中に出ない').toContain('error={deleteError}')
    expect(jsx, '処理中に閉じられてしまう').toContain('if (deleting || !deleteContext || deleteContext.ticket !== deleteTicket.current) return')
  })
})

describe('プールからアカウントを外す確認', () => {
  it('外す処理が二度押しを受け付けない', () => {
    const body = fnBody(PAGE, 'const onRemove = async ()')
    expect(body, '押している間の二度押しを止めていない').toContain('if (!removeTarget || removing || lock.current || !alive.current || !manageRef.current || removeTarget.scope !== poolScope.current || loadedScope.current !== removeTarget.scope || removeTarget.ticket !== ticketRef.current || !membersRef.current.some(member => member.id === removeTarget.id && member.lineAccountId === removeTarget.lineAccountId)) return')
    expect(body).toContain('setRemoving(true)')
    expect(body, '処理中の印を必ず戻していない').toMatch(/finally\s*\{[\s\S]*setRemoving\(false\)/)
  })

  it('外すのに失敗したら、外れた顔をせず窓の中に理由を出す', () => {
    const body = fnBody(PAGE, 'const onRemove = async ()')
    expect(body, '返事を確かめていない').toContain('if (!res.success) throw new Error(res.error)')
    expect(body, '失敗を窓に出していない').toContain(
      "setRemoveError('このアカウントをプールから外せませんでした。状態を読み直してから、もう一度お試しください。')",
    )
    expect(body, '生のAPIエラーをそのまま出している').not.toMatch(/setRemoveError\(\s*(res\.error|String\(|e\b)/)
    expect(body, '成功していないのに一覧を作り直している').toMatch(
      /throw new Error\(res\.error\)[\s\S]*await reload\(\{ force: true \}\)/,
    )
  })

  it('入れ直せる操作なので、取り消せない操作の赤は付けない', () => {
    const jsx = dialog(PAGE, 1)
    expect(jsx, '入れ直せる操作まで赤くすると、本当に消える操作の赤が効かない')
      .not.toContain('destructive')
    expect(jsx).toContain('confirmLabel="外す"')
    expect(jsx, '入れ直せることを言っていない').toContain('同じアカウントを入れ直せます。')
    expect(jsx, 'アカウント自体が残ることを言っていない').toContain(
      'アカウント自体と、これまでの流入の記録は残ります。',
    )
    expect(jsx, '処理中でも押せてしまう').toContain('busy={removing}')
    expect(jsx, '失敗が窓の中に出ない').toContain('error={removeError}')
    expect(jsx, '処理中に閉じられてしまう').toContain('if (removing || !removeTarget || removeTarget.ticket !== ticketRef.current) return')
  })

  it('外すボタンは窓を開くだけで、押した時点では外さない', () => {
    expect(PAGE).toContain("setRemoveTarget({ id: m.id, lineAccountId: m.lineAccountId, name, accountName: acc?.name ?? null, poolName, scope: renderedScope, ticket })")
  })
})
