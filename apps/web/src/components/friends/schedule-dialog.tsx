'use client'

import { jstCalendar as japanCalendar } from '@/lib/jst-datetime'
/*
 * ★V8  予約して送るの小窓。友だち一覧の行の「…」から開き、受信箱を開かずに予約できる。
 * 文と日時を `POST /api/chats/:id/schedule` で予約する（友だちIDで引ける・二重押し防止の鍵つき）。
 * 画像と文は受信箱と同じ順で予約し、成功した分だけ入力から外す。
 * 絵：幅 520・余白 20・間 12。送るもの（テンプレートから入れる）→ 送る日時の札 → 注意 → 真ん中にキャンセル・予約。
 */
import { useEffect, useRef, useState } from 'react'
import { Clock3, FileText, ImagePlus } from 'lucide-react'
import { withHonorific, type MediaItem, type Template } from '@line-crm/shared'
import { api } from '@/lib/api'
import { IdempotencyKeyStore } from '@/lib/idempotency-key-store'
import { scheduledMessageInputReason } from '@/lib/scheduled-message-input'
import { EntityKindDialog } from '@/components/shared/entity-picker-sources'
import Button from '@/components/shared/button'
import DateTimeField from '@/components/shared/date-time-field'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { TextArea } from '@/components/shared/text-field'
import MediaPickerDialog from '@/components/shared/media-picker-dialog'
import MediaSlot, { mediaLimitLabel } from '@/components/shared/media-slot'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import styles from './schedule-dialog.module.css'

/* 日本時間の時計。サーバも端末も日本時間のつもりで扱う。 */

/* 日本時間での「日付+時刻」を作る（`Date.UTC` でずらして持つ）。 */
function jstDateTime(offsetDays: number, hour: number, minute: number): Date {
  const jstNow = japanCalendar()
  return new Date(Date.UTC(jstNow.getUTCFullYear(), jstNow.getUTCMonth(), jstNow.getUTCDate() + offsetDays, hour, minute))
}

/* 次の月曜10時。今日が月曜で10時前なら今日。 */
function nextMonday10(): Date {
  const jstNow = japanCalendar()
  const day = jstNow.getUTCDay()
  const pastTen = jstNow.getUTCHours() * 60 + jstNow.getUTCMinutes() >= 10 * 60
  let offset = (8 - day) % 7
  if (offset === 0 && pastTen) offset = 7
  return jstDateTime(offset, 10, 0)
}

function toLocalInput(date: Date): string {
  return date.toISOString().slice(0, 16)
}

/** 予約ボタンの文字（絵：「10/2 9:00 に予約」。時は0を付けない）。 */
export function formatReserveLabel(value: string): string {
  const [date, time] = value.split('T')
  const [, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':')
  return `${month}/${day} ${Number(hour)}:${minute} に予約`
}

type ScheduleChoice = 'tomorrow9' | 'tomorrow13' | 'monday10' | 'custom'

