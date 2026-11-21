import { getPageAction, findPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import TemplateConsole, { resolvedItems } from '@/test-utils/hq-template-console'
import type { Preflight, TemplateDefinition, TemplateType } from '@/lib/hq-templates-api'

const calls = vi.hoisted(() => Object.fromEntries(['uploadImage','deleteImage','context','list','accounts','get','create','update','remove','preflight','distribute','result'].map(key => [key, vi.fn()])))
vi.mock('@/lib/hq-templates-api', async (original) => ({ ...await original<typeof import('@/lib/hq-templates-api')>(), TEMPLATE_TYPES: ['tag','template','rich_menu','form'], hqTemplatesApi: { listStats: async () => ({ thisMonthSentCount: 0, outdatedTemplateCount: 0 }), listByKind: () => calls.list('template'), kindCounts: async () => ({}), versions: async () => [], receivedVersions: async () => [], messageReferences: async () => [], folders: { list: async () => [] }, ...calls } }))
vi.mock('./template-definition-editor', () => {
  const freshDefinition = (type: TemplateType): TemplateDefinition => type === 'tag'
    ? { schemaVersion: 1, tag: { name: '', folderId: null }, folders: [] }
    : type === 'template'
      ? { schemaVersion: 1, template: { id: 'hq-authored-message', name: '', category: 'general', messageType: 'text', messageContent: '', carouselActionsJson: null, carouselTapLimitMode: 'none', carouselTapLimitText: null, questionJson: null, questionStatus: 'draft' }, media: [] }
      : type === 'rich_menu'
        ? { schemaVersion: 1, richMenu: { id: 'rich-menu-main', name: '', chatBarText: 'メニュー', size: 'large', defaultPageId: 'page-1', pages: [{ id: 'page-1', name: 'メイン', imageR2Key: '', areas: [] }] } }
        : { schemaVersion: 1, form: { name: '', description: null, fields: [{ name: 'question_1', label: '質問1', type: 'text', required: false }], layout: null, on_submit_tag_id: null, on_submit_scenario_id: null, save_to_metadata: true } }
  const definitionName = (type: TemplateType, value: TemplateDefinition) => type === 'tag' && 'tag' in value ? value.tag.name : type === 'template' && 'template' in value ? value.template.name : type === 'rich_menu' && 'richMenu' in value ? value.richMenu.name : type === 'form' && 'form' in value ? value.form.name : ''
  const definitionForName = (type: TemplateType, value: TemplateDefinition, name: string, description: string): TemplateDefinition => type === 'tag' && 'tag' in value ? { ...value, tag: { ...value.tag, name, description: description || null } } : type === 'template' && 'template' in value ? { ...value, template: { ...value.template, name } } : type === 'rich_menu' && 'richMenu' in value ? { ...value, richMenu: { ...value.richMenu, name } } : type === 'form' && 'form' in value ? { ...value, form: { ...value.form, name, description: description || null } } : value
  const definitionError = (type: TemplateType, value: TemplateDefinition) => !definitionName(type, value).trim() ? '名前を入力してください。' : type === 'template' && 'template' in value && !value.template.messageContent.trim() ? '本文を入力してください。' : type === 'rich_menu' && 'richMenu' in value && !value.richMenu.pages[0]?.imageR2Key ? '画像を入力してください。' : null
  function Editor({ type, value, disabled, onChange, onBusyChange, onRichMenuNameChange }: { onRichMenuNameChange?: (name: string) => void; type: TemplateType; value: TemplateDefinition; disabled: boolean; onChange: (next: TemplateDefinition) => void; onBusyChange?: (busy: boolean) => void }) {
    if (type === 'template' && 'template' in value) return <><textarea aria-label="配信する本文" disabled={disabled} value={value.template.messageContent} onChange={event => onChange({ ...value, template: { ...value.template, messageContent: event.target.value } })} /><input aria-label="メッセージ画像を選ぶ" type="file" disabled={disabled} onChange={event => { const file = event.target.files?.[0]; if (!file) return; onBusyChange?.(true); void calls.uploadImage(file, 'message').then((media: object) => onChange({ ...value, media: [...value.media, media] })).finally(() => onBusyChange?.(false)) }} /></>
    if (type === 'rich_menu' && 'richMenu' in value) return <><input aria-label="ひな形の名前" value={value.richMenu.name} onChange={e => { onChange({ ...value, richMenu: { ...value.richMenu, name: e.target.value } }); onRichMenuNameChange?.(e.target.value) }} /><input aria-label="リッチメニュー画像の保存先" disabled={disabled} value={value.richMenu.pages[0]?.imageR2Key ?? ''} onChange={event => onChange({ ...value, richMenu: { ...value.richMenu, pages: [{ ...value.richMenu.pages[0], imageR2Key: event.target.value }, ...value.richMenu.pages.slice(1)] } })} /></>
    return null
  }
  return { default: Editor, freshDefinition, definitionName, definitionForName, definitionError, referenceCount: () => 0 }
})
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(window.location.search),  usePathname: () => '/hq/templates', useRouter: () => ({ push: vi.fn() }) }))
const template = { id: 't1', name: '来店済み', description: '説明', template_type: 'tag', revision: 3, updated_at: '2026-09-12T00:00:00Z' }
const detail = { template, definition: { schemaVersion: 1, tag: { name: '来店済み', folderId: 'f1' }, folders: [{ id: 'f1', name: '来店管理' }] } }
const accounts = [{ id: 'a', name: '銀座本店' }, { id: 'b', name: '横浜店' }]
const checked = (): Preflight => ({ preflightId: 'p1', expiresAt: new Date(Date.now() + 60_000).toISOString(), stores: accounts.map(a => ({ accountId: a.id, accountName: a.name, items: [{ sourceId: 'tag1', itemKind: 'tag', name: '来店済み', expectedRevision: 'v3', duplicate: true, allowedModes: a.id === 'a' ? ['overwrite','alias'] : ['alias'] }] })) })
const completed = { runId: 'p1', status: 'partial', stores: [{ accountId: 'a', status: 'succeeded', counts: { created: 1, overwritten: 2, aliased: 1 } }, { accountId: 'b', status: 'version_conflict', reason: '配布先で編集がありました。もう一度確認してください', counts: { created: 0, overwritten: 0, aliased: 0 } }] }
beforeEach(() => {
  clearToastsForTest()
  vi.resetAllMocks(); window.sessionStorage.clear(); window.history.replaceState(null, '', '/hq/templates?type=tag')
  calls.context.mockResolvedValue({ tenantId: 'tenant-a', actorId: 'owner' })
  calls.list.mockResolvedValue([template]); calls.accounts.mockResolvedValue(accounts); calls.get.mockResolvedValue(structuredClone(detail))
  calls.create.mockResolvedValue(structuredClone(detail)); calls.update.mockResolvedValue(structuredClone(detail))
  calls.preflight.mockImplementation(async () => checked()); calls.distribute.mockResolvedValue(completed); calls.result.mockResolvedValue(completed)
})
afterEach(cleanup)
// #743: happy-dom の Storage は Proxy で包まれており、vi.spyOn での
// メソッド上書きが無言で効かないことがある(設置しても読むと元に戻り、
// 直接呼んでも投げない)。「保存場所の故障」を spyOn で注入する書き方は、
// 故障が入らないまま成功表示へ進み、findBy の既定1秒を使い切って落ちる。
// 確実に効かせるため、window.sessionStorage ごと委譲つきの故障品に差し替え、
// 終わったら元の記述子へ戻す。差し替え直後に直接呼んで投がることを確かめ、
// 将来の無言無効化は即時の明示失敗にする(1秒待ちの謎失敗にしない)。
function replaceSessionStorage(overrides: Partial<Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>>) {
  const real = window.sessionStorage
  const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
  const fake = {
    get length() { return real.length },
    key: (index: number) => real.key(index),
    getItem: (key: string) => real.getItem(key),
    setItem: (key: string, value: string) => real.setItem(key, value),
    removeItem: (key: string) => real.removeItem(key),
    clear: () => real.clear(),
    ...overrides,
  }
  Object.defineProperty(window, 'sessionStorage', { value: fake, writable: true, configurable: true })
  if (window.sessionStorage !== (fake as unknown as Storage)) throw new Error('保存場所の差し替えが効きませんでした')
  for (const key of Object.keys(overrides) as ('getItem' | 'setItem' | 'removeItem')[]) {
    if (window.sessionStorage[key] !== fake[key]) throw new Error(`保存場所の故障(${key})が効きませんでした`)
  }
  return () => { if (original) Object.defineProperty(window, 'sessionStorage', original) }
}
async function list() { render(<><TemplateConsole type="tag" /><ToastHost /></>); fireEvent.click(await screen.findByLabelText('タグ「来店済み」の操作')) }
/*
 * 作成・編集・復元の入力欄は、表示・ラベル接続・操作可能になるまで待つ。
 * 「編集する」は読み込みの最中（保存中と同じ止め方）に編集画面を出すので、
 * 入力欄は一瞬だけ操作できない状態で現れる。混み合った機械ではその瞬間を
 * 見つけてしまい、操作できない入力欄への打ち込みは何も起きないため、
 * 打った名前が静かに捨てられていた。操作できるようになるまで待ってから打つ。
 */
