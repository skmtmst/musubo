'use client'

import { jstDateOffset as japanDateOffset } from '@/lib/jst-datetime'

import { Field as SharedField } from '@/components/shared/form-controls'
import DateField from '@/components/shared/date-field'
import { useEffect, useState } from 'react'
import type { VisitStampMultiplier, VisitStampReward, VisitStampSettings } from '@line-crm/shared'
import Checkbox from '@/components/shared/checkbox'
import Dialog from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { FieldError } from '@/components/shared/form-controls'
import { useFormErrors, type FormErrors } from '@/lib/use-form-errors'
import { WEEKDAYS, minuteLabel } from './display'
import styles from './visit-stamps.module.css'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { EntityMultiPickerDialog } from '@/components/shared/entity-picker'
import EntityRemoteField from '@/components/shared/entity-remote-field'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import EditorSurface from '@/components/shared/editor-surface'
import { withHonorific } from '@line-crm/shared'

/*
 * 来店スタンプ（V8 w4SBbv）の小窓。絵に窓は無いので、共通の Dialog に欄を並べるだけにする。
 * 特典・倍率・初回ボーナス・ランク倍率は「下書き」を変えるだけ（保存は下の帯の［保存する］）。
 * 理由・暗証番号・写真は、その場で口を呼ぶ（呼び出しは画面側）。
 */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <SharedField label={label}>{children}</SharedField>
}

/*
 * 誤りを出す欄。決めるを押したら、落ちた欄が赤くなり真下に理由が出て、1つ目へ移る。
 * 打っている途中には出さない（窓の下の帯にも出さない）。
 */
function CheckedField({ id, label, fields, name, children }: { id: string; label: string; fields: FormErrors; name: string; children: React.ReactNode }) {
  return <SharedField label={label} htmlFor={id} requirement={fields.requirement(name)}>{children}<FieldError id={`${id}-error`}>{fields.error(name)}</FieldError></SharedField>
}
const checkedProps = (fields: FormErrors, name: string, id: string) => ({ ...fields.bind(name), id, invalid: fields.invalid(name), 'aria-describedby': fields.invalid(name) ? `${id}-error` : undefined })

const toInt = (v: string) => (v.trim() === '' ? NaN : Number(v.replace(/[,，]/g, '')))

export function RewardDialog({ open, reward, onClose, onSave }: {
  open: boolean; reward: VisitStampReward | null; onClose: () => void; onSave: (reward: VisitStampReward) => void
}) {
  const [name, setName] = useState('')
  const [stamps, setStamps] = useState('')
  const fields = useFormErrors()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 欄の印の片付けは開いたときだけ
  useEffect(() => { if (open) { setName(reward?.name ?? ''); setStamps(reward ? String(reward.stamps) : ''); fields.reset() } }, [open, reward])
  const n = toInt(stamps)
  fields.define('name', '特典の名前', () => (name.trim() ? null : '特典の名前を入れてください。'), { required: true })
  fields.define('stamps', '何個で使えるか', () => (Number.isInteger(n) && n >= 1 ? null : '何個で使えるかを 1 以上の数で入れてください。'), { required: true })
  return (
    <EditorSurface surface={reward ? 'inline' : 'dialog'} open={open} title={reward ? '特典を変える' : '特典を足す'} confirmLabel={reward ? '変える' : '足す'} onCancel={onClose}
      onConfirm={() => { if (fields.submit().length === 0) onSave({ id: reward?.id ?? `reward-${Date.now().toString(36)}`, name: name.trim(), stamps: n }) }}>
      <div className={styles.dialogBody}>
        <CheckedField id="vs-reward-name" label="特典の名前" fields={fields} name="name"><SaveErrorField names={["name"]}><TextField {...checkedProps(fields, 'name', 'vs-reward-name')} value={name} onChange={(e) => setName(e.target.value)} placeholder="例：ドリンク 1杯" maxLength={100} /></SaveErrorField></CheckedField>
        <CheckedField id="vs-reward-stamps" label="何個で使えるか" fields={fields} name="stamps"><SaveErrorField names={["stamps"]}><NumberInput numericText {...checkedProps(fields, 'stamps', 'vs-reward-stamps')} value={stamps} onChange={(e) => setStamps(e.target.value)} inputMode="numeric" placeholder="例：5" /></SaveErrorField></CheckedField>
      </div>
    </EditorSurface>
  )
}

