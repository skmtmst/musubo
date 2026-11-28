'use client'

import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

import { japaneseDetailOf } from '@/components/shared/api-error-message'

import { mediaLimitLabel } from '@/components/shared/media-slot'

import { OptionalBadge } from '@/components/shared/form-controls'

/*
 * 送り手（板 Asa6v・G8）：メッセージの送り主として、お客さまの LINE に出る名前と顔。
 * 一覧（アイコン・名前・使える人）と［送り手を追加］。口は lineSenderApi（Codex・GAP1）。
 * 名前は 20 文字まで・「LINE」「ライン」は使えない（サーバーが拒否し、理由をそのまま出す）。
 * 閲覧のみには追加・使わないを出さない。スタッフは自分用だけ、オーナー・管理者は全員用も作れる。
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { ImagePlus, Plus } from 'lucide-react'
import type { LineSender } from '@line-crm/shared'
import { lineSenderApi } from '@/lib/api/helpers/gap1'
import { ApiError } from '@/lib/api'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import Select from '@/components/shared/select'
import MediaPickerDialog from '@/components/shared/media-picker-dialog'
import type { MediaItem } from '@line-crm/shared'
import ListState from '@/components/shared/list-state'
import { RowMenu } from '@/components/shared/row-actions'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import styles from './senders-card.module.css'

const NAME_MAX = 20

export default function SendersCard({ accountId, accountName }: { accountId: string; accountName: string }) {
  const saveErrors = useSaveFormErrors()
  const role = useStaffRole()
  const canManage = canManageRole(role)
  const canAdd = role !== 'viewer' && role !== null
  const [senders, setSenders] = useState<LineSender[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<'all' | 'owner_only'>('all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const accountScope = useRef({ id: accountId, generation: 0 })
  if (accountScope.current.id !== accountId) accountScope.current = { id: accountId, generation: accountScope.current.generation + 1 }
  const loadedScope = useRef(-1)
  const loadRequest = useRef(0)
  const roleRef = useRef(role)
  roleRef.current = role
  const [stopping, setStopping] = useState<{ sender: LineSender; accountId: string; accountName: string; generation: number } | null>(null)
  /* アイコン（任意）：登録メディアの共通の選ぶ窓から。正方形の PNG/JPEG・1MB 以内はサーバーが確かめる。 */
  const [icon, setIcon] = useState<MediaItem | null>(null)
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const depth = useContext(OverlayDepthContext)
  const dirty = name !== '' || visibility !== 'all' || icon !== null
  const clearDraft = () => { setAdding(false); setName(''); setVisibility('all'); setIcon(null); setIconPickerOpen(false); setError('') }
  const guard = useUnsavedGuard({ dirty: adding && (dirty || busy), busy: adding && busy, onDiscard: clearDraft })

  const load = useCallback(async () => {
    const generation = accountScope.current.generation
    const request = ++loadRequest.current
    setFailed(false)
    try {
      const res = await lineSenderApi.list(accountId)
      if (!res.success) throw new Error('senders_failed')
      if (generation !== accountScope.current.generation || request !== loadRequest.current) return
      loadedScope.current = generation
      setSenders(res.data.filter((row) => row.status === 'active'))
    } catch {
      if (generation !== accountScope.current.generation || request !== loadRequest.current) return
      loadedScope.current = -1
      setFailed(true)
    }
  }, [accountId])
  useEffect(() => { setSenders(null); setStopping(null); setAdding(false); setName(''); setVisibility('all'); setIcon(null); setIconPickerOpen(false); void load() }, [load])

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed.length > NAME_MAX || busy) return
    setBusy(true)
    setError('')
    try {
      await lineSenderApi.create(accountId, { name: trimmed, visibility: canManage ? visibility : 'owner_only', ...(icon ? { iconMediaId: icon.id } : {}) }, idempotencyKey)
      setAdding(false)
      setName('')
      setVisibility('all')
      setIcon(null)
      setIdempotencyKey(crypto.randomUUID())
      await load()
    } catch (caught) {
      saveErrors.capture(caught)
      setError(japaneseDetailOf(caught) || '追加できませんでした。もう一度お試しください。')
    } finally {
      setBusy(false)
    }
  }
  const [stopReviewRequired, setStopReviewRequired] = useState(false)
  const stop = async () => {
    if (!stopping || busy || stopReviewRequired || stopping.generation !== accountScope.current.generation || !(canManageRole(roleRef.current) || (roleRef.current !== 'viewer' && roleRef.current !== null && stopping.sender.visibility === 'owner_only'))) return
    setBusy(true)
    try {
      await lineSenderApi.deactivate(stopping.accountId, stopping.sender.id, stopping.sender.version)
      if (stopping.generation === accountScope.current.generation) { setStopping(null); await load() }
      return true
    } catch {
      if (stopping.generation !== accountScope.current.generation) return false
      setStopReviewRequired(true)
      setError('使わない設定にできませんでした。閉じて最新の送り手を読み直し、状態を確認してください。')
      return false
    } finally {
      setBusy(false)
    }
  }

  return (<SaveErrorScope errors={saveErrors}>{(
    <Card variant="form" aria-labelledby="acd-senders">
      <CardHeader size="stacked" headingLevel={3} titleId="acd-senders" title="送り手"
        meta="メッセージの送り主として、名前とアイコンを切り替えられます（LINE の決まり：名前は 20 文字まで・公式アカウントの名前と並んで出ます）"
        action={canAdd ? <Button onClick={() => { setError(''); setAdding(true) }}><Plus size={16} aria-hidden="true" />送り手を追加</Button> : undefined} />
      {failed ? (
        <ListState kind="error" title="送り手を読み込めませんでした" onRetry={() => void load()} />
      ) : senders === null ? (
        <ListState kind="loading" title="送り手を読み込んでいます" />
      ) : (
        <ul className={styles.list}>
          <li className={styles.row}>
            <span className={styles.icon} aria-hidden="true">{accountName.slice(0, 1)}</span>
            <span className={styles.name}>店の名前（いつもの）</span>
            <span className={styles.who}>全員</span>
          </li>
          {senders.map((sender) => (
            <li key={sender.id} className={styles.row}>
              {sender.iconUrl
                // eslint-disable-next-line @next/next/no-img-element -- 送り手のアイコン（同じ店の登録メディア）
                ? <img width={32} height={32} src={sender.iconUrl} alt="" className={styles.icon} />
                : <span className={styles.icon} aria-hidden="true">{sender.name.slice(0, 1)}</span>}
              <span className={styles.name} title={sender.name}>{sender.name}{sender.iconMissing ? '（画像が見つかりません）' : ''}</span>
              <span className={styles.who}>{sender.visibility === 'all' ? '全員' : '本人だけ'}</span>
              {canManage || sender.visibility === 'owner_only' ? (
                <RowMenu label={`送り手「${sender.name}」の操作`} items={[{ id: 'stop', label: '使わない', tone: 'danger', onSelect: () => { if (loadedScope.current !== accountScope.current.generation) return; setError(''); setStopReviewRequired(false); setStopping({ sender, accountId, accountName, generation: accountScope.current.generation }) } }]} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={adding}
        dirty={dirty}
        title="送り手を追加"
        titleIcon={false}
        description="お客さまの LINE で、メッセージの上に出る名前と顔です"
        confirmLabel="追加"
        busy={busy}
        error={error || undefined}
        confirmDisabled={!name.trim() || name.trim().length > NAME_MAX}
        onConfirm={() => create()}
        onCancel={() => { if (!busy) clearDraft() }}
      >
        <div className={styles.iconRow}>
          <button type="button" className={styles.iconTile} onClick={() => setIconPickerOpen(true)} aria-label={icon ? '画像を変更する' : '画像を選択する'}>
            {icon?.url
              // eslint-disable-next-line @next/next/no-img-element -- 登録メディアの画像
              ? <img width={88} height={88} src={icon.url} alt="" className={styles.iconTileImage} />
              : <><ImagePlus size={20} aria-hidden="true" /><span>画像を選択する</span></>}
          </button>
          <div className={styles.iconText}>
            <strong>アイコン<OptionalBadge /></strong>
            <span>登録メディアから選び、正方形に切ります。{mediaLimitLabel('image/png,image/jpeg', 1024 * 1024)}。無いときはアカウントのアイコン</span>
            {icon ? <Button size="compact" variant="text" onClick={() => setIcon(null)}>外す</Button> : null}
          </div>
        </div>
        <div className={styles.nameWrap}><Field label="名前" required htmlFor="sender-name" count={{ value: name.trim().length, max: NAME_MAX }}>
          <SaveErrorField names={["name"]}><TextField id="sender-name" value={name} onChange={(e) => setName(e.target.value)}  placeholder="例：渋谷店 予約係" /></SaveErrorField>
        </Field></div>
        <div className={styles.nameNote}>
          <span>「LINE」「ライン」は名前に使えません</span>
        </div>
        {canManage ? (
          <SaveErrorField names={["visibility"]}><Select aria-label="使える人" size="full" value={visibility} onChange={(value) => setVisibility(value as 'all' | 'owner_only')}
            options={[{ value: 'all', label: '使える人：全員' }, { value: 'owner_only', label: '使える人：自分だけ' }]} /></SaveErrorField>
        ) : null}
      </ConfirmDialog>
      <OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={busy} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></OverlayDepthContext.Provider>
      <MediaPickerDialog open={iconPickerOpen} accountId={accountId} kind="image" title="アイコンを選ぶ" onClose={() => setIconPickerOpen(false)} onSelect={(item) => { setIcon(item); setIconPickerOpen(false) }} />
      <ConfirmDialog
        open={stopping !== null && stopping.generation === accountScope.current.generation}
        title={`「${stopping?.sender.name ?? ''}」を使わなくしますか？`}
        description="これから送るメッセージでは選べなくなります。すでに送った分の名前・アイコンはそのまま残ります。"
        confirmLabel="使わない"
        destructive
        busy={busy}
        confirmDisabled={stopReviewRequired} confirmDisabledReason="閉じて最新の送り手を確認してください。"
        error={error || undefined} onSuccess={() => setStopping(null)} onConfirm={() => stop()}
        onCancel={() => { if (busy) return; setStopping(null); setError(''); if (stopReviewRequired) void load(); setStopReviewRequired(false) }}
      >
        {stopping ? <OperationTargetSummary accounts={[{ id: stopping.accountId, name: stopping.accountName }]} /> : null}
      </ConfirmDialog>
    </Card>
  )}</SaveErrorScope>)
}