async function editableControl(label: string | RegExp = 'ひな形の名前') {
  await screen.findByLabelText(label)
  return waitFor(() => {
    const control = screen.getByLabelText(label)
    expect(control.matches(':disabled, [aria-disabled="true"]')).toBe(false)
    return control
  })
}
async function chooseStores() {
  await list(); fireEvent.click(screen.getByRole('menuitem', { name: '配る' })); await screen.findByRole('checkbox', { name: '銀座本店' })
  expect((screen.getByRole('button', { name: '0アカウントの重複を確認' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: '表示中のアカウントをすべて選ぶ' })); fireEvent.click(screen.getByRole('button', { name: '2アカウントの重複を確認' })); await screen.findByRole('button', { name: 'この内容で2アカウントへ配る' })
}
function chooseMode(label: string, option: string) { fireEvent.click(screen.getByRole('button', { name: label, exact: true })); fireEvent.click(within(screen.getByRole('listbox')).getByRole('button', { name: new RegExp(`${option.split('：').pop()}$`) })) }
async function distribute() { await chooseStores(); chooseMode('一括の配布方法', '一括の配布方法：別名で作る'); fireEvent.click(screen.getByRole('button', { name: 'この内容で2アカウントへ配る' })); await screen.findByText(/新規 \d+件・上書き \d+件・別名 \d+件/); const dialog = await screen.findByRole('dialog', { name: '配った結果：来店済み' }); fireEvent.click(within(dialog).getAllByRole('button', { name: '閉じる', exact: true })[0]) }

describe('HQひな形の配布フロー', () => {
  it('参照再利用は上書きと区別し、既存を使用する選択と結果内訳を表示する', async () => {
    const p = checked()
    for (const store of p.stores) store.items = store.items.map(item => ({ ...item, operation: 'reuse', allowedModes: ['overwrite'] }))
    calls.preflight.mockResolvedValue(p)
    calls.distribute.mockResolvedValue({ runId: 'p1', status: 'completed', stores: accounts.map(a => ({ accountId: a.id, status: 'succeeded', counts: { created: 1, overwritten: 0, aliased: 0, reused: 1 } })) })
    await chooseStores()
    expect(screen.getAllByRole('button', { name: /の配布方法/ }).filter(b => b.getAttribute('aria-label') !== '一括の配布方法')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: '上書き', exact: true })).toBeNull()
    chooseMode('一括の配布方法', '一括の配布方法：別名で作る')
    expect((screen.getByRole('button', { name: 'この内容で2アカウントへ配る' }) as HTMLButtonElement).disabled).toBe(true)
    chooseMode('一括の配布方法', '一括の配布方法：上書き')
    fireEvent.click(screen.getByRole('button', { name: 'この内容で2アカウントへ配る' }))
    await screen.findByText(/新規 \d+件・上書き \d+件・別名 \d+件/)
    expect(calls.distribute.mock.calls[0][2].every((item: { mode: string }) => item.mode === 'overwrite')).toBe(true)
    expect(calls.distribute).toHaveBeenCalledWith('t1', 'p1', accounts.map(a => ({ accountId: a.id, sourceId: 'tag1', mode: 'overwrite' })))
  })
  it('画像登録中は保存を止め、確定した内容だけ保存できる', async () => {
    let finish!: (value: unknown) => void
    calls.uploadImage.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    render(<><TemplateConsole type="template" /><ToastHost /></>)
    fireEvent.click(await screen.findByRole('tab', { name: /カルーセル/ }))
    fireEvent.click((await screen.findAllByRole('button', { name: 'テンプレートを作る' }))[0])
    fireEvent.change(await screen.findByPlaceholderText('例：夏の定番5点'), { target: { value: '画像付き案内' } })
    fireEvent.change(await editableControl(/本文（/), { target: { value: '本文' } })
    fireEvent.change(await editableControl('画像を追加（ファイル）'), { target: { files: [new File(['fixture'], 'a.png', { type: 'image/png' })] } })
    await waitFor(() => expect((getPageAction({ name: '下書きを保存' }) as HTMLButtonElement).disabled).toBe(true))
    fireEvent.click(getPageAction({ name: '下書きを保存' })); expect(calls.create).not.toHaveBeenCalled()
    finish({ id:'image',kind:'image',filename:'a.png',mimeType:'image/png',sizeBytes:32,width:1040,height:1040,durationMs:null,r2Key:'hq-templates/tenant-a/uploads/a.png',publicUrl:'https://img.test/a.png',versionId:'image',versionNo:1,contentHash:'a'.repeat(64) })
    await waitFor(() => expect((getPageAction({ name: '下書きを保存' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalledOnce())
    expect(calls.create.mock.calls[0][0].definition.media[0].r2Key).toBe('hq-templates/tenant-a/uploads/a.png')
  })

  it('作成・編集で期待版と参照先を保ち、保存結果から次へ進む', async () => {
    await list(); fireEvent.click(screen.getByRole('menuitem', { name: '編集する' }))
    fireEvent.change(await editableControl(), { target: { value: '保存名' } }); fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await screen.findByRole('checkbox', { name: '銀座本店' })
    expect(calls.update).toHaveBeenCalledWith('t1', expect.objectContaining({ expectedRevision: 3, name: '保存名', definition: expect.objectContaining({ folders: detail.definition.folders }) }))
    expect(calls.distribute).not.toHaveBeenCalled()
  })
  it('新規作成は必須名が必要で、作成したひな形を表示する', async () => {
    await list(); fireEvent.click(screen.getAllByRole('button', { name: 'タグを作る' })[0])
    expect((await findPageAction({ name: '下書きを保存' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(await editableControl(), { target: { value: '来店済み' } }); fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await screen.findByText('ひな形を保存しました。'); expect(calls.create).toHaveBeenCalledOnce(); expect(calls.update).not.toHaveBeenCalled()
    expect(calls.create).toHaveBeenCalledWith(expect.objectContaining({ name: '来店済み' }), expect.any(String))
  })
  it('新規保存の応答不明は同じrequestIdと同じpayloadでだけ再送する', async () => {
    calls.create.mockRejectedValueOnce(new Error('network'))
    await list(); fireEvent.click(screen.getAllByRole('button', { name: 'タグを作る' })[0])
    fireEvent.change(await editableControl(), { target: { value: '最初の内容' } }); fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await screen.findByRole('button', { name: '前回の保存を再確認' })
    expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).value).toBe('最初の内容')
    expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).disabled).toBe(true)
    expect((await screen.findByLabelText('説明') as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull()
    expect(screen.queryByRole('button', { name: '下書きを保存' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '前回の保存を再確認' }))
    await screen.findByText('ひな形を保存しました。')
    expect(calls.create).toHaveBeenCalledTimes(2)
    expect(calls.create.mock.calls[1]).toEqual(calls.create.mock.calls[0])
    expect(calls.create.mock.calls[1][0]).toMatchObject({ name: '最初の内容' })
  })
  it.each([408, 500, 502, 504])('作成成功後にHTTP %sが届いても同じキーを再送し元の次段階へ進む', async status => {
    calls.create.mockRejectedValueOnce(Object.assign(new Error('結果不明'), { status, responseReceived: true, requestNotApplied: false }))
    await list(); fireEvent.click(screen.getAllByRole('button', { name: 'タグを作る' })[0])
    fireEvent.change(await editableControl(), { target: { value: '一度だけ作成' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await screen.findByRole('button', { name: '前回の保存を再確認' })
    expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '前回の保存を再確認' }))
    await screen.findByRole('checkbox', { name: '銀座本店' })
    expect(calls.create.mock.calls[1]).toEqual(calls.create.mock.calls[0])
    expect(calls.create).toHaveBeenCalledTimes(2)
  })
  it('結果不明後の拒否応答だけでは保存済みの可能性を解除しない', async () => {
    calls.create.mockRejectedValueOnce(Object.assign(new Error('gateway'), { status: 504, responseReceived: true, requestNotApplied: false }))
      .mockRejectedValueOnce(Object.assign(new Error('権限の再確認'), { status: 403, responseReceived: true, requestNotApplied: true }))
    await list(); fireEvent.click(screen.getAllByRole('button', { name: 'タグを作る' })[0])
    fireEvent.change(await editableControl(), { target: { value: '同じ依頼' } }); fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await screen.findByRole('button', { name: '前回の保存を再確認' }); fireEvent.click(screen.getByRole('button', { name: '前回の保存を再確認' }))
    await screen.findByText('この操作の権限がありません。統括の管理者に頼んでください。')
    expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '前回の保存を再確認' }))
    await screen.findByText('ひな形を保存しました。')
    expect(calls.create.mock.calls[1]).toEqual(calls.create.mock.calls[0]); expect(calls.create.mock.calls[2]).toEqual(calls.create.mock.calls[0])
  })
  it('最初の入力拒否が確定した場合は入力を直して新しいキーで保存できる', async () => {
    calls.create.mockRejectedValueOnce(Object.assign(new Error('入力を修正'), { status: 422, responseReceived: true, requestNotApplied: true }))
    await list(); fireEvent.click(screen.getAllByRole('button', { name: 'タグを作る' })[0])
    fireEvent.change(await editableControl(), { target: { value: '最初の名前' } }); fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await screen.findByRole('alert'); expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).disabled).toBe(false)
    fireEvent.change(await editableControl(), { target: { value: '修正した名前' } }); fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await screen.findByText('ひな形を保存しました。')
    expect(calls.create.mock.calls[1][1]).not.toBe(calls.create.mock.calls[0][1])
    expect(calls.create.mock.calls[1][0].name).toBe('修正した名前')
  })
  it('新規保存の二重操作を1回のPOSTに抑える', async () => {
    let finish!: (value: typeof detail) => void
    calls.create.mockReturnValue(new Promise(resolve => { finish = resolve }))
    await list(); fireEvent.click(screen.getAllByRole('button', { name: 'タグを作る' })[0])
    fireEvent.change(await editableControl(), { target: { value: '一回だけ' } })
    const save = getPageAction({ name: '下書きを保存' }); fireEvent.click(save); fireEvent.click(save)
    await waitFor(() => expect(calls.create).toHaveBeenCalledOnce())
    finish(structuredClone(detail)); await screen.findByText('ひな形を保存しました。')
  })
  it('選択なしと重複未選択を止め、一括設定は許可された項目だけに適用する', async () => {
    await chooseStores(); const execute = screen.getByRole('button', { name: 'この内容で2アカウントへ配る' }) as HTMLButtonElement
    expect(execute.disabled).toBe(true); chooseMode('一括の配布方法', '一括の配布方法：上書き'); expect(execute.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '横浜店の配布方法' }));
    expect(within(screen.getByRole('listbox')).queryByRole('button', { name: '上書き' })).toBeNull();
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('button', { name: '別名で作る' })); expect(execute.disabled).toBe(false)
    fireEvent.click(execute); fireEvent.click(execute); await screen.findByText(/新規 \d+件・上書き \d+件・別名 \d+件/)
    expect(calls.distribute).toHaveBeenCalledExactlyOnceWith('t1', 'p1', [{ accountId: 'a', sourceId: 'tag1', mode: 'overwrite' }, { accountId: 'b', sourceId: 'tag1', mode: 'alias' }])
  })
  it('有効期限切れの確認では実行できない', async () => {
    calls.preflight.mockResolvedValue({ ...checked(), expiresAt: '2020-01-01T00:00:00Z' }); await chooseStores()
    const expiredDialog = await screen.findByRole('dialog', { name: '確かめの期限が切れました' })
    fireEvent.click(within(expiredDialog).getByRole('button', { name: 'キャンセル' }))
    chooseMode('一括の配布方法', '一括の配布方法：別名で作る')
    expect((screen.getByRole('button', { name: 'この内容で2アカウントへ配る' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'この内容で2アカウントへ配る' }))
    expect(calls.distribute).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: '現在版を再確認' })).toBeTruthy()
  })
  it('配布先が差し替わった事前確認を拒否する', async () => {
    calls.preflight.mockResolvedValue({ ...checked(), stores: [{ ...checked().stores[0], accountId: 'outside' }] })
    await list(); fireEvent.click(screen.getByRole('menuitem', { name: '配る' })); await screen.findByRole('checkbox', { name: '銀座本店' }); fireEvent.click(screen.getByRole('checkbox', { name: '銀座本店' })); fireEvent.click(screen.getByRole('button', { name: '1アカウントの重複を確認' }))
    await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: /この内容で/ })).toBeNull(); expect(calls.distribute).not.toHaveBeenCalled()
  })
  it('失敗アカウントだけを新しい事前確認へ戻し、成功分は再送しない', async () => {
    await distribute(); expect(screen.getByText(/配布先で編集がありました/)).toBeTruthy()
    calls.preflight.mockResolvedValue({ ...checked(), preflightId: 'p2', stores: [checked().stores[1]] })
    fireEvent.click(screen.getByRole('button', { name: '失敗1アカウントを再確認' })); await screen.findByRole('button', { name: 'この内容で1アカウントへ配る' })
    expect(calls.preflight).toHaveBeenLastCalledWith('t1', ['b']); expect((screen.getByRole('button', { name: 'この内容で1アカウントへ配る' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('POST応答不達は既存結果をGETし、二重POSTしない', async () => {
    calls.distribute.mockRejectedValue(new Error('network')); await distribute()
    expect(calls.result).toHaveBeenCalledWith('t1', 'p1'); expect(calls.distribute).toHaveBeenCalledOnce(); expect(window.location.hash).toContain('run=p1')
  })
  it('復元も不達なら成功・失敗を断定せず、GET再確認だけを提供する', async () => {
    calls.distribute.mockRejectedValue(new Error('network')); calls.result.mockRejectedValue(new Error('network')); await chooseStores()
    chooseMode('一括の配布方法', '一括の配布方法：別名で作る'); fireEvent.click(screen.getByRole('button', { name: 'この内容で2アカウントへ配る' })); await screen.findByRole('alert')
    expect(screen.queryByText(/新規 \d+件・上書き \d+件・別名 \d+件/)).toBeNull(); expect(screen.queryByText('失敗1アカウントを再確認')).toBeNull()
    calls.result.mockResolvedValue(completed); fireEvent.click(screen.getByRole('button', { name: '結果を再確認' })); await screen.findByText(/新規 \d+件・上書き \d+件・別名 \d+件/); expect(calls.distribute).toHaveBeenCalledOnce()
  })
  it('再読み込みはURLの既存配布番号をGETで復元する', async () => {
    window.history.replaceState(null, '', '/hq/templates?type=tag#template=t1&run=p1'); render(<><TemplateConsole type="tag" /><ToastHost /></>)
    await screen.findByText(/新規 \d+件・上書き \d+件・別名 \d+件/); expect(calls.result).toHaveBeenCalledWith('t1', 'p1'); expect(calls.distribute).not.toHaveBeenCalled()
  })
  it.each([
    ['template', { schemaVersion: 1, template: { id: 'hq-authored-message', name: '来店お礼', category: 'general', messageType: 'text', messageContent: 'ありがとうございます', carouselActionsJson: null, carouselTapLimitMode: 'none', carouselTapLimitText: null, questionJson: null, questionStatus: 'draft' }, media: [] }, '配信する本文', 'ありがとうございます'],
    ['rich_menu', { schemaVersion: 1, richMenu: { id: 'rich-menu-main', name: 'アカウントメニュー', chatBarText: 'メニュー', size: 'large', defaultPageId: 'page-1', pages: [{ id: 'page-1', name: 'メイン', imageR2Key: 'hq-templates/tenant-a/menu.png', areas: [] }] } }, 'リッチメニュー画像の保存先', 'hq-templates/tenant-a/menu.png'],
    ['form', { schemaVersion: 1, form: { name: 'ご来店アンケート', description: null, fields: [{ name: 'question_1', label: '質問1', type: 'text', required: false }], layout: null, on_submit_tag_id: null, on_submit_scenario_id: null, save_to_metadata: true } }, null, null],
  ] as const)('%s を専用入力欄から作成できる', async (type, definition, fieldLabel, fieldValue) => {
    const name = type === 'template' ? '来店お礼' : type === 'rich_menu' ? 'アカウントメニュー' : 'ご来店アンケート'
    calls.list.mockResolvedValue([])
    calls.create.mockResolvedValue({ template: { ...template, id: `${type}-1`, name, template_type: type }, definition })
    render(<><TemplateConsole type={type} /><ToastHost /></>)
    fireEvent.click((await screen.findAllByRole('button', { name: type === 'template' ? 'テンプレートを作る' : type === 'rich_menu' ? 'メニューを作る' : 'フォームを作る' }))[0])
    if (type === 'form') {
      fireEvent.click(await screen.findByRole('button', { name: /1行で書く/ }))
      fireEvent.change(await editableControl('質問文'), { target: { value: '質問1' } })
      fireEvent.click(await screen.findByRole('tab', { name: '受付と見た目' }))
    }
    fireEvent.change(await editableControl(type === 'template' ? 'テンプレート名' : type === 'form' ? 'フォーム名' : 'ひな形の名前'), { target: { value: name } })
    if (fieldLabel && fieldValue) fireEvent.change(await editableControl(type === 'template' ? '本文' : fieldLabel), { target: { value: fieldValue } })
    fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await screen.findByText('ひな形を保存しました。')
    expect(calls.list).toHaveBeenCalledWith(type)
    expect(calls.create).toHaveBeenCalledWith(expect.objectContaining({ type, name, definition: expect.objectContaining(type === 'form' ? { form: expect.objectContaining({ name }) } : type === 'template' ? { template: expect.objectContaining({ name, messageContent: fieldValue }) } : { richMenu: expect.objectContaining({ name }) }) }), expect.any(String))
  })
  it('権限不足のAPI応答後に作成・配布を許可しない', async () => {
    calls.accounts.mockRejectedValue(new Error('操作する権限がありません。')); render(<><TemplateConsole type="tag" /><ToastHost /></>); await screen.findByRole('alert')
    expect((screen.getAllByRole('button', { name: 'タグを作る' })[0] as HTMLButtonElement).disabled).toBe(true); expect(calls.create).not.toHaveBeenCalled()
  })
  it('競合した編集は入力を保持し、自動で期待版を更新・再送しない', async () => {
    calls.update.mockRejectedValueOnce(Object.assign(new Error('別の担当者が更新しました。'), { status: 409, responseReceived: true })); await list(); fireEvent.click(screen.getByRole('menuitem', { name: '編集する' }))
    fireEvent.change(await editableControl(), { target: { value: '手元の編集' } }); fireEvent.click(getPageAction({ name: '下書きを保存' })); await screen.findByRole('alert')
    expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).value).toBe('手元の編集'); expect(calls.update).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '最新の内容を読み込む' }))
    await screen.findByDisplayValue('来店済み'); expect(calls.get).toHaveBeenCalledTimes(2); expect(calls.update).toHaveBeenCalledOnce()
  })
  it('選んだアカウントと許可された配布方法を確認後のPOSTへ渡す', async () => {
    await distribute()
    expect(calls.preflight).toHaveBeenCalledWith('t1', ['a', 'b'])
    expect(calls.distribute).toHaveBeenCalledWith('t1', 'p1', accounts.map(account => ({ accountId: account.id, sourceId: 'tag1', mode: 'alias' })))
  })
  it('空の確認や許可されない新規作成を実行対象にしない', () => {
    expect(resolvedItems({ ...checked(), stores: [] }, {})).toBeNull()
    const p = checked(); p.stores[0].items[0].duplicate = false; p.stores[0].items[0].allowedModes = ['alias']; expect(resolvedItems(p, {})).toBeNull()
  })
  it('通信不明の新規依頼は再読込と認証画面往復後も固定payloadと同じキーで回収する', async () => {
    calls.create.mockRejectedValueOnce(new Error('network'))
    await list(); fireEvent.click(screen.getAllByRole('button', { name: 'タグを作る' })[0])
    fireEvent.change(await editableControl(), { target: { value: '再読込する依頼' } })
    fireEvent.click(screen.getByRole('button', { name: '保存する' }))
    await screen.findByRole('button', { name: '前回の保存を再確認' })
    const original = calls.create.mock.calls[0]
    cleanup(); window.history.replaceState(null, '', '/login'); window.history.replaceState(null, '', '/hq/templates?type=tag')
    render(<><TemplateConsole type="tag" /><ToastHost /></>)
    await screen.findByRole('button', { name: '前回の保存を再確認' })
    expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).value).toBe('再読込する依頼')
    expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).disabled).toBe(true)
    expect(calls.create).toHaveBeenCalledTimes(1)
    calls.create.mockRejectedValueOnce(Object.assign(new Error('権限確認'), { requestNotApplied: true, status: 403 }))
    fireEvent.click(screen.getByRole('button', { name: '前回の保存を再確認' })); await screen.findByText('この操作の権限がありません。統括の管理者に頼んでください。')
    expect(window.sessionStorage.length).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: '前回の保存を再確認' }))
    await screen.findByRole('checkbox', { name: '銀座本店' })
    expect(calls.create.mock.calls[1]).toEqual(original); expect(calls.create.mock.calls[2]).toEqual(original)
    expect(window.sessionStorage.length).toBe(0)
  })
  it('POSTの応答待ちにページを離れても依頼が残り、別tenantや利用者では復元しない', async () => {
    calls.create.mockReturnValue(new Promise(() => {}))
    await list(); fireEvent.click(screen.getAllByRole('button', { name: 'タグを作る' })[0])
    fireEvent.change(await editableControl(), { target: { value: '元の組織' } }); fireEvent.click(getPageAction({ name: '下書きを保存' }))
    await waitFor(() => expect(calls.create).toHaveBeenCalledOnce())
    cleanup(); calls.context.mockResolvedValue({ tenantId: 'tenant-b', actorId: 'owner' })
    render(<><TemplateConsole type="tag" /><ToastHost /></>); await screen.findByLabelText('タグ「来店済み」の操作')
    expect(screen.queryByRole('button', { name: '前回の保存を再確認' })).toBeNull()
    cleanup(); calls.context.mockResolvedValue({ tenantId: 'tenant-a', actorId: 'another-owner' })
    render(<><TemplateConsole type="tag" /><ToastHost /></>); await screen.findByLabelText('タグ「来店済み」の操作')
    expect(screen.queryByRole('button', { name: '前回の保存を再確認' })).toBeNull()
    cleanup(); calls.context.mockResolvedValue({ tenantId: 'tenant-a', actorId: 'owner' })
    render(<><TemplateConsole type="tag" /><ToastHost /></>); await screen.findByRole('button', { name: '前回の保存を再確認' })
    expect(calls.create).toHaveBeenCalledOnce()
  })
  it('表示後に所属先が変われば新規POSTを停止する', async () => {
    await list(); fireEvent.click(screen.getAllByRole('button', { name: 'タグを作る' })[0])
    fireEvent.change(await editableControl(), { target: { value: '保存しない' } })
    calls.context.mockResolvedValue({ tenantId: 'tenant-b', actorId: 'owner' })
    fireEvent.click(getPageAction({ name: '下書きを保存' })); await screen.findByRole('alert')
    expect(calls.create).not.toHaveBeenCalled()
  })
  it.each(['success', 'definite-rejection'] as const)('記録消去が失敗すれば入力を固定し、安全な消去だけ再確認する: %s', async outcome => {
    if (outcome === 'definite-rejection') calls.create.mockRejectedValueOnce(Object.assign(new Error('入力を修正'), { requestNotApplied: true, status: 422 }))
    await list(); fireEvent.click(screen.getAllByRole('button', { name: 'タグを作る' })[0])
    fireEvent.change(await editableControl(), { target: { value: '消去待ちの内容' } })
    // #743: removeItem の spyOn 上書きは Proxy に飲まれて効かないため、
    // 最初の2回だけ投げて3回目から本物へ通す委譲品に差し替える。
    let removeFailures = 2
    const removeCalls: string[] = []
    const real = window.sessionStorage
    const restoreStorage = replaceSessionStorage({
      removeItem: (key: string) => {
        removeCalls.push(key)
        if (removeFailures > 0) { removeFailures -= 1; throw new Error('storage still unavailable') }
        real.removeItem(key)
      },
    })
    try {
      fireEvent.click(screen.getByRole('button', { name: '保存する' }))
      await screen.findByRole('button', { name: '前回の保存を再確認' })
      const original = calls.create.mock.calls[0]
      expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).value).toBe('消去待ちの内容')
      expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).disabled).toBe(true)
      expect((await screen.findByLabelText('説明') as HTMLTextAreaElement).disabled).toBe(true)
      expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull()
      expect(screen.queryByRole('button', { name: '下書きを保存' })).toBeNull()
      expect(screen.queryByText('ひな形を保存しました。')).toBeNull()
      expect(window.sessionStorage.length).toBe(1)
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '前回の保存を再確認' })) })
      await waitFor(() => expect(removeCalls).toHaveLength(2))
      expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).disabled).toBe(true)
      expect(window.sessionStorage.length).toBe(1)
      expect(calls.create).toHaveBeenCalledTimes(1)
      // 消去後は固定入力から TagEditor に掛け直される。表示文だけを待つと、
      // mock の初期化 effect が次の入力を古い名前に戻すことがある。
      // 非同期の再確認と描画・effect を act で終えてから入力する。
      const frozenName = await screen.findByLabelText('ひな形の名前')
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: '前回の保存を再確認' })) })
      if (outcome === 'success') await screen.findByRole('checkbox', { name: '銀座本店' })
      else await screen.findByText('前回の保存は受け付けられていません。内容を確認して保存し直してください。')
      expect(calls.create).toHaveBeenCalledTimes(1)
      expect(window.sessionStorage.length).toBe(0)
      expect(screen.queryByRole('button', { name: '前回の保存を再確認' })).toBeNull()
      if (outcome === 'definite-rejection') {
        // 「入力を固定」は解かれ、やり直せるようになる。
        await waitFor(() => {
          const input = screen.getByLabelText('ひな形の名前') as HTMLInputElement
          expect(input).not.toBe(frozenName)
          expect(input.disabled).toBe(false)
          expect(input.value).toBe('消去待ちの内容')
          expect((getPageAction({ name: '下書きを保存' }) as HTMLButtonElement).disabled).toBe(false)
        })
        const editable = await editableControl()
        expect(editable.matches(':disabled, [aria-disabled="true"]')).toBe(false)
        fireEvent.change(editable, { target: { value: '修正した新しい内容' } })
        expect((await screen.findByLabelText('ひな形の名前') as HTMLInputElement).value).toBe('修正した新しい内容')
        fireEvent.click(getPageAction({ name: '下書きを保存' }))
        await screen.findByText('ひな形を保存しました。')
        expect(calls.create.mock.calls[1][0].name).toBe('修正した新しい内容')
        expect(calls.create.mock.calls[1][1]).not.toBe(original[1])
      }
    } finally { restoreStorage() }
  })
  it('保存場所が使えなければ新規POSTを開始しない', async () => {
    await list(); fireEvent.click(screen.getAllByRole('button', { name: 'タグを作る' })[0])
    fireEvent.change(await editableControl(), { target: { value: '保存しない' } })
    // #743: setItem の spyOn 上書きは Proxy に飲まれて効かないため差し替える。
    const restoreStorage = replaceSessionStorage({ setItem: () => { throw new Error('quota') } })
    try {
      fireEvent.click(getPageAction({ name: '下書きを保存' })); await screen.findByRole('alert')
      expect(calls.create).not.toHaveBeenCalled()
    } finally { restoreStorage() }
  })
})

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [], selectedAccountId: null, selectedAccount: null, setSelectedAccountId: vi.fn(), loading: false }) }))

