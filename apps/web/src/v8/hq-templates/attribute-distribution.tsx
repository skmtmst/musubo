'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useEffect, useRef, useState } from 'react'
import type { HqFriendAttributeDetail, HqTemplateReceivedVersion } from '@line-crm/shared'
import { hqFriendAttributesApi as api, type HqAttributePreflight, type HqAttributeDistributionResult, type HqAttributeResolution } from '@/lib/hq-friend-attributes-api'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import { ListPageBody } from '@/components/templates/list-page'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { FolderDotName } from '@/components/shared/folder-dot'
import SavedDistributionDialog from './saved-distribution-dialog'
import { accountsInFolder, distributionFolderRows, DistributionFolderPanel, useDistributionFolders } from './distribution-accounts'
import styles from './console.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { TextField as SharedTextField } from '@/components/shared/text-field'

const choiceKey = (account: string, source: string) => JSON.stringify([account, source])
const labels = { create: '新しく作る', overwrite: '上書き', alias: '別名で作る', skip: '配らない' }
const runKey = (id: string) => `lh_hq_attribute_distribution:${id}`

/** タグと同じ選択窓・アカウントのフォルダを使い、確認→配布→結果をつなぐ。 */
export default function AttributeDistribution({ detail, saved = false, canEdit = true, onClose }: { detail: HqFriendAttributeDetail; saved?: boolean; canEdit?: boolean; onClose: () => void }) {
  const [stage, setStage] = useState<'saved' | 'accounts' | 'confirm' | 'result'>(saved ? 'saved' : 'accounts')
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }> | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [search, setSearch] = useListUrlValue('q', '')
  const [filter, setFilter] = useListUrlValue('filter', 'all')
  const folders = useDistributionFolders(true)
  const [received, setReceived] = useState<HqTemplateReceivedVersion[] | null>(null)
  const [receivedFailed, setReceivedFailed] = useState(false)
  const [preflight, setPreflight] = useState<HqAttributePreflight | null>(null)
  const [choices, setChoices] = useState<Record<string, HqAttributeResolution['mode']>>({})
  const [result, setResult] = useState<HqAttributeDistributionResult | null>(null)
  const [pendingRun, setPendingRun] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const lock = useRef(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    void api.accounts().then((rows) => { if (alive.current) setAccounts(rows) }, () => { if (alive.current) setError('アカウントを読み込めませんでした。開き直してください。') })
    void api.receivedVersions(detail.template.id).then((rows) => { if (alive.current) setReceived(rows) }, () => { if (alive.current) setReceivedFailed(true) })
    const run = window.sessionStorage.getItem(runKey(detail.template.id))
    if (run) {
      setPendingRun(run); setStage('result'); setBusy(true); lock.current = true
      void api.result(detail.template.id, run).then((next) => {
        if (next.runId !== run) throw new Error('配布番号が一致しません。結果を再確認してください。')
        if (alive.current) setResult(next)
      }).catch((cause) => { if (alive.current) setError((describeApiFailure(cause, '読み込み', { scope: 'hq' }))) })
        .finally(() => { lock.current = false; if (alive.current) setBusy(false) })
    }
    return () => { alive.current = false }
  }, [detail.template.id])
  useEffect(() => { if (stage !== 'confirm') return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [stage])
  const perform = async (action: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await action() } catch (cause) { if (alive.current) setError((describeApiFailure(cause, '読み込み', { scope: 'hq' }))) }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const refresh = (run = pendingRun) => perform(async () => {
    if (!run) return
    const next = await api.result(detail.template.id, run)
    if (next.runId !== run) throw new Error('配布番号が一致しません。結果を再確認してください。')
    if (alive.current) setResult(next)
  })
  const check = (ids: string[]) => perform(async () => {
    if (!canEdit || !ids.length) return
    const checked = await api.preflight(detail.template.id, ids)
    if (!alive.current) return
    setSelected(ids); setPreflight(checked); setChoices({}); setResult(null); setPendingRun(null); setStage('confirm'); setNow(Date.now())
  })
  const expiry = preflight ? Date.parse(preflight.expiresAt) : NaN
  const expired = !Number.isFinite(expiry) || expiry <= now
  const resolutions: HqAttributeResolution[] = preflight?.stores.flatMap((store) => store.items.map((item) => ({ accountId: store.accountId, sourceId: item.sourceId, mode: item.duplicate ? choices[choiceKey(store.accountId, item.sourceId)] : 'create' }))) ?? []
  const valid = Boolean(preflight?.stores.length) && preflight!.stores.every((store) => store.items.length > 0 && store.items.every((item) => item.allowedModes.includes(item.duplicate ? choices[choiceKey(store.accountId, item.sourceId)] : 'create')))
  const run = () => perform(async () => {
    if (!canEdit || !preflight || !valid || expired || pendingRun) return
    const id = preflight.preflightId
    // 結果不明では同じ配布をPOSTし直さない。GETだけで復元する。
    window.sessionStorage.setItem(runKey(detail.template.id), id)
    setPendingRun(id); setStage('result')
    try {
      const next = await api.distribute(detail.template.id, id, resolutions)
      if (next.runId !== id) throw new Error('配布番号が一致しません。')
      if (alive.current) setResult(next)
    } catch (cause) {
      try { const next = await api.result(detail.template.id, id); if (next.runId !== id) throw cause; if (alive.current) setResult(next) }
      catch { throw new Error('配った結果を確認できません。結果を再確認してください。確認できるまで再配布しません。') }
    }
  })
  const close = () => { if (busy) return; if (!pendingRun || result && result.status !== 'running') window.sessionStorage.removeItem(runKey(detail.template.id)); onClose() }
  if (!canEdit) return <PageFrame kind="wizard"><ReadOnlyNotice >閲覧のみで見ています。変える操作は管理者に頼んでください。</ReadOnlyNotice><Button onClick={close}>一覧へ</Button></PageFrame>
  if (stage === 'saved') return <SavedDistributionDialog accounts={accounts ?? []} folders={folders} selected={selected} onChange={setSelected} filter={filter} onFilter={setFilter} search={search} onSearch={setSearch} received={received} receivedFailed={receivedFailed} busy={busy} error={error} onLater={close} onDistribute={() => void check(selected)} />
  const visible = accountsInFolder(accounts ?? [], filter, folders.membership).filter((account) => account.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const folderRows = distributionFolderRows({ accounts: accounts ?? [], ...folders, selected, onChange: setSelected, disabled: busy || stage !== 'accounts' })
  const failures = result?.stores.filter((store) => ['failed', 'version_conflict', 'unsupported'].includes(store.status)) ?? []
  const done = result && result.status !== 'running'
  return <PageFrame kind="wizard">
    <PageHeading title={`アカウントへ配る：${detail.template.name}`} />
    {error ? <Notice tone="danger" message={error} /> : null}
    <ListPageBody folders={<DistributionFolderPanel rows={folderRows} activeId={filter} onSelect={setFilter} failed={folders.failed} />}
      collapsedFolders={<SaveErrorField names={["filter"]}><Select aria-label="アカウントのフォルダ" value={filter} onChange={setFilter} options={folderRows.map((row) => ({ value: row.id, label: row.label }))} /></SaveErrorField>}
      toolbar={<><SaveErrorField names={["search"]}><SharedTextField aria-label="アカウント名で探す" className={styles.input} value={search} onChange={(event) => setSearch(event.target.value)} /></SaveErrorField><span className="text-body">{`選んだ ${selected.length} アカウント`}</span></>}>
      <DataTable><thead><TableHeadRow><Th>選択</Th><Th>アカウント</Th><Th>配布方法・結果</Th></TableHeadRow></thead><tbody>
        {visible.map((account, saveFieldIndex) => <Tr selected={selected.includes(account.id)} key={account.id} data-row-id={account.id}>
          <Td><SaveErrorField names={[`visible.${saveFieldIndex}.id`,"id","account.id","selected"]}><Checkbox aria-label={account.name} disabled={busy || stage !== 'accounts'} checked={selected.includes(account.id)} onCheckedChange={(on) => setSelected((current) => on ? [...new Set([...current, account.id])] : current.filter((id) => id !== account.id))} /></SaveErrorField></Td>
          <Td><FolderDotName folder={folders.membership?.get(account.id)?.folder}>{account.name}</FolderDotName></Td>
          <Td>{stage === 'confirm' ? preflight?.stores.find((store) => store.accountId === account.id)?.items.map((item) => <div key={item.sourceId}>
            <span>{item.name}</span>{item.duplicate ? <SaveErrorField names={["choices"]}><Select aria-label={`${account.name} ${item.name}の配布方法`} value={choices[choiceKey(account.id, item.sourceId)] ?? ''} disabled={busy} onChange={(mode) => setChoices((current) => ({ ...current, [choiceKey(account.id, item.sourceId)]: mode as HqAttributeResolution['mode'] }))} options={[{ value: '', label: '選んでください' }, ...item.allowedModes.map((mode) => ({ value: mode, label: labels[mode] }))]} /></SaveErrorField> : <span>新しく作る</span>}
            {item.reason ? <p>{item.reason}</p> : null}
          </div>) : stage === 'result' ? (() => { const store = result?.stores.find((row) => row.accountId === account.id); return store ? <><StatusBadge tone={store.status === 'succeeded' ? 'success' : failures.includes(store) ? 'danger' : 'neutral'}>{store.status === 'succeeded' ? '成功' : failures.includes(store) ? '失敗' : '配っています'}</StatusBadge>{store.reason ? <p>{store.reason}</p> : null}</> : selected.includes(account.id) ? '確認中…' : emptyValue('unknown') })() : '確認のあとで選ぶ'}</Td>
        </Tr>)}
      </tbody></DataTable>
    </ListPageBody>
    {stage === 'confirm' && expired ? <Notice tone="warn" message="確認の有効期限が切れました。現在版を再確認してください。" /> : null}
    {stage === 'result' ? <Notice tone={failures.length ? 'warn' : 'info'} message={result ? `配布の進み具合：${result.stores.filter((store) => store.status === 'succeeded' || failures.includes(store)).length} / ${result.stores.length}。成功 ${result.stores.filter((store) => store.status === 'succeeded').length}・失敗 ${failures.length}` : '配った結果を確認しています。確認できるまで再配布しません。'} /> : null}
    <div className={styles.footer}>
      <Button disabled={busy} onClick={close}>{done ? '一覧へ' : 'キャンセル'}</Button>
      {stage === 'accounts' ? <Button variant="primary" disabled={busy || !accounts || !selected.length} onClick={() => void check(selected)} busy={Boolean(busy)} busyLabel="処理中…">選んだアカウントを確かめる</Button> : null}
      {stage === 'confirm' ? <><Button disabled={busy} onClick={() => setStage('accounts')}>戻る</Button>{expired ? <Button disabled={busy} onClick={() => void check(selected)} busy={Boolean(busy)} busyLabel="処理中…">現在版を再確認</Button> : null}<Button variant="primary" disabled={busy || expired || !valid || !!pendingRun} onClick={() => void run()} busy={Boolean(busy)} busyLabel="処理中…">{`この内容で${selected.length}アカウントへ配る`}</Button></> : null}
      {stage === 'result' ? <><Button disabled={busy} onClick={() => void refresh()} busy={Boolean(busy)} busyLabel="処理中…">結果を再確認</Button>{done && failures.length ? <Button disabled={busy} onClick={() => void check(failures.map((store) => store.accountId))} busy={Boolean(busy)} busyLabel="処理中…">失敗したアカウントだけ再確認</Button> : null}</> : null}
    </div>
  </PageFrame>
}