const MINUTES = Array.from({ length: 48 }, (_, i) => i * 30)
/** 日付欄の値（YYYY-MM-DD）と保存の形（日本時間のその日の 0:00）。to は次の日の 0:00 を持つ。 */
const toIso = (date: string, nextDay = false) => {
  if (!date) return undefined
  const t = Date.parse(`${date}T00:00:00+09:00`) + (nextDay ? 86_400_000 : 0)
  return new Date(t).toISOString()
}
const toDate = (iso: string | undefined, prevDay = false) => {
  if (!iso) return ''
  return japanDateOffset(prevDay ? -1 : 0, new Date(iso))
}

export function MultiplierDialog({ open, multiplier, onClose, onSave }: {
  open: boolean; multiplier: VisitStampMultiplier | null; onClose: () => void; onSave: (m: VisitStampMultiplier) => void
}) {
  const [label, setLabel] = useState('')
  const [rate, setRate] = useState('2')
  const [days, setDays] = useState<number[]>([])
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const fields = useFormErrors()
  useEffect(() => {
    if (!open) return
    fields.reset()
    setLabel(multiplier?.name ?? '')
    setRate(String(multiplier?.multiplier ?? 2)); setDays(multiplier?.weekdays ?? [])
    setStart(multiplier?.startMinute !== undefined ? String(multiplier.startMinute) : '')
    setEnd(multiplier?.endMinute !== undefined ? String(multiplier.endMinute) : '')
    setFrom(toDate(multiplier?.from)); setTo(toDate(multiplier?.to, true))
  }, [open, multiplier]) // eslint-disable-line react-hooks/exhaustive-deps -- 欄の印の片付けは開いたときだけ
  const r = Number(rate)
  fields.define('rate', '倍率', () => (!Number.isFinite(r) || r < 1 || r > 100 ? '倍率は 1〜100 で入れてください。' : null), { required: true })
  fields.define('start', '時間の始まり', () => (start === '' && end !== '' ? '始まりも選んでください。' : null), { required: end !== '' })
  fields.define('end', '時間の終わり', () => (
    end === '' && start !== '' ? '終わりも選んでください。'
      : start !== '' && end !== '' && Number(start) >= Number(end) ? '終わりの時間を始まりより後にしてください。' : null
  ), { required: start !== '' })
  fields.define('to', '期間の終わり', () => (from && to && from > to ? '期間の終わりを始まりより後にしてください。' : null), { required: false })
  const timeOptions = [{ value: '', label: '指定なし' }, ...MINUTES.map((m) => ({ value: String(m), label: minuteLabel(m) }))]
  const endOptions = [{ value: '', label: '指定なし' }, ...MINUTES.slice(1).map((m) => ({ value: String(m), label: minuteLabel(m) })), { value: '1440', label: '24:00' }]
  return (
    <EditorSurface surface={multiplier ? 'inline' : 'dialog'} open={open} title={multiplier ? '倍率を変える' : '倍率を足す'} confirmLabel={multiplier ? '変える' : '足す'} onCancel={onClose}
      onConfirm={() => {
        if (fields.submit().length > 0) return
        onSave({
          ...(label.trim() ? { name: label.trim() } : {}),
          /* 止めている倍率は、変えても止めたまま。 */
          ...(multiplier?.active === false ? { active: false } : {}),
          multiplier: r,
          ...(days.length ? { weekdays: [...days].sort() } : {}),
          ...(start !== '' ? { startMinute: Number(start), endMinute: Number(end) } : {}),
          ...(from ? { from: toIso(from) } : {}),
          ...(to ? { to: toIso(to, true) } : {}),
        })
      }}>
      <div className={styles.dialogBody}>
        <Field label="名前"><SaveErrorField names={["label","name"]}><TextField value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} placeholder="例：火曜の夕方 2倍デー" /></SaveErrorField></Field>
        <CheckedField id="vs-mul-rate" label="倍率" fields={fields} name="rate"><SaveErrorField names={["rate"]}><TextField {...checkedProps(fields, 'rate', 'vs-mul-rate')} value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" /></SaveErrorField></CheckedField>
        <div className={styles.field}>
          <span className={styles.label}>曜日（選ばなければ毎日）</span>
          <div className={styles.weekdays}>
            {WEEKDAYS.map((d, i) => (
              <SaveErrorField names={["i","days"]} key={d}><Checkbox key={d} checked={days.includes(i)} onCheckedChange={(on) => setDays(on ? [...days, i] : days.filter((x) => x !== i))}>{d}</Checkbox></SaveErrorField>
            ))}
          </div>
        </div>
        <div className={styles.row2}>
          <CheckedField id="vs-mul-start" label="時間の始まり" fields={fields} name="start"><div {...fields.bind('start')}><SaveErrorField names={["start"]}><Select id="vs-mul-start" aria-label="時間の始まり" size="full" value={start} error={fields.error('start') ?? undefined} onChange={(v) => { fields.clear('start'); setStart(v) }} options={timeOptions} /></SaveErrorField></div></CheckedField>
          <CheckedField id="vs-mul-end" label="時間の終わり" fields={fields} name="end"><div {...fields.bind('end')}><SaveErrorField names={["end"]}><Select id="vs-mul-end" aria-label="時間の終わり" size="full" value={end} error={fields.error('end') ?? undefined} onChange={(v) => { fields.clear('end'); setEnd(v) }} options={endOptions} /></SaveErrorField></div></CheckedField>
        </div>
        <div className={styles.row2}>
          <Field label="期間の始まり"><SaveErrorField names={["from"]}><DateField value={from} onChange={setFrom} /></SaveErrorField></Field>
          <CheckedField id="vs-mul-to" label="期間の終わり" fields={fields} name="to"><SaveErrorField names={["to"]}><DateField {...checkedProps(fields, 'to', 'vs-mul-to')} value={to} onChange={setTo} /></SaveErrorField></CheckedField>
        </div>
      </div>
    </EditorSurface>
  )
}

