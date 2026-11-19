import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIALOG = readFileSync(join(__dirname, 'bulk-run-dialog.tsx'), 'utf8')
// 役割の読込は共通フックが持つ。画面の押し口と、その読込口を両方確かめる。
const PAGE = readFileSync(join(__dirname, '..', '..', 'app', 'friends', 'page.tsx'), 'utf8')
  + readFileSync(join(__dirname, '..', '..', 'lib', 'staff-role.ts'), 'utf8')

/** 画面側の配線。**考え方が正しくても、繋いでいなければ効かない。** */
describe("管理画面 友だち一括操作（IAf7j）の配線", () => {
  it('既存の /friends の中に作り、別ルートを増やさない', () => {
    expect(PAGE).toContain('<BulkRunDialog')
    expect(DIALOG).toContain('data-design-node="IAf7j"')
    expect(PAGE).toContain('data-qa-open="IAf7j"')
  })

  it('owner/admin 以外には押し口を出さない', () => {
    /*
      **押し口を出す条件そのものを見る。** `canRunBulk` がファイルの
      どこかにあるだけでは、押し口の分岐から外されても気づけない
      （実際に、条件から外しても落ちない試験になっていた）。
      R115: 判定は本人の役割（`api.staff.me`）で見る。選んでいる
      LINEアカウントの「役割メモ」（`selectedAccount.role`）は自由記述で、
      ログイン担当者の権限ではないので使わない。
    */
    expect(PAGE).toContain('{selectedIds.size > 1 && canRunBulk(staffRole) ? (')
    expect(PAGE).toContain('{selectedIds.size > 1 && staffRole !== null && !canRunBulk(staffRole) ? (')
    expect(PAGE).toContain('api.staff.me()')
    expect(PAGE).not.toContain('canRunBulk(selectedAccount')
    expect(PAGE).toContain('一括操作ができるのはオーナーと管理者だけです')
  })

  it('開いたときに書き込みの口を呼ばない', () => {
    const effect = DIALOG.slice(DIALOG.indexOf('useEffect(() => {'), DIALOG.indexOf('if (!open) return null'))
    for (const w of ['bulkCreate', 'bulkRetry', 'bulkUndo', 'bulkPreview']) {
      expect(effect).not.toContain(`api.friends.${w}`)
    }
  })

  it('遅い返事は3つで照合してから受け取る', () => {
    expect(DIALOG).toContain('contextRef.current.open')
    expect(DIALOG).toContain('contextRef.current.accountId === at.accountId')
    expect(DIALOG).toContain('contextRef.current.targetKey === at.targetKey')
    expect(DIALOG).toContain('requestRef.current.generation === at.generation')
    expect(DIALOG).toContain('if (!stillHere()) return')
    // 次のpreviewを押さなくても、アカウント・対象の変更だけで古い返事を無効にする。
    expect(DIALOG).toContain('}, [accountId, open, targetKey])')
    expect(DIALOG).toContain('resultRequestRef.current += 1')
    expect(DIALOG).toContain('targetKey,\n      generation:')
    expect(DIALOG).not.toContain("targetKey: friendIds.join(',')")
  })

  it('書き込み中にアカウントや対象が変わっても、古い結果を窓へ戻さない', () => {
    expect(DIALOG.match(/const started = \{ accountId, targetKey \}/g)).toHaveLength(3)
    expect(DIALOG.match(/if \(!stillHere\(\)\)/g)?.length).toBeGreaterThanOrEqual(6)
  })

  it('Workerが受け付けるUUIDを使い、返事不明の再試行では同じ鍵を保つ', () => {
    expect(DIALOG).toContain('new IdempotencyKeyStore()')
    expect(DIALOG).toContain('createKeysRef.current.get(signature)')
    expect(DIALOG).toContain('createKeysRef.current.clear(signature)')
    expect(DIALOG).toContain('undoKeysRef.current.get(signature)')
    expect(DIALOG).not.toContain('Date.now()')
  })

  it('202の受付を完了扱いせず、確定するまで結果を読み直す', () => {
    expect(DIALOG).toContain('RESULT_POLL_LIMIT')
    expect(DIALOG).toContain('isRunComplete(response.data.status)')
    expect(DIALOG).toContain("void pollRun(res.data.id, 'execute')")
    expect(DIALOG).toContain("void pollRun(detail.id, 'retry')")
    // 取り消しは別実行なので、元のdetail.idではなく返されたIDを追う。
    expect(DIALOG).toContain("void pollRun(res.data.id, 'undo')")
    expect(DIALOG).not.toContain('api.friends.bulkGet(detail.id)')
  })

  it('やり直しは失敗した対象だけ、取り消しは取り消せる操作だけ', () => {
    expect(DIALOG).toContain('canRetry(detail)')
    expect(DIALOG).toContain('canUndo(detail)')
    expect(DIALOG).toContain('だけやり直す')
  })

  it('読込中・取得失敗・権限不足を分ける', () => {
    for (const k of ['kind="loading"', 'kind="error"', 'kind="forbidden"']) expect(DIALOG).toContain(k)
    // 権限不足では候補も個人情報も描かない。
    const forbidden = DIALOG.slice(DIALOG.indexOf("previewState === 'forbidden'"))
    expect(forbidden.slice(0, 400)).not.toContain('preview.sample')
  })

  it('閉じたら前の結果を持ち越さない', () => {
    const effect = DIALOG.slice(DIALOG.indexOf('useEffect(() => {'), DIALOG.indexOf('if (!open) return null'))
    for (const r of ['setPreview(null)', 'setDetail(null)', 'setFailure(null)']) expect(effect).toContain(r)
  })

  it('内部IDを画面へ出さない', () => {
    /*
      名前が無いときは「名前未登録」。**`key=` は描画されない**ので、
      描く場所（`>{...}` と `{...}<`）だけを見る。
    */
    expect(DIALOG).toContain("item.displayName ?? '名前未登録'")
    expect(DIALOG).not.toMatch(/>\{item\.friendId\}/)
    expect(DIALOG).not.toMatch(/\{item\.friendId\}</)
    expect(DIALOG).not.toMatch(/>\{detail\.id\}/)
  })
})
