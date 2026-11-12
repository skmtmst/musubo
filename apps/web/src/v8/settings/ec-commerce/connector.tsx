'use client'
import { scrollMotion } from '@/components/shared/overlay-utils'
import { notifySaved } from '@/components/shared/toast'
import Link from '@/components/shared/list-navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { EC_EVENT_LABELS, type EcEventType } from '@line-crm/shared'
import Button from '@/components/shared/button'
import { PageFooter } from '@/components/templates/page-footer'
import Checkbox from '@/components/shared/checkbox'
import { SaveConflictBand, SaveConflictCompareDialog, useSaveConflict } from '@/components/shared/save-conflict'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import ListState from '@/components/shared/list-state'
import NoteBar from '@/components/shared/note-bar'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { useResponseGate } from '@/lib/use-response-gate'
import { ApiError, api, type EcConnector, type EcConnectorOverview } from '@/lib/api'
import { formatDateTime } from '@/lib/format'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import styles from './connector.module.css'
import Card from '@/components/shared/card'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { Field } from '@/components/shared/form-controls'
import StatusBadge from '@/components/shared/status-badge'
import { formatNumber as polishFormatNumber } from '@/lib/format'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'

/*
 * ★V8 EC連携 つなぎ先（板 ）。
 *
 * 並び：上の段に「つなぎ先の情報」（種類・アドレス・鍵）と右の「取り込みのようす」（今日・この30日・失敗・最後に成功）。
 * その下に板の幅で「取り込みの状態」（止める・再開・止めたとき）→「どこの出来事を取り込むか」（1行に並べる）→
 * 「どうやって人を見分けるか」（番号つき）→ いちばん下の行に「つながる先」と「設定を保存する」。
 * 口・保存の決まり（全部外すときの確認・止めるのは保存してから効く・離れるときの確認・競合の読み直し）は
 * 今の部品（app/ec-commerce/connector-panel.tsx）と同じ。
 */

/* 絵の並び（注文完了・発送完了・入金確認完了・返金完了・注文キャンセル・ペット情報更新）。 */
const CONNECTOR_EVENT_TYPES = [
  'ec.order.confirmed',
  'ec.order.shipped',
  'ec.order.payment_received',
  'ec.order.refunded',
  'ec.order.cancelled',
  'ec.customer.profile_updated',
] as const satisfies readonly EcEventType[]

const IDENTITY_RULES = [
  ['verified_email', 'メールアドレスが同じ', 'いちばん確かな照らし合わせです'],
  ['verified_phone', '電話番号が同じ', 'ハイフンや国番号の違いを整えて比べます'],
  ['manual_name_postal', '名前と郵便番号が同じ → 会員のつき合わせで人が決める', '候補へ並べ、人が確認してから結びつけます'],
] as const

type Form = {
  provider: EcConnector['provider']
  shopDomain: string
  status: EcConnector['status']
  inboundSecret: string
  eventTypes: string[]
  identityRules: EcConnector['identityRules']
  expectedVersion: number
}

const EMPTY_FORM: Form = {
  provider: 'shopify', shopDomain: '', status: 'connected', inboundSecret: '',
  eventTypes: [...CONNECTOR_EVENT_TYPES],
  identityRules: ['verified_email', 'verified_phone', 'manual_name_postal'], expectedVersion: 0,
}

function toForm(connector: EcConnector | null): Form {
  if (!connector) return EMPTY_FORM
  return {
    provider: connector.provider,
    shopDomain: connector.shopDomain,
    status: connector.status,
    inboundSecret: '',
    eventTypes: connector.eventTypes,
    identityRules: connector.identityRules,
    expectedVersion: connector.version,
  }
}

function when(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? emptyValue('unknown') : formatDateTime(date)
}

const READONLY_REASON = permissionDeniedMessage('store')