export function BonusDialog({ open, value, onClose, onSave }: { open: boolean; value: number; onClose: () => void; onSave: (n: number) => void }) {
  const [count, setCount] = useState('1')
  const fields = useFormErrors()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 欄の印の片付けは開いたときだけ
  useEffect(() => { if (open) { setCount(String(value || 1)); fields.reset() } }, [open, value])
  const n = toInt(count)
  fields.define('count', 'はじめての来店で足す個数', () => (Number.isInteger(n) && n >= 1 ? null : '1 以上の数で入れてください。'), { required: true })
  return (
    <EditorSurface surface={'inline'} open={open} title="初回来店ボーナス" confirmLabel="変える" onCancel={onClose} onConfirm={() => { if (fields.submit().length === 0) onSave(n) }}>
      <CheckedField id="vs-bonus-count" label="はじめての来店で足す個数" fields={fields} name="count"><SaveErrorField names={["count"]}><NumberInput numericText {...checkedProps(fields, 'count', 'vs-bonus-count')} value={count} onChange={(e) => setCount(e.target.value)} inputMode="numeric" /></SaveErrorField></CheckedField>
    </EditorSurface>
  )
}

type RankRow = { tagName: string; multiplier: string }
export function RankDialog({ open, settings, onClose, onSave }: {
  open: boolean; settings: VisitStampSettings; onClose: () => void; onSave: (rows: VisitStampSettings['rankMultipliers']) => void
}) {
  const [rows, setRows] = useState<RankRow[]>([])
  const fields = useFormErrors()
  useEffect(() => {
    if (open) fields.reset()
    if (open) setRows(settings.rankMultipliers.length ? settings.rankMultipliers.map((r) => ({ tagName: r.tagName, multiplier: String(r.multiplier) })) : [{ tagName: '', multiplier: '1.5' }])
  }, [open, settings.rankMultipliers]) // eslint-disable-line react-hooks/exhaustive-deps -- 欄の印の片付けは開いたときだけ
  const used = rows.filter((r) => r.tagName.trim())
  rows.forEach((row, i) => fields.define(`rate-${i}`, `倍率 ${i + 1}`, () => (row.tagName.trim() && !(Number(row.multiplier) >= 1 && Number(row.multiplier) <= 100) ? '倍率は 1〜100 で入れてください。' : null), { required: Boolean(row.tagName.trim()) }))
  return (
    <EditorSurface surface={'inline'} open={open} title="会員ランクの倍率" description="友だちに付いたタグの名前ごとに倍率を決めます。いくつも当たるときは、いちばん高い倍率だけを使います。" confirmLabel="変える" onCancel={onClose}
      onConfirm={() => {
        if (fields.submit().length > 0) return
        /* 前からあるランクの名前・止めているかは残す（タグの名前で突き合わせる）。 */
        onSave(used.map((r) => {
          const before = settings.rankMultipliers.find((x) => x.tagName === r.tagName.trim())
          return { ...(before?.name ? { name: before.name } : {}), ...(before?.active === false ? { active: false } : {}), tagName: r.tagName.trim(), multiplier: Number(r.multiplier) }
        }))
      }}>
      <div className={styles.dialogBody}>
        {rows.map((row, i) => (
          <div key={i} className={styles.row2}>
            <Field label={`タグ ${i + 1}`}><SaveErrorField names={[`rows.${i}.tagName`,`rows.${i}.tag_name`,"tagName","row.tagName","rows","tag_name","row.tag_name"]}><EntityRemoteField kind="tag" valueMode="name" label={`タグ ${i + 1}`} value={row.tagName} emptyLabel="指定しない" onChange={(tagName) => setRows(rows.map((r, k) => (k === i ? { ...r, tagName } : r)))} /></SaveErrorField></Field>
            <CheckedField id={`vs-rank-rate-${i}`} label="倍率" fields={fields} name={`rate-${i}`}><SaveErrorField names={[`rows.${i}.multiplier`,"multiplier","row.multiplier","rows"]}><TextField {...checkedProps(fields, `rate-${i}`, `vs-rank-rate-${i}`)} value={row.multiplier} onChange={(e) => setRows(rows.map((r, k) => (k === i ? { ...r, multiplier: e.target.value } : r)))} inputMode="decimal" /></SaveErrorField></CheckedField>
          </div>
        ))}
        {rows.length < 20 ? <button type="button" className={styles.link} onClick={() => setRows([...rows, { tagName: '', multiplier: '1.2' }])}>＋ ランクを足す</button> : null}
      </div>
    </EditorSurface>
  )
}

