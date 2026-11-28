'use client'


import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import CopyTextButton from '@/components/shared/copy-text-button'
import { emptyValue } from '@/components/shared/empty-value'
import EntitySelect,{ entityOptionMetadata } from '@/components/shared/entity-select'
import { EntityPickerField,type EntityPickerItem } from '@/components/shared/entity-picker'
import { Field as SharedField } from '@/components/shared/form-controls'
import { type GridTableDesign } from '@/components/shared/grid-table'
import Notice from '@/components/shared/notice'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { type AccountWithStats } from '@/contexts/account-context'
import { ApiError } from '@/lib/api'
import { restaurantTestApi,type RestaurantIntakeAddress,type RestaurantMembership,type RestaurantStore } from '@/lib/restaurant-test-api'
import type { RestaurantLoginMember } from '@line-crm/shared'
import { Check,MailPlus,MessageCircle,Plus,type LucideIcon } from 'lucide-react'
import { useCallback,useEffect,useLayoutEffect,useRef,useState,type FormEvent,type ReactNode } from 'react'
import { useFormInputDirty } from '@/components/shared/form-input-dirty'
import { formatStamp, Panel, Status } from '@/v8/restaurant/common-a/public/parts/index'
import styles from './organization.module.css'

export const roleLabel: Record<RestaurantMembership['role'], string> = {
  super_admin: '統括管理者',
  store_manager: '店舗管理者',
  staff: 'スタッフ',
}

export const MATRIX: [string, boolean, boolean, boolean][] = [
  ['全店閲覧・契約設定', true, false, false],
  ['担当店舗の設定・承認', true, true, false],
  ['予約入力・配席', true, true, true],
  ['Google/LINE公開承認', true, true, false],
]

export const tableDesign: Omit<GridTableDesign, 'columns'> = {
  gap: 'var(--polish-space-card)',
  rowPadding: '0 var(--tpl-list-inset)',
  headHeight: 'var(--polish-table-head)',
  rowHeight: 'var(--polish-table-row)',
  fontSize: 'var(--polish-text-body)',
}

export function intakeAddressError(error: unknown): string {
  if (error instanceof ApiError && error.status === 503) return '取り込み用ドメインが未設定です'
  if (error instanceof ApiError && error.status === 403) return permissionDeniedMessage('store')
  return '取り込みアドレスを読み込めませんでした。'
}

export function loginSummary(member: RestaurantMembership): string {
  if (!member.staff_id) return 'ログイン未連携'
  const role = member.loginRole === 'owner' ? 'オーナー' : member.loginRole === 'admin' ? '管理者' : 'スタッフ'
  const scope = member.loginAccountScope === 'all' ? '全アカウント' : '担当アカウントのみ'
  return `${member.loginName || 'ログインメンバー'}・${role}${member.loginAccessLevel === 'read_only' ? '（閲覧のみ）' : ''}・${scope}・版 ${member.loginPolicyVersion ?? emptyValue('unknown')}`
}

export function Field({ label, name, type = 'text', defaultValue, required = false }: { label: string; name: string; type?: string; defaultValue?: string; required?: boolean }) {
  return <SharedField label={label} required={required}><TextField name={name} type={type} defaultValue={defaultValue} required={required} /></SharedField>
}

export function DefaultSelect({ name, ariaLabel, defaultValue, options }: {
  name: string
  ariaLabel: string
  defaultValue: string
  options: { value: string; label: string; disabled?: boolean }[]
}) {
  const [value, setValue] = useState(defaultValue)
  return <SaveErrorField names={["value"]}><Select name={name} aria-label={ariaLabel} value={value} onChange={setValue} size="full" options={options} /></SaveErrorField>
}

/** 作ってある物を選ぶ欄（選ぶ窓・）。フォームへは隠し欄で送る。 */
function PickerInput({ name, label, noun, items, defaultValue, placeholder, icon, required = false, clearable = false, onPickingChange }: {
  name: string
  label: string
  noun: string
  items: EntityPickerItem[]
  defaultValue: string
  placeholder?: string
  icon?: LucideIcon
  required?: boolean
  clearable?: boolean
  onPickingChange?: (dirty: boolean) => void
}) {
  const [value, setValue] = useState(defaultValue)
  return <SharedField label={label} required={required}>
    <>
      <SaveErrorField names={[name]}><EntityPickerField label={label} noun={noun} icon={icon} items={items} value={value} onChange={setValue} onSelect={id => onPickingChange?.(id !== value)} onClose={() => onPickingChange?.(false)} placeholder={placeholder} clearable={clearable} /></SaveErrorField>
      <input type="hidden" name={name} value={value} />
    </>
  </SharedField>
}

