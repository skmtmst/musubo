'use client'
import { SettingsFormRow } from '@/components/shared/settings-form-card'

import { Suspense, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Check, Send } from 'lucide-react'
import { usePageTitle } from '@/components/shell/page-chrome'
import { CreatePage } from '@/components/templates'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import Button from '@/components/shared/button'
import DateTimeField from '@/components/shared/date-time-field'
import { TextField } from '@/components/shared/text-field'
import Dialog from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import TargetMissing from '@/components/shared/target-missing'
import { isoToLocalInput, localInputToIso, noticeMessage, previewErrorMessage, useChangeReview, type SlotEdit } from './change-review-model'
import { jstDay, jstTime } from './shared'
import styles from './change-review.module.css'
import { Field } from '@/components/shared/form-controls'
import { emptyValue } from '@/components/shared/empty-value'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField } from '@/components/shared/save-form-errors'

/*
 * ★V8 イベント予約「変更の確認」（Pencil 、確かめる窓 ）。
 *
 * 型（CreatePage）に、左の「開催回（どの回を変えるか選ぶ表）」「変える内容」と、
 * 右の「影響の確認」「日時・会場を変えるときの約束」をはめる。下の帯は キャンセル・変えてお知らせする。
 * 処理は今の作りと同じ口（change-review-model.ts の写し）。V8 は入力を変えると自動で影響を確かめる。
 */

function validCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function slotValidationErrors(
  edit: SlotEdit | null | undefined,
  impactErrors: readonly string[] | undefined,
): { startError: string; endError: string; capacityError: string } {
  if (!edit) return { startError: '', endError: '', capacityError: '' }
  const startError = !localInputToIso(edit.startsAt) ? '開始日時を選んでください' : ''
  const endError = !localInputToIso(edit.endsAt) || edit.endsAt <= edit.startsAt ? '終了日時は開始日時より後にしてください' : ''
  const capacityError = edit.capacity.trim() && (!Number.isInteger(Number(edit.capacity)) || Number(edit.capacity) < 1)
    ? '定員は1以上の数で入れてください'
    : impactErrors?.includes('slot_capacity_below_bookings')
      ? '定員を、すでに申し込まれている人数より下げられません'
      : ''
  return { startError, endError, capacityError }
}

/** datetime-local（日本時間の壁時計）→「10:30」。 */
function localTime(local: string): string {
  return local.split('T')[1]?.slice(0, 5) ?? emptyValue('unknown')
}
/** datetime-local → 「10/12（月）」。 */
function localDay(local: string): string {
  const date = local.split('T')[0]
  return date ? jstDay(`${date}T00:00:00+09:00`) : emptyValue('unknown')
}

export default function EventChangeReviewV8() {
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <ChangeReviewEntry />
    </Suspense>
  )
}

function ChangeReviewEntry() {
  const id = useSearchParams().get('id')
  if (!id) {
    return (
      <TargetMissing
        kind="unspecified"
        title="確認するイベントが指定されていません"
        description="一覧から、変更を確認するイベントを選び直してください。"
        backHref="/events"
        backLabel="イベント一覧へ戻る"
      />
    )
  }
  return <ChangeReview eventId={id} />
}

