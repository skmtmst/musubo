'use client'

import { EntityPickerField } from '@/components/shared/entity-picker'

/*
 * ★V8 外部連携 › API 接続の区画「AI とつなぐ（MCP）」（板 Xb0yc の後ろ・作る窓 Xb0yc・作った後の窓 Ge1vp）。
 * 要件 G9 §2-1・§2-2・§2-5・§2-6・§4（MCP-01・02・11・13・15・16・18・19）。
 * - 接続の表：接続・できること・使えるアカウント・期限・最後に使った・状態・「…」（記録を見る・鍵を作り直す・止める）
 * - ［接続を作る］はオーナーだけ（本人確認つき）。管理者には「オーナーだけが作れます」。閲覧のみは見るだけ。スタッフには区画を出さない
 * - 鍵は作った時に 1 回だけ。閉じる時に「鍵はもう見られません」の確かめ
 */
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { useCallback, useEffect, useState } from 'react'
import { Bot, Copy, Plus } from 'lucide-react'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import CopyTextButton from '@/components/shared/copy-text-button'
import Dialog from '@/components/shared/dialog'
import EmptyList from '@/components/shared/empty-list'
import { Field } from '@/components/shared/form-controls'
import HelpTip from '@/components/shared/help-tip'
import ListState from '@/components/shared/list-state'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import { RowMenu } from '@/components/shared/row-actions'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { ActionCell, DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { TextField } from '@/components/shared/text-field'
import TruncatedText from '@/components/shared/truncated-text'
import { describeApiFailure, loadFailureCopy } from '@/components/shared/api-error-message'
import { notifyToast } from '@/components/shared/toast'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import { useAccount } from '@/contexts/account-context'
import { formatDate } from '@/lib/format'
import { MCP_STEP_UP, mcpApi, type McpConnection, type McpIssued, type McpLevel } from './api'
import { EXPIRY_OPTIONS, LEVEL_LABEL, LEVEL_NOTE, connectionState } from './words'
import { useMcpPermissions, currentMcpPermissions, captureMcpCreation } from './write-access'
export { useMcpPermissions } from './write-access'
import styles from './section.module.css'

type Load = { kind: 'loading' } | { kind: 'ready'; items: McpConnection[] } | { kind: 'error'; error: unknown }

const LEVELS: McpLevel[] = ['read', 'draft', 'send_request']
const day = (value: string | null) => formatDate(value, { style: 'list-day', fallback: '—' })
const used = (value: string | null) => formatDate(value, { style: 'list', fallback: value ? '—' : 'まだ使っていません' })

export default function McpConnectionsSection() {
  const { selectedAccountId, selectedAccount, accounts } = useAccount()
  const permissions = useMcpPermissions()
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [menuId, setMenuId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [issued, setIssued] = useState<McpIssued | null>(null)
  const [stopTarget, setStopTarget] = useState<McpConnection | null>(null)
  const [rotateTarget, setRotateTarget] = useState<McpConnection | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)

  const fetchList = useCallback(async () => {
    if (!selectedAccountId) { setLoad({ kind: 'ready', items: [] }); return }
    setLoad({ kind: 'loading' })
    try {
      const res = await mcpApi.list(selectedAccountId)
      setLoad({ kind: 'ready', items: res.data })
    } catch (error) {
      setLoad({ kind: 'error', error })
    }
  }, [selectedAccountId])
  useEffect(() => { if (permissions.see) void fetchList() }, [fetchList, permissions.see])

  if (!permissions.see) return null

  const stop = async () => {
    if (!stopTarget || !currentMcpPermissions().stop) return
    setBusy(true)
    setDialogError('')
    try {
      await mcpApi.stop(stopTarget.id, stopTarget.version)
      notifyToast(`「${stopTarget.name}」を止めました。次の呼び出しから使えません`)
      setStopTarget(null)
      void fetchList()
    } catch (caught) {
      setDialogError(describeApiFailure(caught, '止める操作'))
    } finally {
      setBusy(false)
    }
  }

  const rotate = async (stepUpToken?: string) => {
    if (!rotateTarget || !currentMcpPermissions().create) return
    const canContinue = captureMcpCreation()
    setBusy(true)
    setDialogError('')
    try {
      const res = await mcpApi.rotate(rotateTarget.id, rotateTarget.version, stepUpToken)
      setRotateTarget(null)
      setIssued(res.data)
      void fetchList()
    } catch (caught) {
      if (!stepUpToken && isStepUpRequired(caught)) setStepUp({ purpose: MCP_STEP_UP, action: 'AI との接続の鍵を作り直す', retry: async (token) => { if (canContinue()) return rotate(token); setDialogError('権限が変わったため中止しました。') } })
      else setDialogError(describeApiFailure(caught, '鍵の作り直し'))
    } finally {
      setBusy(false)
    }
  }

  const failure = load.kind === 'error' ? loadFailureCopy(load.error, 'AI との接続') : null
  const create = <Button disabled={!permissions.create} lockedReason={permissions.reason} onClick={() => { if (currentMcpPermissions().create) setCreateOpen(true) }}><Plus size={16} aria-hidden="true" />接続を作る</Button>

  return (
    <Card padding="default" className={styles.card} data-design-node="Xb0yc">
      <CardHeader
        title="AI とつなぐ（MCP）"
        help={<HelpTip label="AI とつなぐの説明">MCP（AI のアプリとつなぐ決まり）で、Claude などの AI からこのアカウントの数を読んだり、下書きを作ったりできます。何をしたかは全部「AI の操作の記録」に残ります。</HelpTip>}
        action={create}
      />
      <p className={styles.purpose}>Claude などの AI から、このアカウントの情報を読む・下書きを作ることができます。送るのは人の承認が要ります。</p>
      {load.kind === 'loading' ? <ListState kind="loading" /> : null}
      {failure ? <ListState kind="error" title={failure.title} description={failure.description} onRetry={failure.retryable ? () => void fetchList() : undefined} /> : null}
      {load.kind === 'ready' && load.items.length === 0 ? (
        <EmptyList
          icon={<Bot aria-hidden="true" />}
          title="まだ AI との接続がありません"
          description="AI とつなぐと、Claude などから数を読んだり下書きを作ったりできます。"
          create={{ label: '接続を作る', onClick: () => { if (currentMcpPermissions().create) setCreateOpen(true) } }}
          canCreate={permissions.create}
          lockedReason={permissions.reason ?? null}
        />
      ) : null}
      {load.kind === 'ready' && load.items.length > 0 ? (
        <DataTable aria-label="AI との接続" columnSizing="content">
          <thead>
            <TableHeadRow>
              <Th grow>接続</Th>
              <Th>できること</Th>
              <Th>使えるアカウント</Th>
              <Th>期限</Th>
              <Th>最後に使った</Th>
              <Th>状態</Th>
              <Th><span className="sr-only">操作</span></Th>
            </TableHeadRow>
          </thead>
          <tbody>
            {load.items.map((connection) => {
              const state = connectionState(connection)
              const accountsText = connection.accounts.map((account) => account.name).join('・') || '—'
              const live = connection.status === 'active'
              return (
                <Tr key={connection.id} data-row-id={connection.id}>
                  <Td grow title={connection.name}><TruncatedText value={connection.name} /></Td>
                  <Td>{LEVEL_LABEL[connection.level]}</Td>
                  <Td title={accountsText}><TruncatedText value={accountsText} /></Td>
                  <Td>{day(connection.expiresAt)}</Td>
                  <Td>{used(connection.lastUsedAt)}</Td>
                  <Td title={connection.previousKeyExpiresAt ? `古い鍵は ${used(connection.previousKeyExpiresAt)} まで` : undefined}>
                    <span className={styles.state}>
                      <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                      {connection.previousKeyExpiresAt ? (
                        <span className={styles.stateSub}>古い鍵は {used(connection.previousKeyExpiresAt)} まで</span>
                      ) : null}
                    </span>
                  </Td>
                  <ActionCell>
                    <RowMenu
                      appearance="plain"
                      label={`「${connection.name}」の操作`}
                      open={menuId === connection.id}
                      onOpenChange={(next) => setMenuId(next ? connection.id : null)}
                      items={[
                        { id: 'log', label: '記録を見る', href: `/webhooks/ai-log?connection=${encodeURIComponent(connection.id)}`, onSelect: () => setMenuId(null) },
                        ...(live ? [{ id: 'rotate', label: '鍵を作り直す', disabled: !permissions.create && !permissions.reason, lockedReason: permissions.reason, onSelect: () => { setMenuId(null); setDialogError(''); setRotateTarget(connection) } }] : []),
                        ...(live ? [{ id: 'stop', label: '止める', disabled: !permissions.stop && !permissions.reason, lockedReason: permissions.stop ? undefined : permissions.reason, tone: 'danger' as const, onSelect: () => { setMenuId(null); setDialogError(''); setStopTarget(connection) } }] : []),
                      ]}
                    />
                  </ActionCell>
                </Tr>
              )
            })}
          </tbody>
        </DataTable>
      ) : null}

      <McpCreateDialog
        open={createOpen}
        defaultAccountId={selectedAccountId}
        accountOptions={(accounts?.length ? accounts : selectedAccount ? [selectedAccount] : []).map((account) => ({ value: account.id, label: `アカウント：${account.name}` }))}
        onClose={() => setCreateOpen(false)}
        onCreated={(next) => { setCreateOpen(false); setIssued(next); void fetchList() }}
      />
      <McpIssuedDialog issued={issued} onClose={() => setIssued(null)} />
      <ConfirmDialog
        open={stopTarget !== null}
        title={`「${stopTarget?.name ?? ''}」を止めますか？`}
        description="すぐ使えなくなり、次の呼び出しから断ります。止めた人は記録に残ります。もう一度使うときは、接続を作り直します。"
        confirmLabel="止める"
        confirmIcon={false}
        confirmDisabled={!permissions.stop}
        confirmLockedReason={permissions.stop ? undefined : permissions.reason}
        destructive
        busy={busy}
        error={dialogError || undefined}
        onConfirm={() => void stop()}
        onCancel={() => { if (!busy) setStopTarget(null) }}
      ><OperationTargetSummary accounts={stopTarget?.accounts?.length ? stopTarget.accounts : [{ id: '' }]} compactAccounts /></ConfirmDialog>
      <ConfirmDialog
        open={rotateTarget !== null}
        title={`「${rotateTarget?.name ?? ''}」の鍵を作り直しますか？`}
        description="新しい鍵を 1 回だけ表示します。古い鍵は 24 時間だけ使えます。そのあいだに AI のアプリの鍵を書き換えてください。"
        confirmLabel="作り直す"
        confirmDisabled={!permissions.create}
        confirmLockedReason={permissions.reason}
        busy={busy}
        error={dialogError || undefined}
        onConfirm={() => void rotate()}
        onCancel={() => { if (!busy) setRotateTarget(null) }}
      ><OperationTargetSummary accounts={rotateTarget?.accounts?.length ? rotateTarget.accounts : [{ id: '' }]} compactAccounts /></ConfirmDialog>
      {stepUp ? <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} /> : null}
    </Card>
  )
}