vi.mock('@/lib/staff-role', () => ({ useTenantWideAccess: () => true, useStaffRole: () => 'owner', canManageRole: () => true }))

vi.mock('@/components/shell/page-chrome', () => ({usePageTitle: () => {}, usePageCrumbs: () => {}}))

vi.mock('@/v8/hq-templates/tag-editor', () => ({ default: function TagEditor({ definition, saving, error, conflict, onReloadLatest, onCancel, onSave, onSaveDraft, notice }: { notice?: string; definition: TemplateDefinition & { tag: { name: string } }; saving: boolean; error?: string; conflict?: boolean; onReloadLatest?: () => void; onCancel: () => void; onSave: (v: TemplateDefinition) => void; onSaveDraft: (v: TemplateDefinition) => void }) {
  const [name, setName] = React.useState(definition.tag.name)
  React.useEffect(() => { setName(definition.tag.name) }, [definition])
  const next = { ...definition, tag: { ...definition.tag, name } }
  return <>{notice ? <p role="status">{notice}</p> : null}<label>ひな形の名前<input value={name} disabled={saving} onChange={e => setName(e.target.value)} /></label><label>説明<textarea disabled={saving} /></label>{error ? <p role="alert">{error}</p> : null}{conflict ? <button onClick={onReloadLatest}>最新の内容を読み込む</button> : null}<button disabled={saving} onClick={onCancel}>キャンセル</button><button disabled={saving || !name.trim()} onClick={() => onSaveDraft(next)}>下書きを保存</button><button disabled={saving || !name.trim()} onClick={() => onSave(next)}>保存する</button></>
} }))
