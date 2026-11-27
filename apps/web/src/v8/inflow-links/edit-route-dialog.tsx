'use client'

import { requiredText } from '@/lib/form-requirement'
const FIELD_REQUIREMENTS = {
  form_name: requiredText("流入元の名前を入力してください"),
}


import { useContext, useEffect, useRef, useState } from 'react'
import Combobox from '@/components/shared/combobox'
import Select from '@/components/shared/select'
import { api, describeSaveFailure } from '@/lib/api'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import Dialog from '@/components/shared/dialog'
import Notice from '@/components/shared/notice'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import CouponSettings from './coupon-settings'
import { focusField } from './focus-field'
import type {
  EntryRoute,
  CreateEntryRouteInput,
  TrafficPool,
  Scenario,
  Tag,
} from '@line-crm/shared'
import { withPermissionFailure } from '@/components/shared/api-error-message'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { SaveConflictBand, SaveConflictCompareDialog, useSaveConflict, isConflictResponse } from '@/components/shared/save-conflict'
import EditorSurface from '@/components/shared/editor-surface'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'

/*
 * ★V8 の一覧（src/v8/inflow-links/list.tsx）用の写し。元は
 * app/inflow-links/_components/edit-route-modal.tsx（src/v8 からは import できない）。
 * 中身（保存する口・送る形・失敗の出し方）は元と同じ。元を直したらここも直す。
 */

interface MessageTemplate {
  id: string
  name: string
  messageType: string
  messageContent: string
}

interface Props {
  surface?: 'page' | 'dialog' | 'inline'
  route: EntryRoute | null
  pools: TrafficPool[]
  scenarios: Scenario[]
  templates: MessageTemplate[]
  tags: Tag[]
  existingGenres: string[]
  initialGenre?: string
  /** Pre-filled ref_code for "register an unregistered inflow ref" flow. */
  initialRefCode?: string
  /**
   * #514-5: 親が一覧表示のために既に引いたプール別の所属名。渡されたら
   * 取り直さない。編集窓を開くたびの N+1 を無くす。
   */
  poolMemberNames?: Record<string, string[]>
  /**
   * R39: 新規作成時に所属させるLINEアカウント。一覧のヘッダー選択を渡す。
   * 更新では所属を変えないので使わない。
   */
  accountId?: string | null
  onClose: () => void
  onSaved: (savedRoute: EntryRoute, created: boolean) => void
}

