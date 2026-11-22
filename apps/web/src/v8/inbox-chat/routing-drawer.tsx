'use client'
import { notifySaved } from '@/components/shared/toast'

import { FormLeaveGuard } from '@/components/shared/form-leave-guard'

import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

import EntitySelect from '@/components/shared/entity-select'

import { isConflictResponse, CONFLICT_TEXT } from '@/components/shared/save-conflict'

/* 受信箱の割り当てと返事の期限の設定。 */
import { useEffect, useRef, useState } from 'react'
import type { InboxFirstResponseSettings } from '@line-crm/shared'
import Drawer from '@/components/shared/drawer'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import Notice from '@/components/shared/notice'
import ListState from '@/components/shared/list-state'
import SegmentedControl from '@/components/shared/segmented'
import Select from '@/components/shared/select'
import Toggle from '@/components/shared/toggle'
import NumberInput from '@/components/shared/number-field'
import { Field } from '@/components/shared/form-controls'
import { api } from '@/lib/api'
import { gap3InboxApi } from '@/lib/api/helpers/gap3'
import { inboxRoutingApi } from '@/lib/api/helpers/gap1'
import { describeApiFailure } from '@/components/shared/api-error-message'
import styles from './routing-drawer.module.css'

const MIN_MINUTES = 5
const MAX_MINUTES = 1440
/** 契約：期限の15分前から金の札。いまは変えられない固定値。 */
const SOON_MINUTES = 15
const STRATEGIES = [
  { value: 'none', label: 'しない' },
  { value: 'even', label: '均等' },
  { value: 'priority', label: '優先順' },
  { value: 'random_weighted', label: 'ランダム＋優先度' },
] as const

type Team = { id: string; name: string }
type Person = { id: string; name: string }