export default function ScheduleDialog({ friendId, friendName, accountId, onClose, onReserved }: {
  friendId: string
  friendName: string
  accountId: string | null
  onClose: () => void
  onReserved: () => void
}) {
  const scope = useRef({ accountId, friendId })
  if (scope.current.accountId !== accountId || scope.current.friendId !== friendId) scope.current = { accountId, friendId }
  const opened = useRef(scope.current)
  const closed = useRef(false)
  const isCurrent = () => !closed.current && opened.current === scope.current
  const scopeChanged = opened.current !== scope.current
  const [content, setContent] = useState('')
  const [templates, setTemplates] = useState<Template[]>([])
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false)
  const templateAnchor = useRef<HTMLButtonElement>(null)
  const [choice, setChoice] = useState<ScheduleChoice>('tomorrow9')
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const [image, setImage] = useState<MediaItem | null>(null)
  const [imagePickerOpen, setImagePickerOpen] = useState(false)
  const [error, setError] = useState('')
  const keysRef = useRef(new IdempotencyKeyStore())

  useEffect(() => {
    setTemplates([])
    void api.templates.list(undefined, accountId ?? undefined).then((res) => {
      if (isCurrent() && res.success) {
        setTemplates((res.data as unknown as Template[]).filter((t) => t.messageType === 'text'))
      }
    })
  }, [accountId])

  const presets: Array<{ key: Exclude<ScheduleChoice, 'custom'>; label: string; value: string }> = [
    { key: 'tomorrow9', label: '明日 9:00', value: toLocalInput(jstDateTime(1, 9, 0)) },
    { key: 'tomorrow13', label: '明日 13:00', value: toLocalInput(jstDateTime(1, 13, 0)) },
    { key: 'monday10', label: '月曜 10:00', value: toLocalInput(nextMonday10()) },
  ]
  const scheduledAt = choice === 'custom' ? custom : presets.find((p) => p.key === choice)?.value ?? ''
  const disabledReason = scheduledMessageInputReason(content, Boolean(image), scheduledAt)

  useEffect(() => { setImage(null); setImagePickerOpen(false) }, [accountId, friendId])
  useEffect(() => { if (scopeChanged) { closed.current = true; onClose() } }, [scopeChanged, onClose])
  useEffect(() => { closed.current = false; return () => { closed.current = true } }, [])

  const reserve = async () => {
    if (!isCurrent() || lock.current) return
    if (!content.trim() && !image) {
      setError('送るものを入力してください')
      return
    }
    if (!scheduledAt) {
      setError('送る日時を選んでください')
      return
    }
    setBusy(true)
    lock.current = true
    setError('')
    let completed = 0
    try {
      const items: Array<{ messageType?: 'image'; content: string; done: () => void }> = []
      if (image) items.push({ messageType: 'image', content: JSON.stringify({ originalContentUrl: image.url, previewImageUrl: image.url }), done: () => setImage(null) })
      if (content.trim()) items.push({ content: content.trim(), done: () => setContent('') })
      for (const item of items) {
        const input = { content: item.content, ...(item.messageType ? { messageType: item.messageType } : {}), scheduledAt: `${scheduledAt}:00+09:00` }
        const signature = JSON.stringify({ friendId, accountId, ...input })
        const result = await api.chats.schedule(friendId, input, keysRef.current.get(signature))
        if (!isCurrent()) return
        if (!result.success) {
          setError(result.error || '残っている送るものを予約できませんでした。もう一度お試しください。')
          return
        }
        keysRef.current.clear(signature)
        item.done()
        completed += 1
      }
      closed.current = true
      onReserved()
      onClose()
    } catch {
      // 結果が分からない失敗では鍵を残し、同じ予約の再試行を二重に作らない。
      // 先に予約できた分は入力から外してあるので、何件済んだかを添える（部分成功）。
      if (isCurrent()) setError(`${completed ? `${completed}件は予約済みです。残りを` : ''}予約できませんでした。通信状態を確認して、もう一度お試しください。`)
    } finally {
      lock.current = false
      if (isCurrent()) setBusy(false)
    }
  }

  if (scopeChanged) return null
  return (
    <Dialog
      open
      designWidth={520}
      footerAlign="center"
      title={`${withHonorific(friendName)}に予約して送る`}
      busy={busy}
      error={error}
      designNode="MyJP7"
      onCancel={() => { closed.current = true; onClose() }}
    >
      <OperationTargetSummary accounts={[{ id: accountId ?? '' }]} />
      <div className={styles.body}>
        <div className={styles.group}>
          <p className={styles.label}>送るもの</p>
          <div>
            <TextArea
              density="compact"
              aria-label="送るもの"
              rows={3}
              value={content}
              disabled={busy}
              onChange={(event) => setContent(event.target.value)}
              placeholder="送る文を書きます"
            />
          </div>
          <div className={styles.row}>
            <Button
              ref={templateAnchor}
              type="button"
              aria-haspopup="dialog"
              disabled={busy || templates.length === 0}
              title={templates.length === 0 ? '文のテンプレートがありません' : undefined}
              onClick={() => setTemplateMenuOpen((value) => !value)}
            >
              <FileText size={16} aria-hidden="true" />テンプレートを選択
            </Button>
            <Button type="button" icon={<ImagePlus aria-hidden="true" />} disabled={busy} onClick={() => setImagePickerOpen(true)}>画像</Button>
            {templateMenuOpen ? <EntityKindDialog kind="template" options={templates} confirmLabel="この文を入れる"
              onCancel={() => setTemplateMenuOpen(false)}
              onConfirm={(id) => { const picked = templates.find((template) => template.id === id); if (picked) setContent(picked.messageContent); setTemplateMenuOpen(false) }} /> : null}
          </div>
          {image ? <MediaSlot title="予約する画像" size="compact" value={image.url} previewAlt={image.filename} disabled={busy} onMediaPick={() => setImagePickerOpen(true)} onRemove={() => setImage(null)} /> : null}
          {imagePickerOpen ? <MediaPickerDialog open accountId={accountId} kind="image" title="予約する画像を選ぶ" description={`${mediaLimitLabel('image/jpeg,image/png', 1024 * 1024)}。画像のあとに文が届きます。`} onClose={() => setImagePickerOpen(false)} onSelect={(item) => {
            if (item.kind !== 'image' || !['image/jpeg', 'image/png'].includes(item.mimeType) || item.sizeBytes > 1024 * 1024 || !item.url) { setError(`${mediaLimitLabel('image/jpeg,image/png', 1024 * 1024)}の画像を選んでください。`); return }
            setImage(item); setImagePickerOpen(false); setError('')
          }} /> : null}
        </div>
        <div className={styles.group}>
          <p className={styles.label}>送る日時</p>
          <div className={styles.chips} role="group" aria-label="送る日時">
            {presets.map((preset) => (
              <button key={preset.key} type="button" disabled={busy} className={styles.chip} aria-pressed={choice === preset.key} onClick={() => setChoice(preset.key)}>
                {preset.label}
              </button>
            ))}
            <button type="button" disabled={busy} className={styles.chip} aria-pressed={choice === 'custom'} onClick={() => setChoice('custom')}>
              日時を決める
            </button>
          </div>
          {choice === 'custom' ? <DateTimeField disabled={busy} aria-label="送る日時を決める" value={custom} onChange={setCustom} /> : null}
        </div>
        <p className={styles.note}>受信箱の会話にも「これから送る予約」として出ます。</p>
        {/* 絵は注意の下 12 にボタンが並ぶ（窓の下の線・帯なし）。共通の窓の帯は余白が 24 あるので、本文の続きに置く。 */}
        <DialogActions padding="none">
          <Button type="button" onClick={onClose} disabled={busy}>キャンセル</Button>
          <Button type="button" variant="primary" icon={<Clock3 aria-hidden="true" />} onClick={() => void reserve()} disabled={busy || Boolean(disabledReason)} disabledReason={disabledReason} busy={busy}>
            {scheduledAt ? formatReserveLabel(scheduledAt) : '日時を選んで予約'}
          </Button>
        </DialogActions>
      </div>
    </Dialog>
  )
}