/** 板 Xb0yc「AI との接続を作る」。閉じれば何も作らない（MCP-19）。［作る］のあと本人確認。 */
function McpCreateDialog({ open, defaultAccountId, accountOptions, onClose, onCreated }: {
  open: boolean
  defaultAccountId: string | null
  accountOptions: Array<{ value: string; label: string }>
  onClose: () => void
  onCreated: (issued: McpIssued) => void
}) {
  const permissions = useMcpPermissions()
  const [name, setName] = useState('')
  const [level, setLevel] = useState<McpLevel>('read')
  const [accountId, setAccountId] = useState(defaultAccountId ?? '')
  const [days, setDays] = useState('90')
  const [nameError, setNameError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  const saveErrors = useSaveFormErrors()
  useEffect(() => {
    if (!open) return
    setName(''); setLevel('read'); setAccountId(defaultAccountId ?? ''); setDays('90'); setNameError(''); setError('')
  }, [open, defaultAccountId])

  const submit = async (stepUpToken?: string) => {
    if (!currentMcpPermissions().create) { setError(permissions.reason ?? '担当者の確認が終わるまでお待ちください。'); return }
    const canContinue = captureMcpCreation()
    const trimmed = name.trim()
    if (!trimmed) { setNameError('名前を入れてください（例：Claude（Kenta））'); return }
    setNameError('')
    setBusy(true)
    setError('')
    try {
      const res = await mcpApi.create({ name: trimmed, level, accountIds: accountId ? [accountId] : [], expiresInDays: Number(days) }, stepUpToken)
      notifyToast('接続を作りました')
      onCreated(res.data)
    } catch (caught) {
      if (!stepUpToken && isStepUpRequired(caught)) setStepUp({ purpose: MCP_STEP_UP, action: 'AI との接続を作る', retry: async (token) => { if (canContinue()) return submit(token); setError('権限が変わったため中止しました。') } })
      else if (!saveErrors.capture(caught)) setError(describeApiFailure(caught, '接続の作成'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}>
      <Dialog
        open={open}
        title="AI との接続を作る"
        description="［作る］のあと本人確認（確認コード）をします。URL と鍵は 1 回だけ表示します。"
        designNode="Xb0yc"
        designWidth={620}
        dirty={name.trim() !== '' || level !== 'read'}
        busy={busy}
        error={error || undefined}
        confirmLabel="作る"
        confirmDisabled={!permissions.create}
        confirmLockedReason={permissions.reason}
        footerAlign="center"
        onConfirm={() => void submit()}
        onCancel={() => { if (!busy) onClose() }}
      >
        <div className={styles.form}>
          <Field label="名前" htmlFor="mcp-name" required error={nameError || undefined}>
            <TextField id="mcp-name" value={name} maxLength={60} invalid={Boolean(nameError)} placeholder="例：Claude（Kenta）" onChange={(event) => setName(event.target.value)} />
          </Field>
          <RadioCardGroup legend="できること" legendVisible>
            {LEVELS.map((value) => (
              <RadioCard key={value} name="mcp-level" value={value} checked={level === value} onChange={(next: string) => setLevel(next as McpLevel)} title={LEVEL_LABEL[value]} note={LEVEL_NOTE[value]} variant="form" />
            ))}
          </RadioCardGroup>
          <p className={styles.note}>どの段でも、消す・設定・権限・鍵・お金・個人情報の書き出しはできません。作った後に段は変えられません。</p>
          <div className={styles.selects}>
            <EntityPickerField label="使えるアカウント" noun="アカウント" title="使えるアカウントを選ぶ" value={accountId} items={accountOptions.map((option) => ({ id: option.value, name: String(option.label) }))} onChange={(id) => setAccountId(id ?? '')} />
            <Select size="full" aria-label="期限" value={days} options={EXPIRY_OPTIONS} onChange={setDays} />
          </div>
        </div>
      </Dialog>
      {stepUp ? <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} /> : null}
    </SaveErrorScope>
  )
}

/** 板 Ge1vp「接続を作りました」。URL と鍵は今だけ。閉じる前に「鍵はもう見られません」の確かめ。 */
export function McpIssuedDialog({ issued, onClose }: { issued: McpIssued | null; onClose: () => void }) {
  const [confirmClose, setConfirmClose] = useState(false)
  useEffect(() => { if (!issued) setConfirmClose(false) }, [issued])
  const masked = issued ? `${issued.key.slice(0, 9)}••••••••••••${issued.key.slice(-4)}` : ''
  return (
    <>
      <Dialog
        open={issued !== null && !confirmClose}
        title="接続を作りました"
        description="鍵はこの窓を閉じると二度と見られません。いまコピーしてください。"
        designNode="Ge1vp"
        designWidth={620}
        onCancel={() => setConfirmClose(true)}

      >
        {issued ? (
          <div className={styles.issued}>
            <p className={styles.issuedMeta}>{`${issued.connection.name}・${LEVEL_LABEL[issued.connection.level]}・${issued.connection.accounts.map((account) => account.name).join('・')}・${day(issued.connection.expiresAt)} まで`}</p>
            <div className={styles.issuedRow}>
              <span className={styles.issuedLabel}>URL</span>
              <code className={styles.code}>{issued.url}</code>
              <CopyTextButton value={issued.url} variant="secondary" icon={<Copy size={16} aria-hidden="true" />} aria-label="接続の URL をコピー" />
            </div>
            <div className={styles.issuedRow}>
              <span className={styles.issuedLabel}>鍵</span>
              <code className={styles.code} title="鍵は伏せて出しています。コピーで全部を写せます">{masked}</code>
              <CopyTextButton value={issued.key} variant="secondary" icon={<Copy size={16} aria-hidden="true" />} aria-label="鍵をコピー" />
            </div>
            <p className={styles.howto}><Copy size={16} aria-hidden="true" />貼り方：Claude の［設定］→［コネクタ］→［URL を追加］に貼り、鍵を入れます。</p>
          </div>
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={issued !== null && confirmClose}
        title="閉じますか？"
        description="鍵はもう見られません。写していないときは、戻ってコピーしてください。見られなくなったら、鍵を作り直します。"
        confirmLabel="閉じる"
        cancelLabel="戻る"
        onConfirm={onClose}
        onCancel={() => setConfirmClose(false)}
      />
    </>
  )
}
