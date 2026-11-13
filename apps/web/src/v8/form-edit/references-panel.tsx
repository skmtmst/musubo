'use client'

import {
  STORE_INFORMATION_FIELDS,
  parseFormReferences,
  type FormBlock,
  type FormLayout,
  type FormReferenceDefinition,
  type MediaItem,
  type PublicFormReference,
} from '@line-crm/shared'
import { useEffect, useMemo, useState } from 'react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Dialog from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import MediaPickerDialog from '@/components/shared/media-picker-dialog'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { TextField } from '@/components/shared/text-field'
import { api } from '@/lib/api'
import type { MediaUsageImpact } from '../contents/media-usage-references'

/*
 * 公開用の参照（layout.references）の編集とプレビュー。
 * 画像ブロックには登録メディアの固定版を、本文・見出しには採用した共通情報の項目を対応付ける。
 * 保存は編集画面が layout ごと送るため、ここは参照の一覧だけを渡す。形が壊れたら保存前に止める。
 */

const FIELD_LABEL: Record<string, string> = {
  displayName: '店名',
  address: '住所',
  phone: '電話番号',
  hours: '営業時間',
  guideUrl: '案内のURL',
  mapUrl: '地図のURL',
}

function referenceKindText(kind: FormReferenceDefinition['kind']): string {
  return kind === 'image' ? '画像の固定版' : '共通情報'
}

function referenceSummary(reference: FormReferenceDefinition): string {
  if (reference.kind === 'image') return `第${reference.versionNo}版に固定`
  const names = Object.entries(reference.fields).map(([field, value]) => `${FIELD_LABEL[field] ?? field}（${value.varKey}）`)
  return names.length ? names.join('・') : '項目なし'
}

function referenceStatePresentation(state: PublicFormReference['state'] | null): { label: string; tone: 'neutral' | 'info' | 'warning' | 'caution' | 'success' | 'danger' } {
  if (state === null) return { label: '公開後に状態が出ます', tone: 'neutral' }
  switch (state) {
    case 'ready': return { label: '使える', tone: 'success' }
    case 'empty': return { label: '中身が空です', tone: 'warning' }
    case 'unavailable': return { label: '使えません', tone: 'danger' }
    case 'context_required': return { label: '店を選ぶと確かめられます', tone: 'info' }
    case 'retryable_error': return { label: '読み直してください', tone: 'danger' }
  }
}

function displayBlockLabel(block: FormBlock): string | null {
  switch (block.kind) {
    case 'image': return '画像'
    case 'heading': return `見出し「${block.text}」`
    case 'text': return `本文「${block.text.slice(0, 20)}」`
    case 'button': return `ボタン「${block.label}」`
    default: return null
  }
}

type Props = {
  readOnly?: boolean
  accountId: string | null
  layout: FormLayout
  references: FormReferenceDefinition[]
  /** 公開中の版の参照状態（blockId 引き）。未公開・未取得は null。 */
  states: Map<string, PublicFormReference> | null
  /** 無いときは一覧だけ見せる（変える操作は出さない）。 */
  onChangeReferences?: (next: FormReferenceDefinition[]) => void
}

export default function ReferencesPanel({ readOnly, accountId, layout, references, states, onChangeReferences }: Props) {
  const canEdit = !readOnly && onChangeReferences !== undefined
  const rows = useMemo(() => {
    const byBlock = new Map(references.map((reference) => [reference.blockId, reference]))
    return layout.sections.flatMap((section) =>
      section.blocks.flatMap((block) => {
        const label = displayBlockLabel(block)
        return label === null ? [] : [{ block, label, reference: byBlock.get(block.id) ?? null, state: states?.get(block.id) ?? null }]
      }),
    )
  }, [layout, references, states])
  const invalid = parseFormReferences(references) === null
  const [imageFlow, setImageFlow] = useState<{ blockId: string; alt: string } | null>(null)
  const [storeFlow, setStoreFlow] = useState<{ blockId: string; fields: Record<string, string> } | null>(null)

  return (
    <Card layout="vertical" aria-labelledby="fe-references-title">
      <div>
        <h2 id="fe-references-title">公開用の参照</h2>
        <p>画像には登録メディアの固定版を、本文・見出しには採用した共通情報の項目を対応付けます。公開時にこの版で固定されます。</p>
      </div>
      {invalid ? <Notice tone="danger">参照の形が正しくありません。保存する前に対応付けを直してください。</Notice> : null}
      {rows.length === 0 ? <p>対応付けられる表示ブロック（画像・見出し・本文・ボタン）がありません。</p> : null}
      <ul>
        {rows.map(({ block, label, reference, state }) => {
          const badge = referenceStatePresentation(state?.state ?? null)
          return (
            <li key={block.id}>
              <div>
                <span>{label}</span>
                {reference ? <span>{referenceKindText(reference.kind)}：{referenceSummary(reference)}</span> : <span>未設定</span>}
              </div>
              <div>
                <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                {canEdit ? (reference ? (
                  <Button type="button" onClick={() => onChangeReferences?.(references.filter((row) => row.blockId !== block.id))}>外す</Button>
                ) : block.kind === 'image' ? (
                  <Button type="button" onClick={() => setImageFlow({ blockId: block.id, alt: block.alt ?? '' })}>固定版を選ぶ</Button>
                ) : (
                  <Button type="button" onClick={() => setStoreFlow({ blockId: block.id, fields: {} })}>共通情報を選ぶ</Button>
                )) : null}
              </div>
            </li>
          )
        })}
      </ul>
      {imageFlow && canEdit ? (
        <ImageReferenceDialog
          accountId={accountId}
          initialAlt={imageFlow.alt}
          onClose={() => setImageFlow(null)}
          onConfirm={(mediaId, versionNo, alt) => {
            onChangeReferences?.([...references.filter((row) => row.blockId !== imageFlow.blockId), { blockId: imageFlow.blockId, kind: 'image', mediaId, versionNo, alt }])
            setImageFlow(null)
          }}
        />
      ) : null}
      {storeFlow && canEdit ? (
        <StoreReferenceDialog
          accountId={accountId}
          initial={storeFlow.fields}
          onClose={() => setStoreFlow(null)}
          onConfirm={(fields) => {
            const entries = Object.entries(fields).filter(([, varKey]) => varKey).map(([field, varKey]) => [field, { varKey }] as const)
            onChangeReferences?.([...references.filter((row) => row.blockId !== storeFlow.blockId), { blockId: storeFlow.blockId, kind: 'store_information', fields: Object.fromEntries(entries) }])
            setStoreFlow(null)
          }}
        />
      ) : null}
    </Card>
  )
}

