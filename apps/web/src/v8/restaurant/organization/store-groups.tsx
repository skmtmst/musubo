'use client'

import { isConflictResponse } from '@/components/shared/save-conflict'

import { useEffect, useRef, useState } from 'react'
import { readSaveFieldErrors } from '@/lib/api/helpers/field-errors'
import { describeSaveFailure } from '@/lib/api/transport/errors'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog from '@/components/shared/dialog'
import { SaveErrorScope, SaveErrorField, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { Field } from '@/components/shared/form-controls'
import { GridTable, GridRow, GridCell } from '@/components/shared/grid-table'
import ListState, { ListEmptyMessage } from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { RowActions } from '@/components/shared/row-actions'
import { TextField } from '@/components/shared/text-field'
import TruncatedText from '@/components/shared/truncated-text'
import { notifySaved, notifyToast } from '@/components/shared/toast'
import { restaurantTestApi, type RestaurantStore, type RestaurantStoreGroup } from '@/lib/restaurant-test-api'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { Panel, Status } from '@/v8/restaurant/common-a/public/parts/index'
import styles from './organization.module.css'
import { ToggleField } from '@/components/shared/toggle'

type Member = RestaurantStoreGroup['members'][number]
type Target = { group: RestaurantStoreGroup; member: Member; store: RestaurantStore; epoch: number }
type Settings = { referralEnabled: boolean; maxDistance: number }

function MemberEditor({ target, onClose, onReload, onSave }: {
  target: Target; onClose: () => void; onReload: () => void; onSave: (settings: Settings) => Promise<boolean | void>
}) {
  const [enabled, setEnabled] = useState(target.member.referral_enabled === 1)
  const [distance, setDistance] = useState(String(target.member.max_distance))
  const [confirming, setConfirming] = useState(false)
  const [validationBlocked, setValidationBlocked] = useState(false)
  const [fieldReasons, setFieldReasons] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const versionKnown = Number.isSafeInteger(target.member.version) && target.member.version > 0
  const fields = useSaveFormErrors()
  const saving = useRef(false)
  const dirty = enabled !== (target.member.referral_enabled === 1) || distance !== String(target.member.max_distance)
  const validDistance = distance.trim() !== '' && Number.isFinite(Number(distance)) && Number(distance) >= 0 && Number(distance) <= 1000
  const guard = useUnsavedGuard({ dirty, busy })
  const save = async () => {
    if (saving.current || conflict || !validDistance) return
    saving.current = true; setBusy(true); setError('')
    try {
      const accepted = await onSave({ referralEnabled: enabled, maxDistance: Number(distance) })
      if (accepted !== true) return
      guard.disarm(); onClose()
      return true
    } catch (error) {
      if (isConflictResponse(error)) { setConflict(true); setError('ほかの人が案内設定を変えました。読み直してから、もう一度選んでください。'); return false }
      fields.capture(error)
      const reasonsByField = readSaveFieldErrors(error)
      setFieldReasons(reasonsByField)
      const reasons = Object.values(reasonsByField)
      setValidationBlocked(reasons.length > 0)
      setError(reasons.length ? `${reasons.join(' ')} 戻って入力を直してください。` : `${describeSaveFailure(error)} 入力は残っています。`)
      return false
    } finally { saving.current = false; setBusy(false) }
  }
  return <SaveErrorScope errors={fields}>
    <Dialog open={!confirming} title={`${target.store.name}の案内設定`} description={`店の組：${target.group.name}`} dirty={dirty} busy={busy}
      onCancel={onClose} onConfirm={() => { setError(''); setConfirming(true) }} confirmLabel="保存する" confirmDisabled={validationBlocked || !dirty || !validDistance}>
      <div className={styles.form}>
        {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
        <SaveErrorField names={["referralEnabled", "input.referralEnabled"]}><ToggleField checked={enabled} onChange={value => { setEnabled(value); setValidationBlocked(false); setFieldReasons({}); setError('') }} description="満席のとき、同じ組の参加店へ案内します。閲覧権限は変わりません。">満席のとき案内に参加する</ToggleField></SaveErrorField>
        <Field label="案内する距離（km）" required error={validDistance ? fieldReasons.maxDistance ?? fieldReasons['input.maxDistance'] : '0〜1000の距離を入力してください。'}>
          <SaveErrorField names={["maxDistance", "input.maxDistance"]}><TextField type="number" min={0} max={1000} step="any" value={distance} onChange={e => { setDistance(e.target.value); setValidationBlocked(false); setFieldReasons({}); setError('') }} /></SaveErrorField>
        </Field>
      </div>
    </Dialog>
    <ConfirmDialog open={confirming} busy={busy} title={`${target.store.name}の案内設定を変えますか？`}
      description={`${target.group.name}での、この店舗の参加を${enabled ? '有効' : '停止中'}にし、案内する距離を${distance}kmにします。ほかの店舗の設定は変わりません。`}
      confirmLabel="保存する" cancelLabel={validationBlocked ? "戻って直す" : "キャンセル"} confirmDisabled={validationBlocked || conflict || !versionKnown} confirmDisabledReason={conflict || !versionKnown ? '読み直してから選び直してください。' : '戻って入力を直してください。'} error={error || undefined} onSuccess={() => setConfirming(false)} onCancel={() => conflict ? onReload() : setConfirming(false)} onConfirm={() => save()}>
      <OperationTargetSummary accounts={[{ id: target.store.line_account_id ?? '', name: target.store.line_account_id ? target.store.line_account_name : '不明' }]} store={{ id: target.store.id, name: target.store.name }} />
      {conflict ? <Button onClick={onReload}>読み直す</Button> : null}
    </ConfirmDialog>
    <UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={busy} onCancel={guard.cancelLeave} onConfirm={guard.confirmLeave} />
  </SaveErrorScope>
}

/** 既存の店の組を読む。変更の単位はAPIと同じ店舗1件。 */
export default function StoreGroups({ accountId, stores, readOnly }: {
  accountId: string; stores: RestaurantStore[]; readOnly: boolean
}) {
  const [groups, setGroups] = useState<RestaurantStoreGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [retry, setRetry] = useState(0)
  const [target, setTarget] = useState<Target | null>(null)
  const storesKey = JSON.stringify(stores.map(store => [store.id, store.line_account_id]))
  const scope = useRef({ accountId, readOnly, storesKey, epoch: 0 })
  if (scope.current.accountId !== accountId || scope.current.readOnly !== readOnly || scope.current.storesKey !== storesKey) scope.current = { accountId, readOnly, storesKey, epoch: scope.current.epoch + 1 }
  const generation = useRef(0)
  useEffect(() => { if (target) notifyToast('アカウントが変わったため、前の確認を閉じました。'); setTarget(null) }, [accountId])
  useEffect(() => {
    const request = ++generation.current
    setLoading(true); setLoadError(null)
    void restaurantTestApi.storeGroups(accountId).then(res => {
      if (request === generation.current) setGroups(res.data)
    }).catch(error => { if (request === generation.current) setLoadError(error) })
      .finally(() => { if (request === generation.current) setLoading(false) })
    return () => { generation.current++ }
  }, [accountId, retry])
  const save = async (settings: Settings) => {
    const currentStore = target && stores.find(store => store.id === target.store.id)
    if (!target || readOnly || target.epoch !== scope.current.epoch || !currentStore || currentStore.line_account_id !== target.store.line_account_id || !Number.isSafeInteger(target.member.version) || target.member.version < 1) return
    const request = generation.current
    await restaurantTestApi.updateStoreGroupMember(accountId, target.group.id, target.member.store_id, { ...settings, expectedVersion: target.member.version })
    if (request !== generation.current) return
    // PATCHが成功した値を保ち、読取りの失敗を「保存失敗」と取り違えない。
    setGroups(current => current.map(group => group.id !== target.group.id ? group : {
      ...group, members: group.members.map(member => member.store_id !== target.member.store_id ? member : {
        ...member, referral_enabled: settings.referralEnabled ? 1 : 0, max_distance: settings.maxDistance, version: target.member.version + 1,
      }),
    }))
    notifySaved(`${target.store.name}の案内設定を保存しました。`)
    setRetry(current => current + 1)
    return true
  }
  return <Panel title="店の組（満席のとき案内してよい店）" description="同じ組の店舗ごとに、案内への参加と距離を設定します。" flush>
    {loading ? <ListState kind="loading" /> : loadError ? <ListState kind="error" error={loadError} onRetry={() => setRetry(current => current + 1)} /> : groups.length === 0 ? <ListEmptyMessage>店の組：なし</ListEmptyMessage> :
      <GridTable label="店の組の店舗別設定" framed={false} design={{ columns: 'minmax(0, 1fr) var(--tpl-rt-col-80) var(--tpl-rt-col-130) var(--tpl-rt-col-80)', gap: 'var(--polish-space-card)', rowPadding: '0 var(--tpl-list-inset)', rowHeight: 'var(--polish-table-row)', fontSize: 'var(--polish-text-body)' }}>
        {groups.flatMap(group => group.members.map(member => {
          const store = stores.find(item => item.id === member.store_id)
          return <GridRow key={`${group.id}:${member.store_id}`}>
            <GridCell className={styles.storeText}>
              <TruncatedText value={store?.name ?? '—'} className={styles.memberName} />
              <TruncatedText value={group.name} className={styles.sub} />
            </GridCell>
            <GridCell><Status value={member.referral_enabled ? 'active' : 'disabled'} /></GridCell>
            <GridCell className={styles.shortText}>{member.max_distance}km まで</GridCell>
            <GridCell align="right">{readOnly || !store ? null : <RowActions subjectName={`${store.name}の案内設定`} edit={{ onClick: () => setTarget({ group, member, store, epoch: scope.current.epoch }) }} />}</GridCell>
          </GridRow>
        }))}
      </GridTable>}
    {target && !readOnly && target.epoch === scope.current.epoch ? <MemberEditor key={`${accountId}:${target.group.id}:${target.member.store_id}`} target={target} onClose={() => setTarget(null)} onReload={() => { setTarget(null); setRetry(current => current + 1) }} onSave={save} /> : null}
  </Panel>
}