export default function EcConnector({ accountId, canEdit = true }: { accountId: string | null; canEdit?: boolean }) {
  const saveErrors = useSaveFormErrors()
  const [data, setData] = useState<EcConnectorOverview | null>(null)
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error' | 'forbidden'>('loading')
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<{ domain?: string; secret?: string }>({})
  const domainRef = useRef<HTMLInputElement>(null)
  const secretRef = useRef<HTMLInputElement>(null)
  const [replacingSecret, setReplacingSecret] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  /* 全部外すこと自体は止めない。保存の直前に確認を1枚だけ挟む。 */
  const [emptyConfirm, setEmptyConfirm] = useState<{ events: boolean; rules: boolean; accountId: string; form: Form; epoch: number } | null>(null)

  /*
   * WEB192：アカウントを変えたら、前のアカウントの遅い応答を捨てる（A の設定を B の欄へ入れない）。
   * 保存の結果も、押したときのアカウントのままのときだけ書く。
   */
  const gate = useResponseGate()
  const accountRef = useRef(accountId)
  accountRef.current = accountId
  const scopeRef = useRef({ accountId, canEdit, epoch: 0 })
  if (scopeRef.current.accountId !== accountId || scopeRef.current.canEdit !== canEdit) scopeRef.current = { accountId, canEdit, epoch: scopeRef.current.epoch + 1 }
  const load = useCallback(async () => {
    const token = gate.begin()
    if (!accountId) { setData(null); setForm(EMPTY_FORM); setState('empty'); return }
    setState('loading')
    setErrors({})
    setData(null)
    setForm(EMPTY_FORM)
    try {
      const response = await api.ecCommerce.connector(accountId)
      if (!gate.current(token)) return
      if (!response.success || !response.data?.health) throw new Error('invalid_connector_response')
      setData(response.data)
      setForm(toForm(response.data.connector))
      setReplacingSecret(false)
      setState(response.data.configured ? 'ready' : 'empty')
    } catch (error) {
      if (!gate.current(token)) return
      const fieldFailure = saveErrors.capture(error)
      { if (!fieldFailure)
      setState(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'error')
    }
  }
  }, [accountId, gate, saveErrors])

  useEffect(() => { void load() }, [load])

  const saveConflict = useSaveConflict<EcConnectorOverview>({
    fetchLatest: async () => {
      if (!accountId) return null
      const account = accountId
      const response = await api.ecCommerce.connector(account)
      return accountRef.current === account && response.success ? response.data : null
    },
    reload: async () => { await load(); saveConflict.clear() },
  })
  useEffect(() => { saveConflict.clear() }, [accountId, saveConflict.clear])

  const toggle = (field: 'eventTypes' | 'identityRules', value: string) => {
    setForm((current) => {
      const values = current[field] as string[]
      const next = values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
      return { ...current, [field]: next }
    })
  }

  const save = async (confirmation?: NonNullable<typeof emptyConfirm>) => {
    if (!canEdit || saving || !dirty || !accountId) return
    if (confirmation && (confirmation.epoch !== scopeRef.current.epoch || confirmation.accountId !== accountId || confirmation.form !== form)) {
      setNotice({ tone: 'error', text: '対象や内容が変わりました。閉じてから、もう一度選んでください。' })
      return false
    }
    const accountAtSave = confirmation?.accountId ?? accountId
    const formAtSave = confirmation?.form ?? form
    const epochAtSave = scopeRef.current.epoch
    setSaving(true)
    setNotice(null)
    try {
      const response = await api.ecCommerce.updateConnector(accountAtSave, formAtSave)
      if (scopeRef.current.epoch !== epochAtSave) return
      if (!response.success) throw new Error('save_failed')
      setForm((current) => ({ ...current, inboundSecret: '', expectedVersion: response.data.version }))
      notifySaved('つなぎ先の設定を保存しました。')
      void load()
      return true
    } catch (error) {
      if (scopeRef.current.epoch !== epochAtSave) return
      const fieldFailure = saveErrors.capture(error);

      if (error instanceof ApiError && error.status === 409) { saveConflict.mark(); setNotice({ tone: 'error', text: 'ほかの人が先に保存しました。閉じて最新の内容と比べてください。' }); return false }
      setNotice({ tone: 'error', text: '設定を保存できませんでした。通信の状態を確認して、もう一度お試しください。' })
      return false
    } finally {
      setSaving(false)
    }
  }

  const requestSave = () => {
    if (!canEdit || saving || !dirty) return
    if (!accountId || saving || !canEdit) return
    const domain = form.shopDomain.trim().toLowerCase()
    const next = {
      domain: /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(domain) ? undefined : 'ショップのドメインを入れてください（例：shop.nen.example）。https:// や / は含めません。',
      secret: (!connector?.secretConfigured || form.inboundSecret.trim().length > 0 || replacingSecret) && form.inboundSecret.trim().length < 32 ? '32文字以上の鍵を入れてください。' : undefined,
    }
    setErrors(next)
    setNotice(null)
    if (next.domain || next.secret) {
      const field = next.domain ? domainRef.current : secretRef.current
      field?.focus()
      field?.scrollIntoView?.({ block: 'center', behavior: scrollMotion() })
      return
    }
    const events = form.eventTypes.length === 0
    const rules = form.identityRules.length === 0
    if (events || rules) { setEmptyConfirm({ events, rules, accountId, form, epoch: scopeRef.current.epoch }); return }
    void save()
  }

  const connector = data?.connector
  /* 「取り込みを止める」は保存するまで効かない。未保存の差分がある間は知らせ、離れる操作も止める。 */
  const pendingStatusChange = Boolean(connector) && form.status !== connector?.status
  const dirty = state === 'ready' && (() => {
    const { expectedVersion: _ev, inboundSecret: _sec, ...current } = form
    const { expectedVersion: _ev2, inboundSecret: _sec2, ...baseline } = toForm(connector ?? null)
    return form.inboundSecret.length > 0 || JSON.stringify(current) !== JSON.stringify(baseline)
  })()
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: saving })
  if (state !== 'ready') {
    return (
      <SaveErrorScope errors={saveErrors}><ListState
        kind={state}
        title={state === 'empty' ? accountId ? 'つなぎ先はまだありません' : 'LINEアカウントを選択してください' : undefined}
        description={state === 'empty' ? accountId ? 'ネットショップの種類・アドレス・鍵を登録すると、注文を取り込めます。' : 'LINEアカウントを選ぶ欄で、設定するアカウントを選びます。' : undefined}
        action={state === 'empty' && accountId && canEdit ? <Button type="button" variant="primary" onClick={() => setState('ready')}>つなぎ先を設定</Button> : undefined}
        onRetry={state === 'error' ? () => void load() : undefined}
      /></SaveErrorScope>
    )
  }

  const paused = form.status === 'paused'
  const showSecretInput = canEdit && (!connector?.secretConfigured || replacingSecret)
  const impact = data?.impact
  const impactWords = (value: number | null | undefined) => (typeof value === 'number' ? `${value} 件` : '未取得')

  return (
    <SaveErrorScope errors={saveErrors}><div className={styles.board} data-design-node="iLJmw">
      {saveConflict.conflict ? <SaveConflictBand title="ほかの人が先につなぎ先の設定を保存しました" compareBusy={saveConflict.compareBusy} onCompare={() => void saveConflict.compare()} onReload={() => void saveConflict.reloadLatest()} /> : null}
      <SaveConflictCompareDialog open={saveConflict.compareOpen} busy={saveConflict.compareBusy} error={saveConflict.compareError} lines={saveConflict.latest ? [
        { text: `ショップのアドレス：あなた ${form.shopDomain} ／ 最新 ${saveConflict.latest.connector?.shopDomain ?? '未設定'}` },
        { text: `取り込みの状態：あなた ${form.status === 'paused' ? '停止' : '接続'} ／ 最新 ${saveConflict.latest.connector?.status === 'paused' ? '停止' : '接続'}` },
        { text: '鍵は比較に表示しません。入力した鍵は読み直すまで残ります。' },
      ] : null} onReload={() => void saveConflict.reloadLatest()} onCancel={saveConflict.closeCompare} />
      {!canEdit ? <NoteBar tone="info">{READONLY_REASON}いまの設定はこのまま見られます。</NoteBar> : null}
      {notice ? <Notice tone={notice.tone === "success" ? "success" : "danger"} role={notice.tone === 'success' ? 'status' : 'alert'}>
        {notice.text}
      </Notice> : null}

      <div className={styles.top}>
        <Card spacing="settings" aria-labelledby="ec-connector-info">
          <h2 id="ec-connector-info" className={styles.cardTitle}>つなぎ先の情報</h2>
          <Field size="compact" label="ネットショップの種類" htmlFor="ec-connector-provider">
            {canEdit ? (
              <SaveErrorField names={["provider","form.provider"]}><Select id="ec-connector-provider" aria-label="ネットショップの種類" value={form.provider} onChange={(value) => setForm({ ...form, provider: value as Form['provider'] })} options={[{ value: 'shopify', label: 'Shopify' }, { value: 'ec_cube', label: 'EC-CUBE' }]} size="full" /></SaveErrorField>
            ) : <TextField aria-label="ネットショップの種類" value={form.provider === 'ec_cube' ? 'EC-CUBE' : 'Shopify'} readOnly aria-readonly="true" />}
          </Field>
          <Field label="ショップのアドレス" htmlFor="ec-connector-domain" error={errors.domain}>
            <SaveErrorField names={["shopDomain","form.shopDomain","shop_domain","form.shop_domain"]}><TextField ref={domainRef} id="ec-connector-domain" value={form.shopDomain} onChange={(event) => setForm({ ...form, shopDomain: event.target.value })} placeholder="nen-store.myshopify.com" readOnly={!canEdit} /></SaveErrorField>
          </Field>
          <Field size="compact" label="つなぐための鍵" htmlFor="ec-connector-secret" error={errors.secret} note="鍵は保存後に読み戻せません。画面には最後の4文字だけを出します。">
            {showSecretInput ? (
              <SaveErrorField names={["inboundSecret","form.inboundSecret","inbound_secret","form.inbound_secret"]}><TextField ref={secretRef} id="ec-connector-secret" type="password" autoComplete="new-password" value={form.inboundSecret} onChange={(event) => setForm({ ...form, inboundSecret: event.target.value })} placeholder="32文字以上" /></SaveErrorField>
            ) : (
              <div className={styles.keyRow}>
                <span className={styles.keyMask} id="ec-connector-secret" title={connector?.secretUpdatedAt ? `${when(connector.secretUpdatedAt)} に更新` : undefined}>{connector?.secretConfigured ? `●●●●●●●●●●●●  ${connector.secretLastFour ?? '----'}` : emptyValue('unconfigured')}</span>
                {canEdit ? <Button type="button" onClick={() => setReplacingSecret(true)}>差し替える</Button> : null}
              </div>
            )}
          </Field>
        </Card>

        <Card spacing="settings" aria-labelledby="ec-connector-health">
          <h2 id="ec-connector-health" className={styles.cardTitle}>取り込みのようす</h2>
          <KpiBand presentation="band" density="compact">
            {([['今日', data?.health.today], ['この30日', data?.health.last30Days], ['失敗', data?.health.failed]] as const).map(([label, value]) => (
              <KpiCard key={label} icon={null} title={label} value={null} unit="" valueText={typeof value === 'number' ? `${polishFormatNumber(value)} 件` : '—'} detail="" valueTone={label === '失敗' && typeof value === 'number' && value > 0 ? 'warning' : 'default'} />
            ))}
          </KpiBand>
          <p className={styles.note}>{`最後に成功 ${when(data?.health.lastSucceededAt ?? null)}`}</p>
        </Card>
      </div>

      <Card spacing="settings" aria-labelledby="ec-connector-status">
        <h2 id="ec-connector-status" className={styles.cardTitle}>取り込みの状態</h2>
        <p className={styles.desc}>止めると、ネットショップからの出来事を受け取らなくなります。「設定を保存する」で効きます。</p>
        <div className={styles.statusRow}>
          <StatusBadge tone={connector?.status === 'paused' ? 'neutral' : 'success'} size="compact">{connector?.status === 'paused' ? '停止中' : '取り込み中'}</StatusBadge>
          <span className={styles.statusText}>{`最後に受け取った ${when(data?.health.lastReceivedAt ?? null)}`}</span>
          {connector && canEdit ? (
            <Button type="button" onClick={() => setForm({ ...form, status: paused ? 'connected' : 'paused' })}>{paused ? '取り込みを再開する' : '取り込みを止める'}</Button>
          ) : null}
        </div>
        <Notice tone={pendingStatusChange ? "warn" : "info"} role={pendingStatusChange ? 'status' : undefined} heading={<>{paused ? '再開したとき：' : '止めたとき：'}</>}>
          <span className={styles.bandText}>
            {pendingStatusChange
              ? (paused ? '「取り込みを止める」を押しましたが、まだ止まっていません。「設定を保存する」を押すと止まります。' : '「取り込みを再開する」を押しましたが、まだ再開していません。「設定を保存する」を押すと再開します。')
              : (paused ? '取り込みを再開します。保存すると再開します。保存済みの設定は残っています。' : '取り込みを止めます。保存すると止まります。保存せずに離れると確認が出ます。')}
          </span>
        </Notice>
      </Card>

      <Card spacing="settings" aria-labelledby="ec-connector-events">
        <h2 id="ec-connector-events" className={styles.cardTitle}>どこの出来事を取り込むか</h2>
        <div className={styles.checks}>
          {/* 閲覧のみは押せるチェックを置かず、いまの選び方を文字で見せる。 */}
          {CONNECTOR_EVENT_TYPES.map((value) => canEdit
            ? <SaveErrorField names={["value"]} key={value}><Checkbox key={value} checked={form.eventTypes.includes(value)} onCheckedChange={() => toggle('eventTypes', value)}>{EC_EVENT_LABELS[value]}</Checkbox></SaveErrorField>
            : <span key={value} className={styles.readValue}>{`${EC_EVENT_LABELS[value]}：${form.eventTypes.includes(value) ? '取り込む' : '取り込まない'}`}</span>)}
        </div>
        <p className={styles.note}>チェックを外すと、その出来事を起点にした配信や集計も止まります。</p>
      </Card>

      <Card spacing="settings" aria-labelledby="ec-connector-identity">
        <h2 id="ec-connector-identity" className={styles.cardTitle}>どうやって人を見分けるか</h2>
        <p className={styles.note}>上から照らし合わせます。名前だけで自動では結びつけません。</p>
        <div className={styles.rules}>
          {IDENTITY_RULES.map(([value, label, help], index) => (
            <span key={value} className={styles.rule} title={help}>
              {canEdit
                ? <SaveErrorField names={["value"]}><Checkbox checked={form.identityRules.includes(value)} onCheckedChange={() => toggle('identityRules', value)}>{`${index + 1}. ${label}`}</Checkbox></SaveErrorField>
                : <span className={styles.readValue}>{`${index + 1}. ${label}：${form.identityRules.includes(value) ? '使う' : '使わない'}`}</span>}
            </span>
          ))}
        </div>
      </Card>

      <div className={styles.foot}>
        {/* つながる先：止めると止まるもの（ECの出来事がきっかけ）の数は title で見せる。 */}
        <p className={styles.links} title={`「ECの出来事がきっかけ」とあるものは、このつなぎ先を止めると止まります。コンバージョンと分析はアカウント全体の記録数です。タグ ${impactWords(impact?.friendFields)}（ECの出来事がきっかけ）・分析 ${impactWords(impact?.analytics)}（アカウント全体）。止めたあとも、保存済みの設定と届いたデータは残ります。失敗した処理のやり直しは「取り込みの記録」タブで一件ずつ「もう一度やる」から行います。`}>
          つながる先：
          <Link href="/nen-campaigns" title={`ECの出来事がきっかけ ${impactWords(impact?.nenCampaigns)}`}>→ NEN配信</Link>
          <Link href="/mileage" title={`ECの出来事がきっかけ ${impactWords(impact?.mileageRules)}`}>→ マイル</Link>
          <Link href="/conversions" title={`アカウント全体 ${impactWords(impact?.conversions)}`}>→ コンバージョン</Link>
          <Link href="/ec-commerce/identity-candidates" title="会員のつき合わせ">→ 会員</Link>
        </p>

      </div>

      {canEdit && (dirty || saving) ? <PageFooter actions={<><Button disabled={saving} onClick={() => { setForm(toForm(connector ?? null)); setReplacingSecret(false); setErrors({}); setNotice(null); saveErrors.reset() }}>キャンセル</Button><Button type="button" variant="primary" disabled={saving} onClick={requestSave} busy={saving} busyLabel="保存しています…">設定を保存する</Button></>} /> : null}

      <ConfirmDialog
        open={emptyConfirm !== null && emptyConfirm.epoch === scopeRef.current.epoch}
        title={emptyConfirm?.events && emptyConfirm?.rules ? '取り込みと照合をすべて止めますか？' : emptyConfirm?.events ? 'すべての出来事の取り込みを止めますか？' : '自動の照合をすべて止めますか？'}
        description={[
          emptyConfirm?.events ? '取り込む出来事が1つも選ばれていません。保存すると、すべての出来事の取り込みが止まります。' : null,
          emptyConfirm?.rules ? '人を照らし合わせる決めごとが1つも選ばれていません。保存すると、自動の照合がすべて止まります。' : null,
        ].filter(Boolean).join('')}
        confirmLabel="止めて保存する"
        confirmIcon={false}
        destructive
        busy={saving}
        error={notice?.tone === 'error' ? notice.text : undefined} confirmDisabled={Boolean(saveConflict.conflict)} confirmDisabledReason="閉じて最新の内容と比べてください。" onSuccess={() => setEmptyConfirm(null)} onConfirm={() => emptyConfirm ? save(emptyConfirm) : undefined}
        onCancel={() => { if (!saving) setEmptyConfirm(null) }}
      ><OperationTargetSummary accounts={[{ id: emptyConfirm?.accountId ?? '' }]} /></ConfirmDialog>
      <UnsavedLeaveDialog
        open={leaveTarget !== null}
        description={pendingStatusChange
          ? (paused ? '「取り込みを止める」はまだ保存されていません。このまま移ると、取り込みは止まりません。移りますか？' : '「取り込みを再開する」はまだ保存されていません。このまま移ると、取り込みは再開しません。移りますか？')
          : 'このまま移ると、入力した内容は保存されません。移りますか？'}
        cancelLabel="設定に戻る"
        onConfirm={confirmLeave}
        onCancel={cancelLeave}
      />
    </div></SaveErrorScope>
  )
}