export function StoreLineAccountSelect({ accounts, stores, currentStore, onPickingChange }: {
  accounts: AccountWithStats[]
  stores: RestaurantStore[]
  currentStore?: RestaurantStore
  onPickingChange?: (dirty: boolean) => void
}) {
  const usedByAccount = new Map(stores.filter((item) => item.line_account_id).map((item) => [item.line_account_id!, item.id]))
  const items: EntityPickerItem[] = accounts.map((account) => {
    const usedStoreId = usedByAccount.get(account.id)
    const usedElsewhere = Boolean(usedStoreId && usedStoreId !== currentStore?.id)
    const name = account.displayName || account.name
    return {
      id: account.id,
      name: account.basicId ? `${name}（${account.basicId.startsWith("@") ? "" : "@"}${account.basicId}）` : name,
      keywords: account.basicId ?? undefined,
      disabled: usedElsewhere,
      meta: usedElsewhere ? '他店舗で使用中' : undefined,
    }
  })
  return (
    <div className={styles.fieldWide}>
      <PickerInput name="lineAccountId" label="LINE公式アカウント" noun="LINE公式アカウント" icon={MessageCircle} items={items} defaultValue={currentStore?.line_account_id || ''} onPickingChange={onPickingChange} required />
    </div>
  )
}

/** 店舗の追加・編集（窓 ）。 */
export function StoreForm({ store, accounts, stores, busy, onSubmit, onCancel, onDirtyChange }: {
  store?: RestaurantStore
  accounts: AccountWithStats[]
  stores: RestaurantStore[]
  busy: boolean
  onSubmit: (form: FormData) => void
  onCancel: () => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const formDirty = useFormInputDirty(true)
  const [picking, setPicking] = useState(false)
  useLayoutEffect(() => { onDirtyChange?.(formDirty.dirty || picking) }, [formDirty.dirty, picking, onDirtyChange])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit(new FormData(event.currentTarget))
  }
  return (
    <form key={store?.id ?? 'new'} onSubmit={submit} className={styles.form}>
      <div className={styles.formGrid} ref={formDirty.ref as React.Ref<HTMLDivElement>} onChangeCapture={formDirty.onChangeCapture} onChange={formDirty.onChange} onClickCapture={formDirty.onClickCapture}>
        <Field label="店舗名" name="name" defaultValue={store?.name} required />
        <Field label="店舗コード" name="code" defaultValue={store?.code} required />
        <Field label="エリア" name="area" defaultValue={store?.area || ''} />
        <Field label="収容人数" name="capacity" type="number" defaultValue={String(store?.capacity ?? 24)} required />
        <div className={styles.field}><span className={styles.fieldLabel}>タイムゾーン</span><span>日本時間（Asia/Tokyo）</span><SaveErrorField names={["timezone"]}><input type="hidden" name="timezone" value="Asia/Tokyo" /></SaveErrorField></div>
        {store ? (
          <SharedField label={<><span className={styles.fieldLabel}>状態</span></>}><DefaultSelect name="status" ariaLabel="状態" defaultValue={store.status} options={[{ value: 'active', label: '有効' }, { value: 'paused', label: '停止中' }, { value: 'archived', label: 'アーカイブ' }]} /></SharedField>
        ) : null}
        <StoreLineAccountSelect accounts={accounts} stores={stores} currentStore={store} onPickingChange={setPicking} />
      </div>
      <div className={styles.formActions}>
        <Button type="button" disabled={busy} onClick={onCancel}>キャンセル</Button>
        <Button variant="primary" type="submit" disabled={busy}>{store ? <Check aria-hidden className={styles.buttonIcon} /> : null}{store ? '保存する' : '店舗を登録する'}</Button>
      </div>
    </form>
  )
}

type IntakeLoadState =
  | { scope: string; status: 'idle' }
  | { scope: string; status: 'loading' }
  | { scope: string; status: 'ready'; addresses: RestaurantIntakeAddress[] }
  | { scope: string; status: 'error'; error: string }