function ChangeReview({ eventId }: { eventId: string }) {
  usePageTitle('変更の確認')
  const {
    selectedAccountId, status, event, slotList, edits, setEdits, venueName, setVenueName, venueUrl, setVenueUrl,
    preview, previewBusy, previewError, reason, setReason, applyBusy, applyError, applied, isPublished,
    refresh, touchEdits, runApply,
  } = useChangeReview(eventId)
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null)
  const [venueOpen, setVenueOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [reasonError, setReasonError] = useState('')
  const focusTarget = useRef<string | null>(null)
  useEffect(() => {
    setSelectedSlotId(null)
    setVenueOpen(false)
    setConfirmOpen(false)
    setReasonError('')
  }, [eventId, selectedAccountId])
  useEffect(() => {
    const id = focusTarget.current
    if (!id) return
    focusTarget.current = null
    const field = document.getElementById(id)
    field?.focus()
    field?.scrollIntoView({ block: 'center' })
  }, [reasonError])
  const description = '開催回の日時・定員・受付を変えます。変える前に、申し込んでいる人への影響を確かめます。'

  if (!selectedAccountId || status !== 'ready' || !event) {
    return (
      <CreatePage
        boardId="hmr2P"
        title="変更の確認"
        help={description}
        footerActions={<></>}
      >
        {!selectedAccountId ? (
          <ListState kind="empty" title="上のバーでLINE公式アカウントを選んでください" />
        ) : status === 'loading' ? (
          <ListState kind="loading" />
        ) : status === 'error' ? (
          <ListState
            kind="error"
            description="イベントは消えていません。開き直しても直らない場合はエラー報告へ。"
            action={<Button onClick={() => refresh()} busyLabel="処理中…">開き直す</Button>}
          />
        ) : (
          <TargetMissing
            kind="not-found"
            title="イベントが見つかりません"
            description="削除されたか、別のアカウントのイベントです。一覧から選び直してください。"
            backHref="/events"
            backLabel="イベント一覧へ戻る"
          />
        )}
      </CreatePage>
    )
  }

  const activeSlot = slotList.find((slot) => slot.id === selectedSlotId) ?? slotList[0] ?? null
  const activeEdit: SlotEdit | null = activeSlot
    ? (edits[activeSlot.id] ?? { startsAt: '', endsAt: '', capacity: '', isActive: true })
    : null
  const impactBySlot = new Map((preview?.impacts ?? []).map((impact) => [impact.slot_id, impact]))
  const updateActive = (patch: Partial<SlotEdit>) => {
    if (!activeSlot || !activeEdit) return
    setEdits((current) => ({ ...current, [activeSlot.id]: { ...activeEdit, ...patch } }))
    touchEdits()
  }

  /* 日時が動いた最初の回（右の「変える前 → 変えた後」と送る文の見本に使う）。 */
  const moved = slotList.map((slot) => ({ slot, edit: edits[slot.id] })).find(({ slot, edit }) =>
    edit && (edit.startsAt !== isoToLocalInput(slot.starts_at) || edit.endsAt !== isoToLocalInput(slot.ends_at)))
  const beforeRange = moved ? `${jstTime(moved.slot.starts_at)}〜${jstTime(moved.slot.ends_at)}` : ''
  const afterRange = moved?.edit ? `${localTime(moved.edit.startsAt)}〜${localTime(moved.edit.endsAt)}` : ''
  const sampleText = moved?.edit
    ? `イベントの内容が変更になりました。イベント：${event.name}　日時：${localDay(moved.edit.startsAt)} ${afterRange}（変更前 ${jstDay(moved.slot.starts_at)} ${beforeRange}）`
    : ''
  const notes = (preview?.impacts ?? []).flatMap((impact) => [
    ...impact.errors.filter((code) => code !== 'slot_capacity_below_bookings' || impact.slot_id !== activeSlot?.id).map((code) => previewErrorMessage(code)),
    ...impact.notices.map((code) => noticeMessage(code)),
  ])
  const reasonMissing = isPublished && !reason.trim()
  const { startError, endError, capacityError } = slotValidationErrors(
    activeEdit,
    activeSlot ? impactBySlot.get(activeSlot.id)?.errors : undefined,
  )
  const anySlotHasError = slotList.some((slot) => {
    const edit = edits[slot.id]
    if (!edit) return false
    const errs = slotValidationErrors(edit, impactBySlot.get(slot.id)?.errors)
    return Boolean(errs.startError || errs.endError || errs.capacityError)
  })
  const confirmedCount = validCount(preview?.total_confirmed)
  const waitingCount = validCount(preview?.total_waiting)
  const canApply = Boolean(preview && !preview.blocked && !applyBusy && !startError && !endError && !capacityError && !anySlotHasError)
  const requestConfirm = () => {
    if (!canApply) return
    if (reasonMissing) {
      focusTarget.current = 'ev-cr-reason'
      setReasonError('変える理由を入れてください')
      // 同じ誤りのまま押し直した場合も欄へ移す。
      if (reasonError) {
        const field = document.getElementById('ev-cr-reason')
        field?.focus()
        field?.scrollIntoView({ block: 'center' })
      }
      return
    }
    setConfirmOpen(true)
  }

  const side = (
    <div className={styles.side}>
      <div aria-live="polite"><CreateSummaryCard title="影響の確認" rows={[]}>
        {preview ? (
          <>
            <Notice tone={preview.blocked ? "danger" : "warn"} heading={<>{preview.blocked ? 'このままでは変えられません' : moved ? '日時が変わります' : '内容が変わります'}</>}>
              <p className={styles.bandText}>
                確定した申込 {confirmedCount ?? '—'} 人へ、LINE で新旧の日時をお知らせします。キャンセル待ち {waitingCount ?? '—'} 人は順番のままです。
              </p>
            </Notice>
            {moved ? (
              <div className={styles.beforeAfter}>
                <p className={styles.beforeAfterLabel}>変える前 → 変えた後</p>
                <p className={styles.beforeAfterValue}>{`${beforeRange} → ${afterRange}`}</p>
              </div>
            ) : null}
            {sampleText ? (
              <div className={styles.lineBack} aria-label="送るお知らせの見本">
                <p className={styles.lineBubble} title={sampleText}>{sampleText}</p>
              </div>
            ) : null}
            {notes.length > 0 ? (
              <ul className={styles.noteList}>{notes.map((text) => <li key={text}>{text}</li>)}</ul>
            ) : null}
          </>
        ) : (
          <p className={styles.sideNote}>
            {previewBusy ? '影響を確かめています…' : previewError || '左で日時・定員・受付を変えると、ここに誰への影響が出ます。'}
          </p>
        )}
      </CreateSummaryCard></div>
      <CreateSummaryCard title="日時・会場を変えるときの約束" rows={[]}>
        <p className={styles.promise}>
          ・変えた内容は記録に残ります（消すことはできません）<br />
          ・定員を、すでに申し込まれている人数より下げることはできません<br />
          ・日時・会場が動いた回の確定した申込へは、LINE で新旧をお知らせします
        </p>
      </CreateSummaryCard>
    </div>
  )

  return (
    <CreatePage
      boardId="hmr2P"
      title={`変更の確認：${event.name}`}
      help={description}
      preview={side}
      previewLabel="影響の確認を見る"
      previewTitle="影響の確認"
      footerActions={(
        <>
          <Button href={`/events/edit?id=${encodeURIComponent(eventId)}`}>キャンセル</Button>
          <Button
            variant="primary"
            disabled={!canApply}
            busy={applyBusy}
            busyLabel="変えています…"
            title={!preview ? '日時・定員・受付を変えると押せます' : reasonMissing ? '押すと変える理由の欄へ移ります' : undefined}
            onClick={requestConfirm}
          >
            <Check size={16} aria-hidden="true" />変えてお知らせする
          </Button>
        </>
      )}
    >
      {applied ? (
        <Notice tone="success">
          変えました。確定 {applied.confirmed} 人・待ち {applied.waiting} 人に影響し、LINE のお知らせは {applied.notified} 人に送りました。
        </Notice>
      ) : null}
      {applyError ? <Notice tone="danger">{applyError}</Notice> : null}

      <section className={styles.card} aria-labelledby="ev-cr-slots">
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle} id="ev-cr-slots">開催回</h2>
          <p className={styles.cardNote}>変える回を選びます</p>
        </div>
        {slotList.length === 0 ? (
          <p className={styles.cardNote}>開催回がありません。編集で開催回を足してから、もう一度開いてください。</p>
        ) : (
          <div className={styles.table} role="radiogroup" aria-label="変える回">
            <div className={styles.headRow} aria-hidden="true">
              <span className={styles.cellStart}>開始</span>
              <span className={styles.cellNum}>定員</span>
              <span className={styles.cellNum}>確定</span>
              <span className={styles.cellNum}>待ち</span>
              <span className={styles.cellState}>受付</span>
            </div>
            {slotList.map((slot) => {
              const impact = impactBySlot.get(slot.id)
              const selected = slot.id === activeSlot?.id
              const ended = Date.parse(slot.ends_at) < Date.now()
              return (
                <button
                  key={slot.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={selected ? `${styles.row} ${styles.rowSelected}` : styles.row}
                  onClick={() => setSelectedSlotId(slot.id)}
                >
                  <span className={styles.cellStart}>{`${jstDay(slot.starts_at)}${jstTime(slot.starts_at)}〜${jstTime(slot.ends_at)}`}</span>
                  <span className={styles.cellNum}>{slot.capacity ?? emptyValue('unknown')}</span>
                  <span className={styles.cellNum}>{impact ? impact.confirmed_seats : (slot.active_count ?? emptyValue('unknown'))}</span>
                  <span className={styles.cellNum}>{impact ? impact.waiting_seats : emptyValue('unknown')}</span>
                  <span className={styles.cellState}>
                    {ended ? <span className={styles.chip}>終了</span>
                      : slot.is_active === 1 ? <span className={`${styles.chip} ${styles.chipOn}`}>受付する</span>
                        : <span className={styles.chip}>停止中</span>}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {activeSlot && activeEdit ? (
        <section className={styles.card} aria-labelledby="ev-cr-edit">
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle} id="ev-cr-edit">変える内容</h2>
            <p className={styles.cardNote}>{`${jstDay(activeSlot.starts_at)}の回`}</p>
          </div>
          <SettingsFormRow layout="columns">
            <div className={styles.field}><Field label="開始日時" htmlFor="ev-cr-start"><SaveErrorField names={["startsAt","activeEdit.startsAt","starts_at","active_edit.starts_at"]}><DateTimeField size="compact" id="ev-cr-start" invalid={Boolean(startError)} aria-describedby={startError ? 'ev-cr-start-error' : undefined} value={activeEdit.startsAt} onChange={(next) => updateActive({ startsAt: next })} /></SaveErrorField>
{startError ? <p id="ev-cr-start-error" className={styles.fieldError} role="alert">{startError}</p> : null}</Field></div>
            <div className={styles.field}><Field label="終了日時" htmlFor="ev-cr-end"><SaveErrorField names={["endsAt","activeEdit.endsAt","ends_at","active_edit.ends_at"]}><DateTimeField size="compact" id="ev-cr-end" invalid={Boolean(endError)} aria-describedby={endError ? 'ev-cr-end-error' : undefined} value={activeEdit.endsAt} onChange={(next) => updateActive({ endsAt: next })} /></SaveErrorField>
{endError ? <p id="ev-cr-end-error" className={styles.fieldError} role="alert">{endError}</p> : null}</Field></div>
          </SettingsFormRow>
          <SettingsFormRow layout="columns">
            <div className={styles.field}><Field label="定員" htmlFor="ev-cr-cap"><SaveErrorField names={["capacity","activeEdit.capacity","active_edit.capacity"]}><NumberInput numericText
                id="ev-cr-cap"
                inputMode="numeric"
                aria-invalid={Boolean(capacityError) || undefined}
                aria-describedby={capacityError ? 'ev-cr-cap-error' : undefined}
                value={activeEdit.capacity}
                placeholder="空欄で定員なし"
                onChange={(e) => updateActive({ capacity: e.target.value.replace(/[^0-9]/g, '') })}
              /></SaveErrorField>
{capacityError ? <p id="ev-cr-cap-error" className={styles.fieldError} role="alert">{capacityError}</p> : null}</Field></div>
            <div className={styles.field}>
              <span className={styles.pickLabel}>受付の設定</span>
              <SaveErrorField names={["ev-cr-active","isActive","activeEdit.isActive"]}><RadioCardGroup legend="受付の設定" className={styles.radioRow}>
                <RadioCard variant="row" name="ev-cr-active" value="on" checked={activeEdit.isActive} onChange={() => updateActive({ isActive: true })} title="受付する" />
                <RadioCard variant="row" name="ev-cr-active" value="off" checked={!activeEdit.isActive} onChange={() => updateActive({ isActive: false })} title="止める" />
              </RadioCardGroup></SaveErrorField>
              {Date.parse(activeSlot.ends_at) < Date.now() ? <p className={styles.note}>現在は開催終了のため受付できません。開催日時を未来に変更すると、保存後に受付の設定が適用されます。</p> : null}
            </div>
          </SettingsFormRow>
          <div className={styles.field}><Field label="変える理由" htmlFor="ev-cr-reason"><SaveErrorField names={["reason"]}><TextField
              id="ev-cr-reason"
              aria-invalid={Boolean(reasonError) || undefined}
              aria-describedby={reasonError ? 'ev-cr-reason-error' : undefined}
              value={reason}
              maxLength={500}
              placeholder="例：会場の都合で時間を30分遅らせます"
              aria-required={isPublished || undefined}
              onChange={(e) => { setReason(e.target.value); setReasonError('') }}
            /></SaveErrorField>
{reasonError ? <p id="ev-cr-reason-error" className={styles.fieldError} role="alert">{reasonError}</p> : null}</Field></div>
          <p className={styles.note}>
            {isPublished ? '理由は変更の記録に残ります。友だちには送りません。公開中なので書かないと変えられません。' : '理由は変更の記録に残ります。友だちには送りません。'}
          </p>
          {venueOpen ? (
            <SettingsFormRow layout="columns">
              <div className={styles.field}><Field label="会場" htmlFor="ev-cr-venue"><SaveErrorField names={["venueName","venue_name"]}><TextField id="ev-cr-venue" value={venueName} placeholder="未設定" onChange={(e) => { setVenueName(e.target.value); touchEdits() }} /></SaveErrorField></Field></div>
              <div className={styles.field}><Field label="オンラインの URL（確定した申込にだけ見せます）" htmlFor="ev-cr-url"><SaveErrorField names={["venueUrl","venue_url"]}><TextField id="ev-cr-url" type="url" value={venueUrl} placeholder="未設定" onChange={(e) => { setVenueUrl(e.target.value); touchEdits() }} /></SaveErrorField></Field></div>
            </SettingsFormRow>
          ) : (
            <div className={styles.linkRow}>
              <Button variant="text" size="inline" onClick={() => setVenueOpen(true)}>会場・オンラインの URL も変更する</Button>
            </div>
          )}
        </section>
      ) : null}

      <Dialog
        open={confirmOpen && Boolean(preview)}
        designNode="qUdNh"
        designWidth={620}
        designTop={185}
        confirmIcon={<Send size={16} aria-hidden="true" />}
        title="変更内容を確認"
        cancelLabel="戻って直す"
        confirmLabel={confirmedCount === null ? '変えてお知らせする' : `変えて ${confirmedCount} 人にお知らせする`}
        busy={applyBusy}
        onConfirm={() => { setConfirmOpen(false); return runApply() }}
        onCancel={() => setConfirmOpen(false)}
      >
        <div className={styles.confirmBody}>
          <dl className={styles.confirmList}>
            <div className={styles.confirmRow}>
              <dt>開催回</dt>
              <dd>{activeSlot ? `${event.name} ${jstDay((moved?.slot ?? activeSlot).starts_at)}` : event.name}</dd>
            </div>
            {moved ? (
              <div className={styles.confirmRow}>
                <dt>変える前 → 後</dt>
                <dd>{`${beforeRange} → ${afterRange}`}</dd>
              </div>
            ) : null}
            <div className={styles.confirmRow}>
              <dt>お知らせする人</dt>
              <dd>{confirmedCount === null ? '人数を確認できません' : `確定 ${confirmedCount} 人`}</dd>
            </div>
            <div className={styles.confirmRow}>
              <dt>キャンセル待ち</dt>
              <dd>{waitingCount === null ? '人数を確認できません' : `${waitingCount} 人（順番はそのまま）`}</dd>
            </div>
          </dl>
          {sampleText ? <p className={styles.confirmSample}>{sampleText}</p> : null}
          <p className={styles.note}>LINE で友だちでない人には届きません。電話などでお知らせしてください。入力を変えると、この確認はやり直しになります。</p>
        </div>
      </Dialog>
    </CreatePage>
  )
}
