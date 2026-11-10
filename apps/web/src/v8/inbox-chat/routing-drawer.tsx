'use client'
import { notifySaved } from '@/components/shared/toast'

import { FormLeaveGuard } from '@/components/shared/form-leave-guard'

import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

import EntitySelect from '@/components/shared/entity-select'

import { isConflictResponse, CONFLICT_TEXT } from '@/components/shared/save-conflict'

/*
 * 受信箱の「割り当てと返事の期限」の引き出し（板 L6pGz・要件 G3）。
 * 口：inboxRoutingApi（GET/PUT /api/inbox/routing-settings。契約 API-CONTRACT-GAP1.md）。
 * 今の口で保存できるのは「返事の期限」（使う・分・営業時間の中だけ・過ぎたら知らせる先）と割り当て方「しない」だけ。
 * 均等・優先順・ランダム＋優先度・対象の人・今の未割り当てに当てる、は口の次の段。選べない形で並べ、準備中と書く。
 * 設定はオーナー・管理者だけ（開く入口を出さない）。
 */
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
import { ApiError, api } from '@/lib/api'
import { inboxRoutingApi } from '@/lib/api/helpers/gap1'
import { describeApiFailure } from '@/components/shared/api-error-message'
import styles from './routing-drawer.module.css'

const MIN_MINUTES = 5
const MAX_MINUTES = 1440
/** 契約：期限の15分前から金の札。いまは変えられない固定値。 */
const SOON_MINUTES = 15
const STRATEGIES = [
  { value: 'none', label: 'しない', ready: true },
  { value: 'even', label: '均等', ready: false },
  { value: 'priority', label: '優先順', ready: false },
  { value: 'random_weighted', label: 'ランダム＋優先度', ready: false },
] as const

type Team = { id: string; name: string }

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
  const [loadError, setLoadError] = useState<unknown>(null)
  const [minutesText, setMinutesText] = useState('30')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    let live = true
    setSettings(null); setDraft(null); setLoadError(null); setError('')
    void inboxRoutingApi.get(accountId).then((res) => {
      if (!live) return
      setSettings(res.data); setDraft(res.data); setMinutesText(String(res.data.firstResponseMinutes))
    }, (caught) => { if (live) setLoadError(caught) })
    void api.notifications.teams.list(accountId).then((res) => {
      if (live && res.success) setTeams(res.data.filter((team) => !team.archivedAt).map((team) => ({ id: team.id, name: team.name })))
    }, () => {})
    return () => { live = false }
  }, [open, accountId])

  const minutes = Number(minutesText)
  const minutesValid = Number.isInteger(minutes) && minutes >= MIN_MINUTES && minutes <= MAX_MINUTES
  const dirty = Boolean(settings && draft && (
    settings.enabled !== draft.enabled || settings.businessHoursOnly !== draft.businessHoursOnly
    || settings.escalateTeamId !== draft.escalateTeamId || settings.firstResponseMinutes !== (minutesValid ? minutes : settings.firstResponseMinutes)
  ))

  const save = async () => {
    if (!settings || !draft) return
    if (!minutesValid) { setError(`最初の返事までは ${MIN_MINUTES}〜${MAX_MINUTES} 分で入れてください。`); return }
    setSaving(true); setError('')
    try {
      const res = await inboxRoutingApi.save(accountId, {
        strategy: 'none', enabled: draft.enabled, firstResponseMinutes: minutes, businessHoursOnly: draft.businessHoursOnly,
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
                {/* 1行の切り替え。今の口で選べるのは「しない」だけなので、全体を選べない形にして並べる（準備中）。 */}
                <p className={styles.fixed}>担当を自動で割り当てない</p>
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