export default function EditRouteModal({
  route,
  pools,
  scenarios,
  templates,
  tags,
  existingGenres,
  initialGenre,
  initialRefCode,
  poolMemberNames,
  accountId,
  surface,
  onClose,
  onSaved,
}: Props) {
  const saveErrors = useSaveFormErrors()
  // Per-pool member account names, loaded lazily so the dropdown can show
  // "Pool 名 — アカA, アカB" instead of just the pool name.
  const [poolMembers, setPoolMembers] = useState<Record<string, string[]>>(poolMemberNames ?? {})
  const [poolStatus, setPoolStatus] = useState<'loading' | 'ready' | 'error'>(poolMemberNames || pools.length === 0 ? 'ready' : 'loading')
  useEffect(() => {
    if (poolMemberNames) {
      setPoolMembers(poolMemberNames)
      setPoolStatus('ready')
      return
    }
    let cancelled = false
    setPoolStatus(pools.length ? 'loading' : 'ready')
    ;(async () => {
      const result = pools.length > 0
        ? await api.pools.listAccounts(
            pools.map((pool) => pool.id),
            { suppressFeatureDisabledEvent: true },
          ).catch(() => ({ success: false as const }))
        : { success: true as const, data: [] }
      if (!cancelled && result.success) {
        setPoolMembers(Object.fromEntries(result.data.map(({ poolId, accounts }) => [
          poolId,
          accounts.filter((account) => account.isActive).map((account) => account.accountName ?? emptyValue('unknown')),
        ])))
        setPoolStatus('ready')
      } else if (!cancelled) {
        setPoolStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pools, poolMemberNames])
  const isNew = !route
  const mainPool = pools.find((p) => p.slug === 'main')
  // Unregistered-ref registration flow: refCode is fixed (the actual ref code
  // that has already been seen in inflow), so we lock the input to prevent
  // the user from accidentally renaming the ref and orphaning the prior stats.
  const refCodeLocked = isNew && !!initialRefCode
  const genreLocked = isNew && !!initialGenre
  const formValues = (source: EntryRoute | null): CreateEntryRouteInput => ({
    refCode: source?.refCode ?? initialRefCode ?? '',
    genre: source?.genre ?? initialGenre ?? '',
    name: source?.name ?? '',
    tagId: source?.tagId ?? null,
    poolId: source?.poolId ?? mainPool?.id ?? null,
    scenarioId: source?.scenarioId ?? null,
    introTemplateId: source?.introTemplateId ?? null,
    couponEnabled: source?.couponEnabled ?? false,
    couponAssetId: source?.couponAssetId ?? null,
    couponAudience: source?.couponAudience ?? 'new_friends',
    runAccountFriendAddScenarios: source?.runAccountFriendAddScenarios ?? true,
    redirectUrl: source?.redirectUrl ?? null,
    isActive: source?.isActive ?? true,
  })
  const [form, setForm] = useState<CreateEntryRouteInput>(() => formValues(route))
  const originalForm = useRef(JSON.stringify(form))
  const [baseline, setBaseline] = useState(route?.updatedAt)
  const conflict = useSaveConflict({
    contextKey: route?.id,
    fetchLatest: async () => {
      if (!route) return null
      const res = await api.entryRoutes.get(route.id)
      return res.success ? res.data : null
    },
    reload: async () => {
      if (!route) return
      try {
        const res = await api.entryRoutes.get(route.id)
        if (!res.success) throw new Error('reload_failed')
        const latest = res.data
        const latestValues = formValues(latest)
        originalForm.current = JSON.stringify(latestValues)
        setForm(latestValues)
        setBaseline(latest.updatedAt)
        conflict.clear()
        setError('')
      } catch {
        setError('最新の内容を読み込めませんでした。入力は残っています。もう一度お試しください。')
      }
    },
  })
  const [submitting, setSubmitting] = useState(false)
  const depth = useContext(OverlayDepthContext)
  const guard = useUnsavedGuard({
    dirty: surface !== 'page' && (JSON.stringify(form) !== originalForm.current || submitting),
    busy: surface !== 'page' && submitting,
    onDiscard: onClose,
  })
  const [warning, setWarning] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const validateFields = () => {
    const errors: Record<string, string> = {}
    if ((FIELD_REQUIREMENTS.form_name.check(form.name) !== null)) errors['route-name'] = '流入元の名前を入力してください'
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(form.refCode)) errors['route-ref'] = '半角英数字・_・ハイフンで1〜64文字にしてください'
    if (form.couponEnabled && !form.couponAssetId) errors['route-coupon'] = '渡すクーポンを選んでください'
    setFieldErrors(errors)
    setError('')
    if (Object.keys(errors).length) { focusField(Object.keys(errors)[0]); return false }
    return true
  }

  const validateBeforeSave = () => {
    const nothingDelivers =
      !form.runAccountFriendAddScenarios && !form.scenarioId && !form.introTemplateId
    if (nothingDelivers && !form.couponEnabled) {
      setWarning(
        '上書きモードかつ起動シナリオも即時 push も未設定です。このリンクで友だち追加した人には何も届きません。続行しますか?',
      )
      return false
    }
    return true
  }

  const doSave = async () => {
    if (!validateFields()) return
    setSubmitting(true)
    setError('')
    try {
      // R39: 新規作成は所属が必須。選んでいなければ送らず理由を出す。
      if (isNew && !accountId) {
        setError('LINEアカウントを選んでください（画面上部で選べます）')
        return
      }
      const res = isNew
        ? await api.entryRoutes.create({ ...form, lineAccountId: accountId ?? null })
        : await api.entryRoutes.update(route!.id, { ...form, expectedUpdatedAt: baseline })
      if (res.success) { guard.disarm(); onSaved(res.data, isNew) }
      else setError(res.error ?? '保存に失敗しました。通信を確かめて、もう一度お試しください。')
    } catch (err) {
      // 新規の識別子重複と、更新時の版の競合は別の409。新規は入力を直して再試行できるままにする。
      if (!isNew && isConflictResponse(err) && err.code === 'VERSION_CONFLICT') { conflict.mark(); return }
      const fieldFailure = saveErrors.capture(err)
      // 400系はAPIの理由、403・5xxは運用の言葉へ写す（WRITE-01）。
      { if (!fieldFailure)

      setError(withPermissionFailure(err, describeSaveFailure(err), 'store')) }
    } finally {
      // 失敗時に「保存中…」のまま固まらないよう、必ず戻す。
      setSubmitting(false)
    }
  }

  const onSubmit = async () => {
    if (!validateFields()) return
    // If validation produced a warning, only the explicit "それでも保存"
    // button (which calls doSave directly) may bypass it. The main save
    // button must not be a second-click escape hatch.
    if (!validateBeforeSave()) return
    await doSave()
  }

  // R270: 作成と同じくフォルダは任意。空欄は未分類のまま保存する。
  const saveDisabled = submitting || conflict.conflict !== null
  const latestForm = conflict.latest ? formValues(conflict.latest) : null
  const comparisonLines = latestForm ? Object.entries(form)
    .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(latestForm[key as keyof CreateEntryRouteInput]))
    .map(([key, value]) => ({ text: `${routeFieldLabel(key)}：下書き ${routeFieldValue(key, value, { tags, pools, scenarios, templates })} ／ 最新 ${routeFieldValue(key, latestForm[key as keyof CreateEntryRouteInput], { tags, pools, scenarios, templates })}` })) : null

  return (
    <SaveErrorScope errors={saveErrors}><EditorSurface surface={surface}
      open
      title={isNew ? '新規リファラルリンク' : 'リファラルリンク編集'}
      busy={submitting}
      error={error || fieldErrors['route-coupon'] || undefined}
      onCancel={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={submitting}>
            キャンセル
          </Button>
          <Button
            variant="primary"
            onClick={onSubmit}
            disabled={saveDisabled} title={conflict.conflict ? '最新の内容を読み込んでから保存してください' : undefined} busy={submitting}>
            {isNew ? '作る' : '保存する'}
          </Button>
        </div>
      }
    >
      {conflict.conflict ? <SaveConflictBand title="ほかの人が先にこの流入リンクを保存しました" onCompare={conflict.compare} compareBusy={conflict.compareBusy} onReload={conflict.reloadLatest} /> : null}
      <SaveConflictCompareDialog open={conflict.compareOpen} error={conflict.compareError} lines={comparisonLines} onReload={conflict.reloadLatest} onCancel={conflict.closeCompare} />
      <div className="space-y-3">
        <Field note={<>
            {genreLocked
              ? '左側で選択したフォルダへ登録されます。'
              : '同じ協力会社や媒体を同じフォルダ名にすると、一覧でまとめて管理できます。空欄のまま保存すると未分類になります。'}
          </>} label="フォルダ（任意）">
          <SaveErrorField names={["genre","form.genre"]}><TextField
            list={genreLocked ? undefined : 'referral-genre-options'}
            value={form.genre ?? ''}
            // R270: 空欄は未分類として null で送る。空文字のまま送ると
            // 口が400ではじくため、ここで null に寄せる。
            onChange={(e) => setForm({ ...form, genre: e.target.value.trim() ? e.target.value : null })}
            readOnly={genreLocked}
            placeholder="例：SNS（空欄なら未分類）"
            maxLength={80}
          /></SaveErrorField>
          <datalist id="referral-genre-options">
            {existingGenres.map((genre) => <option key={genre} value={genre} />)}
          </datalist>

        </Field>

        <Field label="流入元の名前" htmlFor="route-name" error={fieldErrors['route-name']} requirement={FIELD_REQUIREMENTS.form_name}>
          <SaveErrorField names={["name","form.name"]}><TextField
            value={form.name}
            onChange={(e) => { setForm({ ...form, name: e.target.value }); setFieldErrors((old) => ({ ...old, 'route-name': '' })) }}
            placeholder="例：Instagram プロフィール"
            maxLength={120}
          /></SaveErrorField>
        </Field>

        <Field label="URLに出る識別子" htmlFor="route-ref" error={fieldErrors['route-ref']}>
          <SaveErrorField names={["refCode","form.refCode","ref_code","form.ref_code"]}><TextField
            value={form.refCode}
            onChange={(e) => { setForm({ ...form, refCode: e.target.value }); setFieldErrors((old) => ({ ...old, 'route-ref': '' })) }}
            // R271: 作成済みの識別子は口も変更を拒否する。保存時にはじめて
            // 拒否せず、欄自体を読み取り専用にして理由を近くに出す。
            disabled={refCodeLocked || !isNew}
            aria-describedby={refCodeLocked || !isNew ? 'route-ref-lock-reason' : undefined}
            placeholder="例：youtube"
          /></SaveErrorField>
          {refCodeLocked && (
            <p id="route-ref-lock-reason" className="text-ink-faint mt-1 text-xs">
              既に流入があった識別子を登録中のため、URLに出る識別子は変更できません。
            </p>
          )}
          {!isNew && (
            <p id="route-ref-lock-reason" className="text-ink-faint mt-1 text-xs">
              URLに出る識別子は作成後に変更できません。新しいURLが必要な場合は、新しいリンクを作成してください。
            </p>
          )}
        </Field>

        <Field note={<>
            友だち追加時にこのタグを自動付与します。タグ未作成の場合は先にタグを作成してください。
          </>} label="自動付与タグ（任意）">
          <SaveErrorField names={["tagId","form.tagId","tag_id","form.tag_id"]}><EntitySelect clearable size="full" kind="tag"
            aria-label="自動付与タグ（任意）"
            placeholder="— 設定なし —"
            value={form.tagId ?? ''}
            onChange={(next) => setForm({ ...form, tagId: next || null })}
            options={tags.map((tag) => ({ ...entityOptionMetadata(tag), value: tag.id, label: tag.name }))}
            className="w-full"
          /></SaveErrorField>

        </Field>

        <Field label="送り先 Pool">
          <SaveErrorField names={["poolId","form.poolId","pool_id","form.pool_id"]}><EntitySelect
            aria-label="送り先 Pool"
            value={form.poolId ?? ''}
            onChange={(value) => setForm({ ...form, poolId: value || null })}
            size="full"
            options={pools.map((p) => {
              const members = poolMembers[p.id] ?? []
              const memberText = poolStatus === 'loading' ? '（所属を確認中）' : poolStatus === 'error' ? '（所属を確認できませんでした）' :
                members.length === 0
                  ? '（アカウント未所属）'
                  : `— ${members.join(', ')}`
              return { ...entityOptionMetadata(p),
                value: p.id,
                label: `${p.name}${p.slug === 'main' ? '（既定）' : ''} ${memberText}`,
              }
            })}
          /></SaveErrorField>
        </Field>

        <Field label="起動シナリオ（任意）">
          <SaveErrorField names={["scenarioId","form.scenarioId","scenario_id","form.scenario_id"]}><EntitySelect clearable size="full" kind="scenario"
            aria-label="起動シナリオ（任意）"
            placeholder="— 設定なし —"
            value={form.scenarioId ?? ''}
            onChange={(next) => setForm({ ...form, scenarioId: next || null })}
            options={scenarios.map((s) => ({ ...entityOptionMetadata(s), value: s.id, label: s.name }))}
            className="w-full"
          /></SaveErrorField>
        </Field>

        <Field label="即時 push テンプレ（任意）">
          <SaveErrorField names={["introTemplateId","form.introTemplateId","intro_template_id","form.intro_template_id"]}><EntitySelect clearable size="full" kind="template"
            aria-label="即時 push テンプレ（任意）"
            placeholder="— 設定なし —"
            value={form.introTemplateId ?? ''}
            onChange={(next) => setForm({ ...form, introTemplateId: next || null })}
            options={templates.map((t) => ({ ...entityOptionMetadata(t), value: t.id, label: t.name }))}
            className="w-full"
          /></SaveErrorField>
        </Field>

        <SaveErrorField names={["runAccountFriendAddScenarios","form.runAccountFriendAddScenarios","run_account_friend_add_scenarios","form.run_account_friend_add_scenarios"]}><Checkbox
          checked={form.runAccountFriendAddScenarios ?? true}
          onCheckedChange={(checked) => {
            setForm({
              ...form,
              runAccountFriendAddScenarios: checked,
            })
            setWarning(null)
          }}
          description="OFF にするとアカウント標準シナリオは抑止され、このリンクの設定だけが流れます。"
        >アカウント標準の友だち追加時設定も実行する（並走モード）</Checkbox></SaveErrorField>

        {warning && (
          <Notice
            tone="warn"
            message={warning}
            action={(
              <Button
                onClick={doSave}
                disabled={submitting} busy={Boolean(submitting)} busyLabel="処理中…"
              >
                それでも保存する
              </Button>
            )}
          />
        )}
      </div>
      <CouponSettings accountId={route?.lineAccountId ?? accountId} disabled={submitting}
        value={{ couponEnabled: form.couponEnabled ?? false, couponAssetId: form.couponAssetId ?? null, couponAudience: form.couponAudience ?? 'new_friends' }}
        onChange={(next) => { setForm((current) => ({ ...current, ...next })); setFieldErrors((current) => ({ ...current, 'route-coupon': '' })) }} />
    </EditorSurface>
    <OverlayDepthContext.Provider value={depth + 2}>
      <UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={submitting} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} />
    </OverlayDepthContext.Provider></SaveErrorScope>
  )
}

