'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { HqBroadcastRun, MessageTemplateDefinition } from '@line-crm/shared'
import { BubblePreview } from '@/components/broadcasts/broadcast-form'
import LinePreview from '@/components/shared/line-preview'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import SourcePickerDialog, { type SourcePickerItem, type SourcePickerFolder } from '@/components/shared/source-picker-dialog'
import { hqBroadcastsApi } from '@/lib/hq-broadcasts-api'
import { hqTemplatesApi, type HqTemplateListItem } from '@/lib/hq-templates-api'
import { bubbleFromTemplate, previewBubbleOf } from './bubbles'
import { formatDate as polishFormatDate } from '@/lib/format'

const KINDS = [
  { id: 'message', label: 'テキスト' }, { id: 'carousel', label: 'カルーセル' },
  { id: 'rich_message', label: 'リッチメッセージ' }, { id: 'question', label: '質問' },
  { id: 'coupon', label: 'クーポン' }, { id: 'research', label: 'リサーチ' },
]
const EXTRA_STATES = [{ id: 'sending', label: '送信中' }, { id: 'failed', label: '失敗' }, { id: 'cancelled', label: '取り消し済み' }, { id: 'stopped', label: '停止中' }]
const STATES = [{ id: 'sent', label: '送信済み' }, { id: 'scheduled', label: '予約中' }, { id: 'prepared', label: '下書き' }]

function dateLabel(value?: string | null) {
  return `更新 ${polishFormatDate(value, { style: 'day', fallback: '—' })}`
}

export function templatePickerItem(item: HqTemplateListItem): SourcePickerItem {
  const category = item.kind ?? 'message'
  return { id: item.id, name: item.name, category, categoryLabel: KINDS.find((kind) => kind.id === category)?.label ?? '種類不明', folderId: item.folder_id, updatedLabel: dateLabel(item.updated_at), tone: category === 'carousel' ? 'info' : category === 'coupon' ? 'success' : category === 'question' ? 'danger' : 'neutral' }
}

export function broadcastPickerItem(item: HqBroadcastRun): SourcePickerItem {
  const category = item.status === 'prepared' ? 'prepared' : item.status === 'scheduled' ? 'scheduled' : item.status
  return { id: item.id, name: item.title, category, categoryLabel: STATES.find((state) => state.id === category)?.label ?? EXTRA_STATES.find((state) => state.id === category)?.label ?? '状態不明', folderId: item.input.folderId, updatedLabel: '更新 —', tone: category === 'sent' ? 'success' : category === 'scheduled' ? 'info' : 'neutral' }
}

/** ①の2つの入口。共通の窓には候補・分類・見え方だけを渡す。 */
export default function HqBroadcastSourcePicker({ mode, initialId, onTemplate, onBroadcast, renderBroadcast, onClose }: {
  mode: 'template' | 'duplicate'
  initialId: string
  onTemplate: (item: SourcePickerItem, folders: SourcePickerFolder[]) => Promise<string | null>
  onBroadcast: (run: HqBroadcastRun) => void
  renderBroadcast: (run: HqBroadcastRun) => ReactNode
  onClose: () => void
}) {
  const [templates, setTemplates] = useState<HqTemplateListItem[]>([])
  const [runs, setRuns] = useState<HqBroadcastRun[]>([])
  const [folders, setFolders] = useState<SourcePickerFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState(initialId)
  const [preview, setPreview] = useState<ReactNode>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [previewBlocked, setPreviewBlocked] = useState(false)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let current = true
    setLoading(true); setLoadError(null)
    void (mode === 'template'
      ? Promise.all([hqTemplatesApi.listByKind(), hqTemplatesApi.folders.list()]).then(([list, folderList]) => { if (current) { setTemplates(list); setFolders(folderList) } })
      : Promise.all([hqBroadcastsApi.list(), hqBroadcastsApi.folders()]).then(([list, folderList]) => { if (current) { setRuns(list.data); setFolders(folderList.data) } }))
      .catch((caught) => { if (current) setLoadError(caught) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [mode, attempt])

  useEffect(() => {
    if (mode !== 'template' || !selected) return
    let current = true
    setPreview(null); setPreviewLoading(true); setPreviewError(''); setPreviewBlocked(false)
    void hqTemplatesApi.get(selected).then((detail) => {
      if (!current) return
      if (detail.template.template_type !== 'template') throw new Error('not-template')
      const read = bubbleFromTemplate(selected, detail.definition as MessageTemplateDefinition)
      if ('error' in read) { setPreviewError(read.error); setPreviewBlocked(true); return }
      const bubble = previewBubbleOf(read.bubble, read.bubble.body)
      setPreview(bubble ? <BubblePreview bubble={bubble} /> : null)
    }).catch(() => { if (current) setPreviewError('テンプレートの中身を読み込めませんでした。もう一度お試しください。') })
      .finally(() => { if (current) setPreviewLoading(false) })
    return () => { current = false }
  }, [mode, selected, previewAttempt])

  const items = mode === 'template' ? templates.map(templatePickerItem) : runs.map(broadcastPickerItem)
  const selectedRun = runs.find((run) => run.id === selected)
  const confirmSelection = async (id: string) => {
    setBusy(true); setError('')
    try {
      if (mode === 'template') {
        const item = items.find((candidate) => candidate.id === id)
        if (!item) return
        const why = await onTemplate(item, folders)
        if (why) { setError(why); return }
      } else {
        // 一覧で見た後に内容が変わっていても、最新の中身を写す。
        const detail = await hqBroadcastsApi.get(id)
        onBroadcast(detail.data)
      }
      onClose()
    } catch { setError('中身を読み込めませんでした。もう一度お試しください。') }
    finally { setBusy(false) }
  }

  return <SourcePickerDialog
    title={mode === 'template' ? 'テンプレートを選ぶ' : '過去の配信を選ぶ'}
    description={mode === 'template' ? '統括のテンプレートから1つ選びます。選ぶと右に LINE での見え方が出ます。' : '過去の配信から1つ選びます。中身を写し、宛先と日時は写しません。'}
    confirmLabel={mode === 'template' ? 'このテンプレートを使う' : 'この配信を写す'}
    initialId={initialId} items={items} folders={folders} categories={mode === 'template' ? KINDS : STATES}
    state={loading ? <ListState permissionScope="hq" kind="loading" /> : loadError ? <ListState permissionScope="hq" kind="error" error={loadError} onRetry={() => setAttempt((value) => value + 1)} /> : undefined}
    preview={<LinePreview fit empty={!selected ? '候補を選ぶと見え方が出ます' : false}>
      {mode === 'template' ? previewLoading ? <ListState permissionScope="hq" kind="loading" /> : previewError ? previewBlocked ? <Notice tone="warn">{previewError}</Notice> : <ListState permissionScope="hq" kind="error" error={previewError} onRetry={() => setPreviewAttempt((value) => value + 1)} /> : preview
        : selectedRun ? renderBroadcast(selectedRun) : null}
    </LinePreview>}
    confirmDisabled={mode === 'template' && (previewLoading || Boolean(previewError) || !preview)} busy={busy} error={error}
    onSelect={(id) => { if (mode === 'template' && id !== selected) { setPreview(null); setPreviewError(''); setPreviewLoading(true) }; setSelected(id); setError('') }} onConfirm={(id) => confirmSelection(id)} onCancel={onClose}
  />
}
