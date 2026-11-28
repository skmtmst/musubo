// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import TemplateConsole from '@/test-utils/hq-template-console'
import type { Preflight, TemplateDefinition, TemplateType } from '@/lib/hq-templates-api'

/**
 * 配布の V8（板 ）。
 * - 配る2段階（アカウント・重複確認）の外枠に  を付ける
 * - 配っている間は「配布の進み具合」の箱を出す（数はまだ分からないので帯だけ）
 * 選び方・送り方・失敗の扱いは変えない。
 */

const calls = vi.hoisted(() => Object.fromEntries(['uploadImage','deleteImage','context','list','accounts','get','create','update','remove','duplicate','folderList','folderCreate','folderUpdate','folderRemove','preflight','distribute','result'].map(key => [key, vi.fn()])))
vi.mock('@/lib/hq-templates-api', async (original) => ({ ...await original<typeof import('@/lib/hq-templates-api')>(), TEMPLATE_TYPES: ['tag','template','rich_menu','form'], hqTemplatesApi: { listStats: async () => ({ thisMonthSentCount: 0, outdatedTemplateCount: 0 }), listByKind: () => calls.list('template'), kindCounts: async () => ({}), versions: async () => [], receivedVersions: async () => [], messageReferences: async () => [], ...calls, folders: { list:calls.folderList, create:calls.folderCreate, update:calls.folderUpdate, remove:calls.folderRemove } } }))
vi.mock('./template-definition-editor', () => {
  const freshDefinition = (type: TemplateType): TemplateDefinition => type === 'tag'
    ? { schemaVersion: 1, tag: { name: '', folderId: null }, folders: [] }
    : { schemaVersion: 1, tag: { name: '', folderId: null }, folders: [] } as TemplateDefinition
  const definitionName = (type: TemplateType, value: TemplateDefinition) => type === 'tag' && 'tag' in value ? value.tag.name : type==='template' && 'template' in value ? value.template.name : ''
  const definitionForName = (type: TemplateType, value: TemplateDefinition, _name: string, _description: string): TemplateDefinition => value
  const definitionError = () => null
  function Editor() { return null }
  return { default: Editor, freshDefinition, definitionName, definitionForName, definitionError, referenceCount: () => 0 }
})
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(window.location.search),  usePathname: () => '/hq/templates', useRouter: () => ({ push: vi.fn() }) }))

const template = { id: 't1', name: '来店済み', description: '説明', template_type: 'tag', revision: 3, updated_at: '2026-09-12T00:00:00Z' }
const detail = { template, definition: { schemaVersion: 1, tag: { name: '来店済み', folderId: 'f1' }, folders: [{ id: 'f1', name: '来店管理' }] } }
const accounts = [{ id: 'a', name: '銀座本店' }]
const checked = (): Preflight => ({ preflightId: 'p1', expiresAt: new Date(Date.now() + 60_000).toISOString(), stores: accounts.map(a => ({ accountId: a.id, accountName: a.name, items: [{ sourceId: 'tag1', itemKind: 'tag', name: '来店済み', expectedRevision: 'v3', duplicate: true, allowedModes: ['overwrite','alias'] }] })) })

beforeEach(() => {
  vi.resetAllMocks(); window.sessionStorage.clear(); window.history.replaceState(null, '', '/hq/templates?type=tag')
  calls.folderList.mockResolvedValue([{id: "classified", name: "案内", revision:1}]); calls.duplicate.mockResolvedValue(detail)
  calls.context.mockResolvedValue({ tenantId: 'tenant-a', actorId: 'owner' })
  calls.list.mockResolvedValue([template]); calls.accounts.mockResolvedValue(accounts); calls.get.mockResolvedValue(structuredClone(detail))
  calls.preflight.mockImplementation(async () => checked())
  calls.distribute.mockReturnValue(new Promise(() => {}))
})
afterEach(cleanup)

