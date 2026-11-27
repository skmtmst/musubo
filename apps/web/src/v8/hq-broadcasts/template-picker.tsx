'use client'

/*
 * ③［テンプレートから選ぶ］の窓（絵 lLyFR の見出しの右）。共通の「作ってあるものを選ぶ窓」（EntityPickerDialog・
 * ①の  と同じ形）で、統括のメッセージのひな形を選ぶ。右に LINE での見え方のスマホ。
 * ［このテンプレートを使う］で、開いている吹き出しをそのひな形で置き換える。
 * まだ統括から送れない種類（質問・リサーチ・Flex）は使っても置き換えず、理由を窓の中に出す。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MessageTemplateDefinition } from '@line-crm/shared'
import { BubblePreview } from '@/components/broadcasts/broadcast-form'
import Button from '@/components/shared/button'
import { EntityPickerDialog, type EntityPickerFolder } from '@/components/shared/entity-picker'
import LinePreview from '@/components/shared/line-preview'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { hqTemplatesApi, type HqTemplateListItem } from '@/lib/hq-templates-api'
import { bubbleFromTemplate, previewBubbleOf } from './bubbles'
import { templatePickerItem } from './source-picker'

const KINDS = [
  { id: 'message', label: 'テキスト' }, { id: 'carousel', label: 'カルーセル' },
  { id: 'rich_message', label: 'リッチメッセージ' }, { id: 'question', label: '質問' },
  { id: 'coupon', label: 'クーポン' }, { id: 'research', label: 'リサーチ' },
]

function TemplatePreview({ id }: { id: string | null }) {
  const [node, setNode] = useState<ReactNode>(null)
  useEffect(() => {
    if (!id) { setNode(null); return }
    let current = true
    setNode(<ListState permissionScope="hq" kind="loading" />)
    void Promise.resolve().then(() => hqTemplatesApi.get(id)).then((detail) => {
      if (!current) return
      const read = bubbleFromTemplate(id, detail.definition as MessageTemplateDefinition)
      if ('error' in read) { setNode(<Notice tone="warn">{read.error}</Notice>); return }
      const bubble = previewBubbleOf(read.bubble, read.bubble.body)
      setNode(bubble ? <BubblePreview bubble={bubble} /> : null)
    }).catch(() => { if (current) setNode(<Notice tone="warn">見え方を読み込めませんでした。</Notice>) })
    return () => { current = false }
  }, [id])
  return <LinePreview fit empty={!id ? '候補を選ぶと見え方が出ます' : false}>{node}</LinePreview>
}

export default function HqTemplatePicker({ open, onClose, onPick, kind }: {
  kind?: string
  open: boolean
  onClose: () => void
  /** 読み込めたら null、読み込めない理由があれば文。 */
  onPick: (id: string) => Promise<string | null>
}) {
  const [list, setList] = useState<HqTemplateListItem[] | null>(null)
  const [folders, setFolders] = useState<EntityPickerFolder[]>([])
  const [foldersFailed, setFoldersFailed] = useState(false)
  const [folderRetry, setFolderRetry] = useState(0)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const picking = useRef(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open || list) return
    let current = true
    setLoadError(null)
    void hqTemplatesApi.listByKind().then((rows) => {
      if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || typeof row.name !== 'string')) throw new Error('invalid templates')
      if (current) setList(rows)
    }).catch((caught) => { if (current) setLoadError(caught) })
    return () => { current = false }
  }, [open, list, reload])

  useEffect(() => {
    if (!open) return
    let current = true
    setFolders([]); setFoldersFailed(false)
    void Promise.resolve().then(() => hqTemplatesApi.folders.list()).then((rows) => {
      if (!Array.isArray(rows)) throw new Error('invalid folders')
      if (current) setFolders(rows)
    }).catch(() => { if (current) setFoldersFailed(true) })
    return () => { current = false }
  }, [open, folderRetry])

  if (!open) return null
  const pick = async (id: string) => {
    if (picking.current) return
    picking.current = true
    setBusy(true); setError('')
    try {
      const why = await onPick(id)
      if (why) { setError(why); return }
      onClose()
    } catch {
      setError('テンプレートを読み込めませんでした。もう一度お試しください。')
    } finally {
      picking.current = false
      setBusy(false)
    }
  }
  return <EntityPickerDialog title="テンプレートから選ぶ" description="統括のテンプレートを選ぶと、開いているメッセージをその内容に置き換えます。" confirmLabel="このテンプレートを使う"
    items={(list ?? []).filter((t) => !kind || t.kind === kind).map(templatePickerItem)} folders={folders} foldersFailed={foldersFailed} categories={KINDS} busy={busy} error={error || undefined}
    listFooter={foldersFailed ? <Button size="compact" onClick={() => setFolderRetry((value) => value + 1)}>フォルダを読み直す</Button> : undefined}
    createHref="/hq/templates" createLabel="テンプレートを作る"
    state={loadError && !list ? <ListState permissionScope="hq" kind="error" error={loadError} onRetry={() => { setLoadError(null); setReload((value) => value + 1) }} />
      : !list ? <ListState permissionScope="hq" kind="loading" />
      : list.length === 0 ? <ListState permissionScope="hq" kind="empty" title="統括のテンプレートがまだありません。「テンプレート」で作ってください。" /> : undefined}
    preview={(item) => <TemplatePreview id={item?.id ?? null} />}
    onSelect={() => setError('')}
    onConfirm={(id) => pick(id)} onCancel={() => { setError(''); onClose() }} />
}