/** 理由を書いて実行する窓（却下・取り消し）。理由は台帳に残るので必須。 */
export function ReasonDialog({ open, title, description, confirmLabel, busy, error, target, onClose, onConfirm }: {
  open: boolean; title: string; description: string; confirmLabel: string; busy: boolean; error?: string; target?: { accountId: string | null; accountName?: string | null; friendName?: string | null }; onClose: () => void; onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  const fields = useFormErrors()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 欄の印の片付けは開いたときだけ
  useEffect(() => { if (open) { setReason(''); fields.reset() } }, [open])
  fields.define('reason', '理由', () => (reason.trim() ? null : '理由を入れてください。'), { required: true })
  return (
    <Dialog open={open} title={title} description={description} confirmLabel={confirmLabel} tone="destructive" busy={busy} error={error} onCancel={onClose}
      onConfirm={() => { if (fields.submit().length === 0) onConfirm(reason.trim()) }}>
      {target ? <OperationTargetSummary accounts={[{ id: target.accountId ?? '', name: target.accountId ? target.accountName : '不明' }]} externalTarget={{ label: '友だち', name: target.friendName }} /> : null}
      <CheckedField id="vs-reason" label="理由" fields={fields} name="reason"><SaveErrorField names={["reason"]}><TextField {...checkedProps(fields, 'reason', 'vs-reason')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="例：写真の数と合わない" /></SaveErrorField></CheckedField>
    </Dialog>
  )
}

/** 店員の暗証番号（4桁）。お客さまの LIFF で特典を使用済みにするときに店員が打つ。番号は保存後に見えない。 */
export function PinDialog({ open, staff, busy, error, onClose, onSave }: {
  open: boolean; staff: Array<{ id: string; name: string }>; busy: boolean; error?: string; onClose: () => void; onSave: (staffId: string, pin: string) => void
}) {
  const [staffId, setStaffId] = useState('')
  const [pin, setPin] = useState('')
  const fields = useFormErrors()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 欄の印の片付けは開いたときだけ
  useEffect(() => { if (open) { setStaffId(staff[0]?.id ?? ''); setPin(''); fields.reset() } }, [open, staff])
  fields.define('staff', '店員', () => (staffId ? null : '店員を選んでください。'), { required: true })
  fields.define('pin', '暗証番号', () => (/^\d{4}$/.test(pin) ? null : '暗証番号は4桁の数字で入れてください。'), { required: true })
  return (
    <Dialog open={open} title="店員の暗証番号" description="特典を使用済みにするとき、店員がお客さまのスマホで打つ4桁の番号です。保存したあとは番号を表示しません。" confirmLabel="保存する" busy={busy} error={error}
      onCancel={onClose} onConfirm={() => { if (fields.submit().length === 0) onSave(staffId, pin) }}>
      <div className={styles.dialogBody}>
        <CheckedField id="vs-pin-staff" label="店員" fields={fields} name="staff"><div {...fields.bind('staff')}><SaveErrorField names={["staffId","staff_id"]}><EntitySelect id="vs-pin-staff" aria-label="店員" size="full" value={staffId} error={fields.error('staff') ?? undefined} onChange={(v) => { fields.clear('staff'); setStaffId(v) }} options={staff.map((s) => ({ ...entityOptionMetadata(s), value: s.id, label: s.name }))} /></SaveErrorField></div></CheckedField>
        <CheckedField id="vs-pin" label="暗証番号（4桁）" fields={fields} name="pin"><SaveErrorField names={["pin"]}><TextField {...checkedProps(fields, 'pin', 'vs-pin')} className={styles.pin} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" autoComplete="off" type="password" /></SaveErrorField></CheckedField>
      </div>
    </Dialog>
  )
}

/** 押せる店（このカードを使う LINE アカウント）。保存は下の帯の［保存する］。 */
export function StoresDialog({ open, accounts, value, onClose, onSave }: {
  open: boolean; accounts: Array<{ id: string; name: string }>; value: string[]; onClose: () => void; onSave: (ids: string[]) => void
}) {
  return open ? <EntityMultiPickerDialog title="押せる店" description="このカードのスタンプを押せる店です。同じカードの店どうしでスタンプを合わせて数えます。" items={accounts} initialIds={value} allowEmpty={false} onCancel={onClose} onConfirm={ onSave }/> : null
}

export function PhotoDialog({ url, name, onClose }: { url: string | null; name: string; onClose: () => void }) {
  return (
    <Dialog open={!!url} title={`${withHonorific(name)}の紙のカード`} onCancel={onClose} cancelLabel="閉じる" size="large">
      {/* 写真は担当店舗の権限で読んだもの（本人だけが預けた非公開の写真）。大きさは窓に合わせる。 */}
      {url ? <img src={url} alt={`${withHonorific(name)}が送った紙のスタンプカードの写真`} className={styles.photo} /> : null}
    </Dialog>
  )
}