export default function RoutingDrawer({ accountId, open, onClose, onSaved }: {
  accountId: string
  open: boolean
  onClose: () => void
  /** 保存したあと、一覧の札を取り直す。 */
  onSaved: (settings: InboxFirstResponseSettings) => void
}) {
  const contextRef = useRef({ accountId, open })
  contextRef.current = { accountId, open }
  const saveErrors = useSaveFormErrors()
  const [settings, setSettings] = useState<InboxFirstResponseSettings | null>(null)
  const [draft, setDraft] = useState<InboxFirstResponseSettings | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [peopleFailed, setPeopleFailed] = useState(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [minutesText, setMinutesText] = useState('30')
  const [saving, setSaving] = useState(false)
  const [job, setJob] = useState<{id:string;status:string;assigned:number;skipped:number;total:number}|null>(null)
  const [jobError, setJobError] = useState('')
  const [jobStarting, setJobStarting] = useState(false)
  const jobStartLock = useRef(false)
  const jobKey = useRef<string|null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let live = true
    setSettings(null); setDraft(null); setLoadError(null); setError('')
    void inboxRoutingApi.get(accountId).then((res) => {
      if (!live) return
      setSettings(res.data); setDraft(res.data); setMinutesText(String(res.data.firstResponseMinutes))
    }, (caught) => { if (live) setLoadError(caught) })
    setPeople([]); setPeopleFailed(false)
    void Promise.resolve().then(() => api.staff.list(accountId)).then((res) => {
      if (live && res.success) setPeople(res.data.filter(person => person.isActive && person.role !== 'viewer' && !person.readOnly && person.roleBundle !== 'view_only').map(person => ({ id: person.id, name: person.name })))
    }, () => { if (live) setPeopleFailed(true) })
    void api.notifications.teams.list(accountId).then((res) => {
      if (live && res.success) setTeams(res.data.filter((team) => !team.archivedAt).map((team) => ({ id: team.id, name: team.name })))
    }, () => {})
    return () => { live = false }
  }, [open, accountId])

  useEffect(() => {
    if (!open || !job || !['pending','running'].includes(job.status)) return
    let live = true
    const timer = window.setTimeout(() => { void gap3InboxApi.assignmentJob(accountId,job.id).then(result => { if (live) setJob(result.data) }, () => { if (live) setJobError('進捗を確認できませんでした。開き直して確認してください。') }) }, 2500)
    return () => { live = false; window.clearTimeout(timer) }
  }, [open, accountId, job])

  const applyExisting = async () => {
    if (jobStartLock.current) return
    jobStartLock.current = true; setJobStarting(true); setJobError('')
    jobKey.current ??= crypto.randomUUID()
    try { const result = await gap3InboxApi.applyUnassigned(accountId,jobKey.current);setJob(result.data) }
    catch { setJobError('割り当てを開始できませんでした。同じ操作でもう一度お試しください。') }
    finally { jobStartLock.current = false; setJobStarting(false) }
  }
  useEffect(() => { if (job && ['succeeded','failed'].includes(job.status)) jobKey.current = null }, [job])
  const minutes = Number(minutesText)
  const minutesValid = Number.isInteger(minutes) && minutes >= MIN_MINUTES && minutes <= MAX_MINUTES
  const dirty = Boolean(settings && draft && (
    settings.strategy !== draft.strategy || JSON.stringify(settings.targets ?? []) !== JSON.stringify(draft.targets ?? [])
    || settings.enabled !== draft.enabled || settings.businessHoursOnly !== draft.businessHoursOnly
    || settings.escalateTeamId !== draft.escalateTeamId || settings.firstResponseMinutes !== (minutesValid ? minutes : settings.firstResponseMinutes)
  ))

  const save = async () => {
    if (!settings || !draft) return
    if (!minutesValid) { setError(`最初の返事までは ${MIN_MINUTES}〜${MAX_MINUTES} 分で入れてください。`); return }
    setSaving(true); setError('')
    try {
      const res = await inboxRoutingApi.save(accountId, {
        strategy: draft.strategy ?? 'none', targets: draft.targets ?? [], enabled: draft.enabled, firstResponseMinutes: minutes, businessHoursOnly: draft.businessHoursOnly,
        escalateTeamId: draft.escalateTeamId, expectedVersion: settings.version,
      })
      if (contextRef.current.accountId !== accountId || !contextRef.current.open) return
      notifySaved('「割り当てと返事の期限」を保存しました')
      onSaved(res.data)
      onClose()
    } catch (caught) {
      if (contextRef.current.accountId !== accountId || !contextRef.current.open) return
      saveErrors.capture(caught)
      setError(isConflictResponse(caught)
        ? CONFLICT_TEXT.routing
        : describeApiFailure(caught, '保存'))
    } finally { setSaving(false) }
  }

  return (<SaveErrorScope errors={saveErrors}>{(
    <>
    <FormLeaveGuard dirty={open && dirty} busy={saving} />
    <Drawer open={open} title="割り当てと返事の期限" description="新しい会話を、だれが・いつまでに返すかを決めます" width="editor" heightMode="viewport" dirty={dirty} busy={saving} error={error} onClose={onClose}
      footer={<div className={styles.footerRow}>
        <Button onClick={onClose} disabled={saving}>キャンセル</Button>
        <Button variant="primary" onClick={() => void save()} disabled={!dirty || saving} busy={saving}>保存する</Button>
      </div>}>
      {loadError ? <ListState kind="error" error={loadError} onRetry={() => { setLoadError(null); void inboxRoutingApi.get(accountId).then((res) => { setSettings(res.data); setDraft(res.data); setMinutesText(String(res.data.firstResponseMinutes)) }, setLoadError) }} />
        : !draft ? <ListState kind="loading" />
          : (
            <div className={styles.body}>
              <section className={styles.card} aria-labelledby="routing-strategy-heading">
                <h3 id="routing-strategy-heading" className={styles.cardTitle}>割り当て方</h3>
                <SegmentedControl aria-label="割り当て方" options={[...STRATEGIES]} value={draft.strategy ?? 'none'} onChange={(strategy) => setDraft({ ...draft, strategy })} />
                {settings && settings.strategy !== 'none' ? <>
                  <p className={styles.note}>{`今の未割り当て ${settings.unassignedCount ?? '—'} 件`}</p>
                  <Button variant="secondary" disabled={dirty || jobStarting || Boolean(job && ['pending','running'].includes(job.status))} onClick={() => void applyExisting()}>今の未割り当てにも当てる</Button>
                  {job ? <p role="status">{job.status === 'succeeded' ? `${job.assigned}件を割り当て、${job.skipped}件は割り当てられませんでした。` : job.status === 'failed' ? '割り当てを完了できませんでした。管理者に確認してください。' : `割り当て中 ${job.assigned + job.skipped} / ${job.total}件`}</p> : null}
                  {jobError ? <><Notice tone="warn" message={jobError} />{job ? <Button variant="secondary" onClick={() => { setJobError(''); void gap3InboxApi.assignmentJob(accountId,job.id).then(result => setJob(result.data), () => setJobError('進捗を確認できませんでした。')) }}>もう一度確認する</Button> : null}</> : null}
                </> : null}
                {draft.strategy !== 'none' ? <>
                  <p className={styles.note}>対象の担当者と、優先順・未対応の上限を決めます。</p>
                  {peopleFailed ? <Notice tone="warn">担当者を読み込めませんでした。画面を開き直してください。</Notice> : null}
                  {people.map(person => { const target = (draft.targets ?? []).find(item => item.staffId === person.id); return <div className={styles.pair} key={person.id}>
                    <Checkbox checked={Boolean(target)} onCheckedChange={checked => setDraft({ ...draft, targets: checked ? [...(draft.targets ?? []), {staffId:person.id,priority:1,cap:10}] : (draft.targets ?? []).filter(item => item.staffId !== person.id) })}>{person.name}</Checkbox>
                    {target ? <div className={styles.pair}>
                      <Field label="優先順"><NumberInput type="number" value={String(target.priority)} onChange={event => setDraft({ ...draft, targets: (draft.targets ?? []).map(item => item.staffId === person.id ? { ...item, priority: Number(event.target.value) } : item) })} /></Field>
                      <Field label="上限"><NumberInput type="number" value={String(target.cap)} onChange={event => setDraft({ ...draft, targets: (draft.targets ?? []).map(item => item.staffId === person.id ? { ...item, cap: Number(event.target.value) } : item) })} /></Field>
                    </div> : null}
                  </div> })}
                </> : null}
              </section>

              <section className={styles.card} aria-labelledby="routing-sla-heading">
                <h3 id="routing-sla-heading" className={styles.cardTitle}>返事の期限</h3>
                <div className={styles.switchRow}>
                  <span id="routing-sla-label">返事の期限を使う（初めはオフ）</span>
                  <Toggle label="返事の期限を使う" checked={draft.enabled} onChange={(next) => setDraft({ ...draft, enabled: next })} />
                </div>
                <div className={styles.pair}>
                  <Field label="最初の返事まで" required htmlFor="routing-minutes">
                    <SaveErrorField names={["firstResponseMinutes"]}><NumberInput id="routing-minutes" numericText inputMode="numeric" unit="分" value={minutesText} disabled={!draft.enabled}
                      invalid={!minutesValid} onChange={(event) => setMinutesText(event.target.value)} /></SaveErrorField>
                  </Field>
                  <Field label="金の印を出す" htmlFor="routing-soon">
                    <Select id="routing-soon" aria-label="金の印を出す" size="full" disabled value="soon" onChange={() => {}} options={[{ value: 'soon', label: `残り ${SOON_MINUTES} 分から` }]} />
                  </Field>
                </div>
                <Checkbox checked={draft.businessHoursOnly} disabled={!draft.enabled} onCheckedChange={(next) => setDraft({ ...draft, businessHoursOnly: next })}>
                  営業時間の中だけ数える（Googleビジネスの営業時間を使用）
                </Checkbox>
                <Field label="過ぎたら知らせる先" htmlFor="routing-team">
                  <EntitySelect id="routing-team" aria-label="過ぎたら知らせる先" size="full" disabled={!draft.enabled} value={draft.escalateTeamId ?? ''}
                    onChange={(value) => setDraft({ ...draft, escalateTeamId: value || null })}
                    options={[{ value: '', label: '担当者だけに知らせる' }, ...teams.map((team) => ({ value: team.id, label: `通知チーム：${team.name}` }))]} />
                </Field>
                <p className={styles.note}>期限の15分前に担当へ、過ぎたら担当へ、過ぎて30分で選んだ知らせる先へ、管理画面の通知で知らせます。</p>
              </section>
              {draft.enabled && !minutesValid ? <Notice tone="warn">{`最初の返事までは ${MIN_MINUTES}〜${MAX_MINUTES} 分で入れてください。`}</Notice> : null}
            </div>
          )}
    </Drawer>
    </>
  )}</SaveErrorScope>)
}
