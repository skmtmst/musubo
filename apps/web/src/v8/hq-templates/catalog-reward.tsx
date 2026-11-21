'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import Checkbox from '@/components/shared/checkbox'
import { StatusDot } from '@/components/shared/status-pill'
import Dialog from '@/components/shared/dialog'
import { Field } from '@/components/shared/form-controls'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import { Tabs } from '@/components/shared/tabs'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import { ApiError } from '@/lib/api'
import { hqCatalogTemplatesApi } from '@/lib/api/helpers/hq-catalog-templates'
import { hqTemplatesApi, type DistributionMode, type DistributionResult, type HqAccount, type Preflight } from '@/lib/hq-templates-api'
import { useStaffRole, useTenantWideAccess } from '@/lib/staff-role'
import { choiceKey, resolvedItems } from './definition'
import { KIND_TABS, REWARD_TAB, STARTER_SET_TAB } from './store-list-options'

type Reward = { id: string; name: string }
const modes: Record<DistributionMode, string> = { create: '新しく作る', overwrite: 'この内容を反映する', alias: '別の景品として作る' }

/** 保存済みの景品を選んで配る。確認した版と対象を変えずに配布する。 */
export default function CatalogRewards() {
  const role = useStaffRole()
  const allowed = useTenantWideAccess()
  const [rewards, setRewards] = useState<Reward[] | null>(null)
  const [accounts, setAccounts] = useState<HqAccount[]>([])
  const [error, setError] = useState('')
  const [target, setTarget] = useState<Reward | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [choices, setChoices] = useState<Record<string, DistributionMode>>({})
  const [busy, setBusy] = useState(false)
  const [expiredDialog, setExpiredDialog] = useState(false)
  const [result, setResult] = useState<DistributionResult | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const sending = useRef(false)
  const load = useCallback(async () => {
    setError('')
    try {
      const [list, stores] = await Promise.all([hqCatalogTemplatesApi.list('mileage_reward'), hqTemplatesApi.accounts()])
      setRewards(list.data); setAccounts(stores)
    } catch { setError('景品のひな形を読み込めませんでした。もう一度お試しください。') }
  }, [])
  useEffect(() => { void load() }, [load])
  const check = async () => {
    if (!target || !selected.length || !allowed || busy) return
    setBusy(true); setError(''); setPreflight(null); setResult(null); setPending(null)
    try {
      const response = await hqCatalogTemplatesApi.preflight(target.id, selected)
      const checked = response.data
      if (checked.stores.length !== selected.length || new Set(checked.stores.map(store => store.accountId)).size !== selected.length || checked.stores.some(store => !selected.includes(store.accountId))) throw new Error('targets')
      const preset: Record<string, DistributionMode> = {}
      for (const store of checked.stores) for (const item of store.items) if (item.operation === 'reuse') preset[choiceKey(store.accountId, item.sourceId)] = 'overwrite'
      setChoices(preset); setPreflight(checked)
    } catch { setError('確かめに失敗しました。もう一度確かめてください。') }
    finally { setBusy(false) }
  }
  const run = async () => {
    if (!allowed || !target || !preflight || busy || sending.current || pending) return
    const resolutions = resolvedItems(preflight, choices)
    if (!resolutions) return
    if (!Number.isFinite(Date.parse(preflight.expiresAt)) || Date.parse(preflight.expiresAt) <= Date.now()) { setExpiredDialog(true); return }
    sending.current = true; setBusy(true); setError(''); setPending(preflight.preflightId)
    try {
      const response = await hqCatalogTemplatesApi.distribute(target.id, preflight.preflightId, resolutions)
      setResult(response.data)
      if (response.data.stores.length > 0 && response.data.stores.every(store => store.status === 'version_conflict' && store.reason?.includes('確かめの期限が切れました'))) setExpiredDialog(true)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 408) {
        setPending(null)
        if (cause.code === 'PREFLIGHT_EXPIRED') setExpiredDialog(true)
        else { setPreflight(null); setError('配布を受け付けられませんでした。配る先と内容をもう一度確かめてください。') }
      } else {
        try { setResult(await hqTemplatesApi.result(target.id, preflight.preflightId)) }
        catch { setError('配布結果をまだ確認できません。再配布せず、結果を確認してください。') }
      }
    } finally { sending.current = false; setBusy(false) }
  }
  const refresh = async () => {
    if (!target || !pending || busy) return
    setBusy(true)
    try { setResult(await hqTemplatesApi.result(target.id, pending)); setError('') }
    catch { setError('配布結果をまだ確認できません。再配布せず、結果を確認してください。') }
    finally { setBusy(false) }
  }
  const close = () => { if (!busy) { setTarget(null); setPreflight(null); setResult(null); setSelected([]); setPending(null); setError('') } }
  return <PageFrame kind="list"><PageHeading title="マイルの景品のひな形" help="保存した景品を、選んだアカウントへ配ります。" />
    <Tabs size="compact" label="ひな形の種類" items={[...KIND_TABS.map(tab => ({ label: tab.label, href: `/hq/templates?kind=${tab.kind}` })), { ...REWARD_TAB, current: true }, STARTER_SET_TAB]} />
    <Card variant="form" gap="normal"><CardHeader size="stacked" title="マイルの景品" />
      {error && !target ? <Notice tone="warn" message={error} action={<Button onClick={() => void load()}>もう一度読み込む</Button>} /> : null}
      {rewards === null ? <p role="status">読み込んでいます…</p> : rewards.length === 0 ? <p>保存した景品のひな形はありません。</p> : rewards.map(reward => <div key={reward.id}><span>{reward.name}</span>{' '}<Button disabled={!allowed || role === null} lockedReason={allowed ? undefined : '統括の管理者のみ配れます'} onClick={() => { setTarget(reward); setError('') }}>配る</Button></div>)}
    </Card>
    <Dialog open={Boolean(target)} title={expiredDialog ? '確かめの期限が切れました' : preflight ? '景品を配る前に確かめる' : '景品を配る先を選ぶ'} titleContent={expiredDialog ? <><StatusDot tone="caution" />{' '}確かめの期限が切れました</> : undefined} headerIcon={expiredDialog ? false : undefined} confirmation={expiredDialog} description={expiredDialog ? '確認から30分が過ぎました。配る前にもう一度、配布先と内容を確認してください。' : target ? `「${target.name}」を配ります。引換コードと在庫は配らず、交換は停止中で入ります。確かめ直すと配り方の選択は選び直しになります。` : ''} busy={busy} error={expiredDialog ? undefined : error} onCancel={expiredDialog ? () => setExpiredDialog(false) : close}
      confirmLabel={expiredDialog ? 'もう一度確かめる' : preflight ? 'この内容で配る' : '配る先を確かめる'} confirmLockedReason={allowed ? undefined : '統括の管理者のみ配れます'} confirmDisabled={!allowed || (expiredDialog ? busy : preflight ? !resolvedItems(preflight, choices) || Boolean(pending) : !selected.length)} onConfirm={() => { if (expiredDialog) { setExpiredDialog(false); void check() } else void (preflight ? run() : check()) }}>
      {expiredDialog ? null : <>{!preflight ? accounts.map(account => <Checkbox key={account.id} checked={selected.includes(account.id)} onCheckedChange={value => setSelected(current => value ? [...current, account.id] : current.filter(id => id !== account.id))}>{account.name}</Checkbox>) : null}
      {preflight && !result ? preflight.stores.map(store => <section key={store.accountId}><h3>{store.accountName ?? accounts.find(account => account.id === store.accountId)?.name}</h3>
        {store.warnings?.map(warning => <p key={warning}>{warning === 'reward_codes_required' ? '引換コードは各店で設定してください。' : 'このアカウントには確認が必要な項目があります。'}</p>)}
        {store.items.map(item => item.operation === 'reuse' ? <p key={item.sourceId}>{item.name}：既存の設定を使います</p> : item.duplicate ? <Field key={item.sourceId} label={`${item.name}の配り方`}><Select aria-label={`${store.accountName ?? store.accountId} ${item.name}の配り方`} value={choices[choiceKey(store.accountId,item.sourceId)] ?? ''} onChange={value => setChoices(current => ({ ...current, [choiceKey(store.accountId,item.sourceId)]: value as DistributionMode }))} options={[{ value: '', label: '選択してください' }, ...item.allowedModes.map(mode => ({ value: mode, label: modes[mode] }))]} /></Field> : <p key={item.sourceId}>{item.name}：新しく作ります</p>)}
      </section>) : null}
      {result ? <><p>配布結果：{result.status === 'completed' ? '完了' : '確認が必要です'}</p>{result.stores.map(store => <p key={store.accountId}>{store.accountName ?? store.accountId}：{store.reason ?? store.status}</p>)}</> : null}
      {pending && (!result || result.stores.some(store => store.status === 'pending' || store.status === 'staged')) ? <Button onClick={() => void refresh()} disabled={busy}>結果を確認</Button> : null}</>}
    </Dialog>
  </PageFrame>
}