/** 予約メール取り込みアドレス（今の画面と同じ口：一覧・発行・再発行の確認・コピー）。 */
export function IntakeAddressPanel({ accountId, store, readOnly }: { accountId: string; store: RestaurantStore | null; readOnly: boolean }) {
  const storeId = store?.id || ''
  const scope = accountId && storeId ? `${accountId}:${storeId}` : ''
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const loadSeqRef = useRef(0)
  const issuingRef = useRef(false)
  const [loadState, setLoadState] = useState<IntakeLoadState>(() => ({ scope, status: scope ? 'loading' : 'idle' }))
  const [issuing, setIssuing] = useState(false)
  const [reissueOpen, setReissueOpen] = useState(false)
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')

  const loadAddresses = useCallback(async (preserveNotice = false) => {
    const seq = ++loadSeqRef.current
    const requestScope = accountId && storeId ? `${accountId}:${storeId}` : ''
    if (!requestScope) {
      setLoadState({ scope: '', status: 'idle' })
      setActionError('')
      setNotice('')
      return
    }
    setLoadState({ scope: requestScope, status: 'loading' })
    setActionError('')
    if (!preserveNotice) setNotice('')
    try {
      const response = await restaurantTestApi.listIntakeAddresses(accountId, storeId)
      if (loadSeqRef.current !== seq || scopeRef.current !== requestScope) return
      if ((response as { success?: boolean } | null)?.success === false || !Array.isArray(response?.data)) {
        setLoadState({ scope: requestScope, status: 'error', error: '取り込みアドレスを読み込めませんでした。' })
        return
      }
      setLoadState({ scope: requestScope, status: 'ready', addresses: response.data })
    } catch (caught) {
      if (loadSeqRef.current !== seq || scopeRef.current !== requestScope) return
      setLoadState({ scope: requestScope, status: 'error', error: intakeAddressError(caught) })
    }
  }, [accountId, storeId])

  useEffect(() => {
    setReissueOpen(false)
    setActionError('')
    setNotice('')
    issuingRef.current = false
    setIssuing(false)
    void loadAddresses(false)
    return () => { loadSeqRef.current += 1 }
  }, [loadAddresses])

  const scopedState: IntakeLoadState = loadState.scope === scope ? loadState : { scope, status: scope ? 'loading' : 'idle' }
  const loading = scopedState.status === 'loading'
  const error = scopedState.status === 'error' ? scopedState.error : ''
  const addresses = scopedState.status === 'ready' ? scopedState.addresses : []

  const issue = async () => {
    if (!scope || error || issuingRef.current) return false
    const requestScope = scope
    const hadExisting = addresses.length > 0
    issuingRef.current = true
    setIssuing(true)
    setNotice('')
    setActionError('')
    try {
      const result = await restaurantTestApi.issueIntakeAddress(accountId, storeId)
      if (scopeRef.current !== requestScope) return false
      if ((result as { success?: boolean } | null)?.success === false) {
        setActionError('取り込みアドレスを発行できませんでした。もう一度お試しください。')
        return false
      }
      setReissueOpen(false)
      setNotice(hadExisting ? '新しいアドレスを発行しました。旧アドレスは90日後に失効します。' : '取り込みアドレスを発行しました。')
      void loadAddresses(true)
      return true
    } catch (caught) {
      if (scopeRef.current !== requestScope) return false
      setActionError(intakeAddressError(caught))
      return false
    } finally {
      if (scopeRef.current === requestScope) {
        issuingRef.current = false
        setIssuing(false)
      }
    }
  }

  return (
    <Panel title="予約メール取り込みアドレス" description="予約サイトから届く通知メールの転送先として設定します。">
      <div className={styles.intakeBody}>
      <Notice tone="warn">このアドレスは予約メールの専用受信口です。第三者へ共有せず、予約サイトの通知設定だけに使用してください。</Notice>
      {notice ? <Notice tone="success" role="status">{notice}</Notice> : null}
      {actionError ? <Notice tone="danger" className={styles.intakeErrorNoticePlacement} >{actionError}</Notice> : null}
      {!store ? (
        <p className={styles.muted}>上部の店舗選択から、設定する店舗を選んでください。</p>
      ) : loading ? (
        <p className={styles.muted}>取り込みアドレスを確認中…</p>
      ) : error ? (
        <Notice tone="danger" action={<Button onClick={() => void loadAddresses(false)}>もう一度読み込む</Button>}>{error}</Notice>
      ) : addresses.length === 0 ? (
        <Notice tone="info">{emptyValue('unconfigured')}</Notice>
      ) : (
        addresses.map((item, saveFieldIndex) => (
          <Card key={item.id} surface="muted" padding="compact" layout="vertical" gap="var(--polish-space-row)">
            <div className={styles.intakeCardHead}>
              <span className={styles.intakeState}>{item.revokedAt ? `${formatStamp(item.revokedAt)}まで有効` : '現在使用中'}</span>
              <span className={styles.spacer} aria-hidden="true" />
              <Status value={item.status} />
            </div>
            <div className={styles.intakeRow}>
              <SaveErrorField names={[`addresses.${saveFieldIndex}.address`,"address","item.address"]}><TextField aria-label={`${store.name}の取り込みアドレス`} readOnly value={item.address} className={styles.intakeAddress} /></SaveErrorField>
              <CopyTextButton value={item.address} aria-label="メールアドレスをコピー"  />
            </div>
            <p className={styles.intakeMeta}>{`発行日時：${formatStamp(item.createdAt)}`}</p>
          </Card>
        ))
      )}
      {store && !error && !readOnly ? (
        <div className={styles.intakeFoot}>
          <Button disabled={issuing || loading} onClick={() => { if (addresses.length > 0) setReissueOpen(true); else void issue() }} busy={issuing} busyLabel="発行中…">
            <MailPlus aria-hidden className={styles.buttonIcon} />アドレスを発行
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={reissueOpen}
        designNode="rSRFK"
        title="新しい取り込みアドレスを発行しますか？"
        description="いまのアドレスは90日後に失効します。それまでに、媒体側の通知先を新しいアドレスへ変えてください。変えないと予約の取り込みが止まります。"
        confirmLabel="発行する"
        busy={issuing}
        onCancel={() => setReissueOpen(false)}
        error={actionError || undefined} onSuccess={() => setReissueOpen(false)} onConfirm={() => issue()}
      />
      </div>
    </Panel>
  )
}

/** ログインとの連携（窓  の中。今の画面では表の中にあった）。 */
export function LoginConnection({ member, logins, busy, save, onDirtyChange }: { member: RestaurantMembership; logins: RestaurantLoginMember[]; busy: boolean; save: (id: string | null) => void; onDirtyChange: (dirty: boolean) => void }) {
  const [selected, setSelected] = useState(member.staff_id || '')
  useEffect(() => setSelected(member.staff_id || ''), [member.staff_id])
  useLayoutEffect(() => { onDirtyChange(selected !== (member.staff_id || '')) }, [selected, member.staff_id, onDirtyChange])
  return (
    <div className={styles.loginBox}>
      <span className={styles.fieldLabel}>ログインとの連携</span>
      <p className={styles.muted}>{loginSummary(member)}</p>
      {logins.length ? (
        <div className={styles.loginRow}>
          <SaveErrorField names={["selected"]}><EntitySelect aria-label={`${member.staff_name}のログインメンバー`} value={selected} onChange={setSelected} size="full" options={[{ value: '', label: '連携しない' }, ...logins.map((l) => ({ ...entityOptionMetadata(l), value: l.id, label: l.name }))]} /></SaveErrorField>
          <Button disabled={busy || selected === (member.staff_id || '')} onClick={() => save(selected || null)}>ログインと連携</Button>
        </div>
      ) : null}
    </div>
  )
}

/** ユーザーの追加・変更（窓 ）。 */
export function MemberForm({ member, stores, busy, onSubmit, onCancel, login, onDirtyChange }: {
  member?: RestaurantMembership
  stores: RestaurantStore[]
  busy: boolean
  onSubmit: (form: FormData) => void
  onCancel: () => void
  login?: ReactNode
  onDirtyChange?: (dirty: boolean) => void
}) {
  const formDirty = useFormInputDirty(true)
  const [picking, setPicking] = useState(false)
  useLayoutEffect(() => { onDirtyChange?.(formDirty.dirty || picking) }, [formDirty.dirty, picking, onDirtyChange])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSubmit(new FormData(event.currentTarget))
  }
  return (
    <form key={member?.id ?? 'new'} onSubmit={submit} className={styles.form}>
      <div className={`${styles.formGrid} ${styles.memberGrid}`} ref={formDirty.ref as React.Ref<HTMLDivElement>} onChangeCapture={formDirty.onChangeCapture} onChange={formDirty.onChange} onClickCapture={formDirty.onClickCapture}>
        <Field label="氏名" name="staffName" defaultValue={member?.staff_name} required />
        <Field label="メール" name="email" type="email" defaultValue={member?.email ?? ''} />
        <SharedField label={<><span className={styles.fieldLabel}>役割</span></>}><DefaultSelect name="role" ariaLabel="役割" defaultValue={member?.role ?? 'staff'} options={(['staff', 'store_manager', 'super_admin'] as const).map(value => ({ value, label: roleLabel[value] }))} /></SharedField>
        <PickerInput name="storeId" label="担当店舗" noun="店舗" items={stores.map((s) => ({ id: s.id, name: s.name, meta: [s.code, s.area].filter(Boolean).join('・') || undefined, keywords: s.code }))} defaultValue={member?.store_id ?? ''} onPickingChange={setPicking} placeholder="全店舗" clearable />
        <Field label="LINE通知UID" name="lineUid" defaultValue={member?.line_uid ?? ''} />
        <Field label="Googleメール" name="googleEmail" type="email" defaultValue={member?.google_email ?? ''} />
      </div>
      {login}
      <div className={`${styles.formActions} ${styles.memberActions}`}>
        <Button type="button" disabled={busy} onClick={onCancel}>キャンセル</Button>
        <Button variant="primary" type="submit" disabled={busy}>{member ? null : <Plus aria-hidden className={styles.buttonIcon} />}{member ? '保存する' : '追加する'}</Button>
      </div>
    </form>
  )
}