function routeFieldLabel(key: string): string {
  return ({ refCode: '紹介コード', genre: 'フォルダ', name: '名前', tagId: '自動付与タグ', poolId: '送り先', scenarioId: '起動シナリオ', introTemplateId: '送信テンプレート', couponEnabled: 'クーポンの配布', couponAssetId: '配布クーポン', couponAudience: 'クーポンの対象', runAccountFriendAddScenarios: '友だち追加時のシナリオ', redirectUrl: '行き先URL', isActive: '公開' } as Record<string, string>)[key] ?? '設定'
}

function routeFieldValue(key: string, value: unknown, resources: { tags: Tag[]; pools: TrafficPool[]; scenarios: Scenario[]; templates: MessageTemplate[] }): string {
  if (value === null || value === undefined || value === '') return '未設定'
  if (typeof value === 'boolean') return value ? 'する' : 'しない'
  const list = key === 'tagId' ? resources.tags : key === 'poolId' ? resources.pools : key === 'scenarioId' ? resources.scenarios : key === 'introTemplateId' ? resources.templates : null
  if (list) return list.find(item => item.id === value)?.name ?? '選択済み（名前を読み込めませんでした）'
  if (key === 'couponAudience') return value === 'new_friends' ? '新しく友だちになった人' : 'すべての人'
  if (key === 'couponAssetId') return '選択済みのクーポン'
  return String(value)
}