describe('配布の V8（meBRB）', () => {
  it('配る先を選び、重複の方法を確認して配っている間は進み具合を出す', async () => {
    render(<TemplateConsole type="tag" />)
    await screen.findByLabelText('タグ「来店済み」の操作')
    fireEvent.click(screen.getByLabelText('タグ「来店済み」の操作'))
    fireEvent.click(screen.getByRole('menuitem', { name: '配る' }))
    await screen.findByRole('checkbox', { name: '銀座本店' })
    expect(document.querySelector('[data-design-node="meBRB"]')).toBeTruthy()
    // 道具の段にフォルダの「まとめて選ぶ」の箱を置かない（表の見出しの箱と同じ役。ラベルの無い緑の四角に見えた）。
    expect(screen.queryByRole('checkbox', { name: 'すべてをまとめて選ぶ' })).toBeNull()
    expect(screen.getByRole('searchbox', { name: 'アカウントを検索' })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: '銀座本店' }))
    fireEvent.click(screen.getByRole('button', { name: '1アカウントの重複を確認' }))
    await screen.findByRole('button', {name: 'この内容で1アカウントへ配る'})
    expect(document.querySelector('[data-design-node="meBRB"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', {name: '一括の配布方法', exact: true})); fireEvent.click(within(screen.getByRole('listbox')).getByRole('button', {name:'別名で作る'}))
    fireEvent.click(screen.getByRole('button', { name: 'この内容で1アカウントへ配る' }))
    const progress = await screen.findByLabelText('配布の進み具合')
    expect(progress.textContent).toMatch(/配布番号：p1/)
    expect(calls.distribute).toHaveBeenCalledOnce()
  })

  it('分類を読み込み、一覧から複製の受付番号を渡す', async () => {
    render(<TemplateConsole type="tag" />)
    await screen.findAllByRole('button', {name:/案内/})
    fireEvent.click(await screen.findByLabelText('タグ「来店済み」の操作'))
    fireEvent.click(screen.getByRole('menuitem',{name:'複製する'}))
    await screen.findByText('ひな形を複製しました。')
    expect(calls.duplicate).toHaveBeenCalledWith('t1','来店済みのコピー',3,expect.any(String))
  })

  it('配り先の本文を原本から変え、重複確認に一緒に渡す',async()=>{
    const item={...template,template_type:'template',name:'ご案内'}
    const definition={schemaVersion:1,template:{id:'hq-authored-message',name:'ご案内',messageType:'text',messageContent:'原本の案内'},media:[]}
    calls.list.mockResolvedValue([item]); calls.get.mockResolvedValue({template:item,definition})
    calls.preflight.mockResolvedValue({...checked(),stores:[{...checked().stores[0],textOverride:'本店の案内'}]})
    render(<TemplateConsole type="template"/>)
    fireEvent.click(await screen.findByLabelText('テンプレート「ご案内」の操作'))
    fireEvent.click(screen.getByRole('menuitem',{name:'配る'}))
    await screen.findByRole('checkbox',{name:'銀座本店'}); fireEvent.click(screen.getByRole('checkbox',{name:'銀座本店'})); fireEvent.click(screen.getByRole('button',{name:'本文を変更する'})); const input=await screen.findByLabelText('銀座本店に配る本文'); expect((input as HTMLTextAreaElement).value).toBe('原本の案内')
    fireEvent.change(input,{target:{value:'本店の案内'}})
    fireEvent.click(screen.getByRole('button',{name:'1アカウントの重複を確認'}))
    await screen.findByRole('button', {name:'この内容で1アカウントへ配る'})
    expect(calls.preflight).toHaveBeenCalledWith('t1',['a'],[{accountId:'a',text:'本店の案内'}])
  })

  it('行の「…」は矢印キーで項目を移動できる', async () => {
    render(<TemplateConsole type="tag" />)
    fireEvent.click(await screen.findByLabelText('タグ「来店済み」の操作'))
    const edit = await screen.findByRole('menuitem', { name: '編集する' })
    const distribute = screen.getByRole('menuitem', { name: '配る' })
    edit.focus()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(distribute)
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(edit)
  })
})

vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [], selectedAccountId: null, selectedAccount: null, setSelectedAccountId: vi.fn(), loading: false }) }))

vi.mock('@/lib/staff-role', () => ({ useTenantWideAccess: () => true, useStaffRole: () => 'owner', canManageRole: () => true }))

vi.mock('@/components/shell/page-chrome', () => ({usePageTitle: () => {}, usePageCrumbs: () => {}}))
