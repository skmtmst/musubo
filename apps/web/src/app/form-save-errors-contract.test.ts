import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error This repository-level AST checker is also usable from Node.
import { auditFormSaveErrors, auditSavedScreens } from '../../scripts/form-save-errors-audit.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
describe('全V8画面の保存失敗を欄へ返す見張り', () => {
  it('作成・更新・公開のcatchに、欄の理由を受ける口とスコープがある', () => {
    expect(auditSavedScreens(root)).toEqual([])
  }, 60_000)
  it('上の知らせだけに戻すと落ちる（importが残っていても検出する）', () => {
    const broken = `import { useSaveFormErrors } from '@/components/shared/save-form-errors'
      function Editor() { const errors = useSaveFormErrors();
        async function save() { try { await api.tags.create({name}) } catch (e) { setError('保存できませんでした') } }
        return <SaveErrorScope errors={errors}><input /></SaveErrorScope>
      }`
    expect(auditFormSaveErrors(broken)).toHaveLength(1)
    expect(auditFormSaveErrors(broken.replace("setError('保存できませんでした')", "if (!errors.capture(e)) setError('保存できませんでした')"))).toEqual([])
  })
  it('入力欄のないメニュー保管・再開は除き、名前などを伴う更新は見張る', () => {
    const action = `function Screen() { try { await restaurantTestApi.updateMenu(account, id, { status: 'archived', expectedVersion: version }) } catch (e) { setError('失敗') } return <div /> }`
    expect(auditFormSaveErrors(action)).toEqual([])
    expect(auditFormSaveErrors(action.replace('expectedVersion: version', 'expectedVersion: version, name: editedName'))).toHaveLength(1)
    expect(auditFormSaveErrors(action.replace("status: 'archived'", "status: 'draft'"))).toHaveLength(1)
  })
  it('Promiseのcatchや別名の保存も見張り、読むAPIは対象にしない', () => {
    const broken = `function Editor() { const errors = useSaveFormErrors();
      api.tags.bulkCreate(payload).catch(e => setError('失敗'))
      return <SaveErrorScope errors={errors}><input /></SaveErrorScope>
    }`
    expect(auditFormSaveErrors(broken)).toHaveLength(1)
    expect(auditFormSaveErrors(broken.replace('bulkCreate', 'list'))).toEqual([])
    expect(auditFormSaveErrors(broken.replace("setError('失敗')", "errors.capture(e)"))).toEqual([])
    expect(auditFormSaveErrors(broken.replace("setError('失敗')", "errors.capture(e)").replace('<SaveErrorScope errors={errors}><input /></SaveErrorScope>', '<input />'))).toHaveLength(1)
  })
  it('欄の口を別のcatchにだけ置く抜け道も落とす', () => {
    expect(auditFormSaveErrors(`function Editor() {
      try { await api.tags.list() } catch(e) { errors.capture(e) }
      try { await api.tags.update(id, payload) } catch(e) { setError('失敗') }
      return <SaveErrorScope errors={errors}><input /></SaveErrorScope>
    }`)).toHaveLength(1)
  })
  it('入力欄のないLINE再接続は通知で扱い、入力欄があれば保存欄エラーを要求する', () => {
    const action = `function Resume() {
      async function reconnect() { try { await api.musuboLineResumption.connect(token) } catch(e) { setError('再接続できませんでした') } }
      return <Button onClick={reconnect}>再接続</Button>
    }`
    expect(auditFormSaveErrors(action)).toEqual([])
    expect(auditFormSaveErrors(action.replace('<Button onClick={reconnect}>', '<input /><Button onClick={reconnect}>'))).toHaveLength(1)
  })
})