function ImageReferenceDialog({ accountId, initialAlt, onClose, onConfirm }: { accountId: string | null; initialAlt: string; onClose: () => void; onConfirm: (mediaId: string, versionNo: number, alt: string) => void }) {
  const [picked, setPicked] = useState<MediaItem | null>(null)
  const [versions, setVersions] = useState<MediaUsageImpact['versions'] | null>(null)
  const [versionsError, setVersionsError] = useState(false)
  const [versionNo, setVersionNo] = useState<number | null>(null)
  const [alt, setAlt] = useState(initialAlt)

  const loadVersions = async (item: MediaItem) => {
    if (!accountId) return
    setPicked(item)
    setVersions(null)
    setVersionsError(false)
    try {
      const res = await api.media.deleteImpact(item.id, accountId)
      if (!res.success || !Array.isArray((res.data as MediaUsageImpact).versions)) throw new Error('versions unavailable')
      const list = (res.data as MediaUsageImpact).versions
      setVersions(list)
      const latest = [...list].sort((a, b) => b.versionNo - a.versionNo)[0]
      setVersionNo(latest?.versionNo ?? null)
    } catch {
      setVersionsError(true)
    }
  }

  if (!picked) {
    return <MediaPickerDialog open accountId={accountId} kind="image" onClose={onClose} onSelect={(item) => void loadVersions(item)} />
  }
  const canConfirm = versions !== null && !versionsError && versionNo !== null && alt.trim() !== ''
  return (
    <Dialog
      open
      title="画像の固定版を選ぶ"
      description={`${picked.filename}（共有の画像はそのまま使えます）`}
      confirmLabel="この版で固定する"
      confirmDisabled={!canConfirm}
      onConfirm={canConfirm && versionNo !== null ? () => onConfirm(picked.id, versionNo, alt.trim()) : undefined}
      onCancel={onClose}
    >
      {versionsError ? <ListState kind="error" title="版を読み込めませんでした" onRetry={() => void loadVersions(picked)} /> : null}
      {!versionsError && !versions ? <p>版を読み込んでいます…</p> : null}
      {versions ? (
        <>
          <Select aria-label="固定する版" value={versionNo == null ? '' : String(versionNo)} onChange={(value) => setVersionNo(Number(value))} options={versions.map((version) => ({ value: String(version.versionNo), label: `第${version.versionNo}版${version.isCurrent ? '（最新）' : ''}` }))} />
          <TextField aria-label="代替テキスト" value={alt} onChange={(event) => setAlt(event.target.value)} />
        </>
      ) : null}
    </Dialog>
  )
}

function StoreReferenceDialog({ accountId, initial, onClose, onConfirm }: { accountId: string | null; initial: Record<string, string>; onClose: () => void; onConfirm: (fields: Record<string, string>) => void }) {
  const [variables, setVariables] = useState<Array<{ varKey: string; name: string }> | null>(null)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [fields, setFields] = useState<Record<string, string>>(initial)

  useEffect(() => {
    if (!accountId) return
    let alive = true
    setVariables(null)
    setFailed(false)
    void (async () => {
      try {
        const res = await api.commonVars.list(accountId)
        if (!alive) return
        if (!res.success || !Array.isArray(res.data)) throw new Error('common vars unavailable')
        setVariables(res.data.map((row) => ({ varKey: row.varKey, name: row.name })))
      } catch {
        if (alive) setFailed(true)
      }
    })()
    return () => { alive = false }
  }, [accountId, reloadKey])

  if (!accountId) {
    return (
      <Dialog open title="共通情報を選ぶ" onCancel={onClose}>
        <p>店を選んでから対応付けてください。</p>
      </Dialog>
    )
  }

  return (
    <Dialog
      open
      title="共通情報を選ぶ"
      confirmLabel="この内容で対応付ける"
      onConfirm={failed || !variables ? undefined : () => onConfirm(fields)}
      onCancel={onClose}
    >
      {failed ? <ListState kind="error" title="共通情報を読み込めませんでした" onRetry={() => setReloadKey((value) => value + 1)} /> : null}
      {!failed && !variables ? <p>読み込んでいます…</p> : null}
      {variables ? STORE_INFORMATION_FIELDS.map((field) => (
        <div key={field}>
          <span>{FIELD_LABEL[field]}</span>
          <Select aria-label={FIELD_LABEL[field]} value={fields[field] ?? ''} onChange={(value) => setFields((previous) => ({ ...previous, [field]: value }))} options={[{ value: '', label: '使わない' }, ...variables.map((row) => ({ value: row.varKey, label: `${row.name}（${row.varKey}）` }))]} />
        </div>
      )) : null}
    </Dialog>
  )
}
