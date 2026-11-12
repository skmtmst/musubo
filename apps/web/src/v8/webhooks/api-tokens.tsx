'use client'

import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import ContextMenu from '@/components/shared/context-menu'
import CopyTextButton from '@/components/shared/copy-text-button'
import Dialog from '@/components/shared/dialog'
import { useWebhookWriteAccess } from './write-access'
import EmptyList from '@/components/shared/empty-list'
import { FolderDotName } from '@/components/shared/folder-dot'
import { Field } from '@/components/shared/form-controls'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import { RowMenu } from '@/components/shared/row-actions'
import { SaveErrorField,SaveErrorScope } from '@/components/shared/save-form-errors'
import { DelayedSkeleton,Skeleton } from '@/components/shared/skeleton'
import StatusBadge from '@/components/shared/status-badge'
import TruncatedText from '@/components/shared/truncated-text'
import { ActionCell,DataTable,TableHeadRow,Td,Th,Tr } from '@/components/shared/table'
import { TextField } from '@/components/shared/text-field'
import StepUpPrompt from '@/components/step-up-prompt'
import { ListPage } from '@/components/templates'
import { KeyRound,LayoutTemplate,Plus } from 'lucide-react'
import { SCOPES } from './api-token-words'
import { formatDate as polishFormatDate } from '@/lib/format'
import styles from './api-tokens.module.css'
import {
ViewerBand,
WEBHOOKS_DESCRIPTION,
WebhookTabs,
} from './shell'
import { useApiTokens } from './use-api-tokens'
import { McpConnectionsSection } from '@/v8/mcp-connect/public/section/index'

function SkeletonCells({ height, width }: { height: number; width: string }) {
  return (
    <>
      <span className={styles.colName}><Skeleton height={height} width={width} /></span>
      <span className={styles.colScopes}><Skeleton height={height} width={width} /></span>
      <span className={styles.colCreated}><Skeleton height={height} width={width} /></span>
      <span className={styles.colUsed}><Skeleton height={height} width={width} /></span>
      <span className={styles.colState}><Skeleton height={height} width={width} /></span>
    </>
  )
}

const SCOPE_LABELS: Record<string, string> = {
  'tags:read': 'タグを見る',
  'tags:write': 'タグを付ける',
}

export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope
}

/** 作った日は「2026/06/02」、最後に使ったは「9/30 10:02」（絵の書き方）。読めない日時は「—」。 */
export function tokenDate(value: string | null): string {
  return polishFormatDate(value, { style: 'list-day', fallback: '—' })
}

export function tokenUsedAt(value: string | null): string {
  return polishFormatDate(value, { style: 'list', fallback: value ? '—' : 'まだ使っていません' })
}

export default function WebhooksApiTokensV8() {
  const management = useWebhookWriteAccess()
  const { saveErrors, ownership, canManage, overview, tokens, status, loadError, actionError, createOpen, setCreateOpen, name, setName, nameError, scopesError, scopes, creating, createError, issued, setIssued, rotateTarget, setRotateTarget, revokeTarget, setRevokeTarget, targetAccountId, mutating, dialogError, setDialogError, stepUp, setStepUp, menuId, setMenuId, setCtxId, ctxToken, revokeMenuItemsFor, load, toggleScope, openCreate, handleCreate, handleRotate, handleRevoke } = useApiTokens()
  return (
    <SaveErrorScope errors={saveErrors}><ListPage
      help={<>{WEBHOOKS_DESCRIPTION}{"行の「…」から入れ替える・止める。止めても、すでに付けたタグは残ります。"}</>}
      boardId="ralAc"
      headingSize="regular"
      title="外部連携"

      actions={<Button lockedReason={management.reason} {...(management.allowed ? { href: "/webhooks?tab=notify" } : { disabled: true })}><LayoutTemplate size={16} aria-hidden="true" />見本から作る</Button>}
      tabs={<WebhookTabs active="api-tokens" outgoingCount={overview.outgoingCount} incomingCount={overview.incomingCount} />}
      stats={<>
        {ownership.known && !canManage ? <ViewerBand need="owner" /> : null}
      </>}
      overlays={<>
        <Dialog
          open={createOpen}
          confirmDisabled={!canManage}
          confirmLockedReason={ownership.reason}
          title="API 接続の鍵を発行する"
          designWidth={540}
          confirmLabel="発行する"
          confirmIcon={<KeyRound size={16} />}
          busy={creating}
          error={createError || undefined}
          onConfirm={() => handleCreate()}
          onCancel={() => { if (!creating) setCreateOpen(false) }}
        >
          <div className={styles.createBody}>
            <Field label="名前" htmlFor="wh-token-name" error={nameError}>
              <SaveErrorField names={["name"]}><TextField
                id="wh-token-name"
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                placeholder="例：在庫システム"
                aria-invalid={nameError ? true : undefined}
              /></SaveErrorField>
            </Field>
            <fieldset className={styles.field} id="wh-token-scopes" tabIndex={-1} aria-invalid={Boolean(scopesError) || undefined} aria-describedby={scopesError ? "wh-token-scopes-error" : undefined}>
              <legend className={styles.label}>できること</legend>
              <div className={styles.checkRow}>
                {SCOPES.map((scope) => (
                  <SaveErrorField names={["scope"]} key={scope}><Checkbox key={scope} invalid={Boolean(scopesError)} aria-describedby={scopesError ? "wh-token-scopes-error" : undefined} checked={scopes.includes(scope)} onCheckedChange={() => toggleScope(scope)}>
                    {scopeLabel(scope)}
                  </Checkbox></SaveErrorField>
                ))}
              </div>
              {scopesError ? <p id="wh-token-scopes-error" className={styles.fieldError} role="alert">{scopesError}</p> : null}
            </fieldset>
            <p className={styles.createNote}>発行した鍵は1回だけ表示されます。名前は、どの仕組みに渡した鍵かが分かるように付けます。</p>
          </div>
        </Dialog>

        {/*
          板 `UkZLi`「鍵を発行しました」。発行・入れ替えの直後に1回だけ窓で見せる（閉じると二度と見られない）。
          × と「写したので閉じる」はどちらも閉じるだけ。
        */}
        <Dialog
          open={issued !== null}
          title="鍵を発行しました"
          designWidth={540}
          designTop={220}
          designNode="UkZLi"
          onCancel={() => setIssued(null)}

        >
          {issued ? (
            <div className={styles.issuedBody}>
              <Notice tone="warn">
                この鍵は今だけ表示されます。閉じると二度と見られません。安全な場所に写してください。
              </Notice>
              <div className={styles.issuedTokenRow}>
                <code className={styles.issuedToken}>{issued.token}</code>
                <CopyTextButton value={issued!.token} aria-label="発行した鍵をコピー"  />
              </div>
              <p className={styles.issuedMeta} title={issued.name}>
                {`接続の名前：${issued.name}${issued.scopes.length ? `・できること：${issued.scopes.map(scopeLabel).join('・')}` : ''}`}
              </p>
            </div>
          ) : null}
        </Dialog>

        <ConfirmDialog
          open={rotateTarget !== null}
          title={`「${rotateTarget?.name ?? ''}」の鍵を入れ替えますか？`}
          description="今の鍵はすぐ使えなくなり、新しい鍵が1回だけ表示されます。外の仕組みの鍵を新しいものに書き換えるまで、つなぎ先の操作は止まります。"
          confirmLabel="入れ替える"
          confirmDisabled={!canManage}
          confirmLockedReason={ownership.reason}
          busy={mutating}
          error={dialogError}
          onConfirm={() => handleRotate()}
          onCancel={() => {
            if (mutating) return
            setRotateTarget(null)
            setDialogError('')
          }}
        ><OperationTargetSummary accounts={[{ id: targetAccountId ?? '' }]} /></ConfirmDialog>
        <ConfirmDialog
          open={revokeTarget !== null}
          title={`「${revokeTarget?.name ?? ''}」の鍵を止めますか？`}
          description="この鍵での外からの操作はすぐ止まります。すでに付けたタグは残ります。この操作は取り消せません。"
          confirmLabel="止める"
          confirmDisabled={!canManage}
          confirmLockedReason={ownership.reason}
          destructive
          busy={mutating}
          error={dialogError}
          onConfirm={() => handleRevoke()}
          onCancel={() => {
            if (mutating) return
            setRevokeTarget(null)
            setDialogError('')
          }}
        ><OperationTargetSummary accounts={[{ id: targetAccountId ?? '' }]} /></ConfirmDialog>
        {stepUp ? <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} /> : null}
      </>}
    >
      <div className={styles.body}>
        <div className={styles.createRow}>
          <Button variant="primary" disabled={!canManage} lockedReason={ownership.reason} onClick={openCreate}><Plus size={16} aria-hidden="true" />API 接続の鍵を発行する</Button>
          <span className={styles.spacer} aria-hidden="true" />
          <p className={styles.createRule}>鍵の発行・入れ替え・停止は統括だけができます</p>
        </div>

        {canManage ? <Notice tone="info" icon={<KeyRound size={16} aria-hidden="true" />}>鍵は発行したときに1回だけ表示されます。外の仕組みに書き写してから閉じてください。入れ替えると、今の鍵はすぐ使えなくなります。</Notice> : null}

        {actionError ? <Notice tone="danger">{actionError}</Notice> : null}

        {status === 'loading' ? (
          <div aria-busy="true" aria-label="鍵を読み込んでいます">
            <DelayedSkeleton
              loading
              skeleton={(
                <div className={styles.table} aria-hidden="true">
                  <div className={styles.headRow}>
                    <SkeletonCells height={12} width="50%" />
                  </div>
                  {[0, 1, 2].map((row) => (
                    <div key={row} className={styles.row}>
                      <SkeletonCells height={14} width="70%" />
                    </div>
                  ))}
                </div>
              )}
            />
          </div>
        ) : null}
        {status === 'error' ? (
          <ListState
            kind="error"
            title="鍵を読み込めませんでした"
            description={loadError}
            onRetry={() => void load()}
          />
        ) : null}
        {status === 'forbidden' ? (
          <ListState
            kind="forbidden"
            title="この画面を開く権限がありません"
            description="鍵の棚卸しは統括だけができます。必要なときは統括に頼んでください。"
          />
        ) : null}
        {status === 'disabled' ? (
          <ListState
            kind="empty"
            title="外部連携が止まっています"
            description="鍵の一覧は、外部連携を入れ直すと開けます。止めている間も、外から届く鍵の操作は止まっています。"
          />
        ) : null}
        {status === 'ready' && tokens.length === 0 ? (
          /* 修正案 D-2：空の一覧。 */
          <EmptyList
            icon={<KeyRound aria-hidden="true" />}
            title="まだ API 接続の鍵がありません"
            description={canManage ? 'ほかのシステムからこのアカウントを操作するための鍵を発行します。' : '鍵の発行は統括だけができます。'}
            create={{ label: '最初の鍵を発行する', onClick: openCreate }}
            canCreate={canManage}
            lockedReason={ownership.reason ?? null}
          />
        ) : null}
        {status === 'ready' && tokens.length > 0 ? (
          <>
            <ContextMenu
              label="鍵の操作"
              items={ctxToken ? revokeMenuItemsFor(ctxToken) : []}
              shouldOpen={(event) => {
                const row = (event.target as HTMLElement).closest('[data-ctx-row]')
                if (!row) return false
                setCtxId(row.getAttribute('data-ctx-row'))
                return true
              }}
            >
              <DataTable aria-label="API 接続の鍵" columnSizing="content">
                <thead>
                  <TableHeadRow>
                  {/* 名前とできることで残りの幅を分け合う（MCP の表と同じ考え方）。日付と状態は中身の幅のまま。 */}
                  <Th grow weight={2}>名前</Th>
                  <Th grow weight={1}>できること</Th>
                  <Th>作った日</Th>
                  <Th>最後に使った</Th>
                  <Th>状態</Th>
                  <Th><span className={styles.srOnly}>操作</span></Th>
                </TableHeadRow>
                </thead>
                <tbody>
                {tokens.map((token) => {
                  const scopeText = token.scopes.map(scopeLabel).join('・')
                  return (
                    <Tr data-row-id={token.id} key={token.id} data-ctx-row={token.id}>
                      <Td grow weight={2} title={token.name}><FolderDotName>{token.name}</FolderDotName></Td>
                      <Td grow weight={1} title={scopeText}><TruncatedText value={scopeText} /></Td>
                      <Td>{tokenDate(token.createdAt)}</Td>
                      <Td>{tokenUsedAt(token.lastUsedAt)}</Td>
                      <Td>
                        <StatusBadge tone="success">使っている</StatusBadge>
                      </Td>
                      {/* 行の右端は「…」1つ（B-253・絵 ralAc）。入れ替える・止めるはその中。 */}
                      <ActionCell>
                        {<RowMenu
                            appearance="plain"
                            label={`「${token.name}」の操作`}
                            open={menuId === token.id}
                            onOpenChange={(next) => setMenuId(next ? token.id : null)}
                            items={[{
                              id: 'rotate',
                              disabled: !canManage && !ownership.reason,
                              lockedReason: ownership.reason,
                              label: '入れ替える',
                              onSelect: () => {
                                setMenuId(null)
                                setDialogError('')
                                setRotateTarget(token)
                              },
                            }, {
                              id: 'revoke',
                              disabled: !canManage && !ownership.reason,
                              lockedReason: ownership.reason,
                              label: '止める',
                              tone: 'danger',
                              onSelect: () => {
                                setMenuId(null)
                                setDialogError('')
                                setRevokeTarget(token)
                              },
                            }]}
                          />}
                      </ActionCell>
                    </Tr>
                  )
                })}
              </tbody>
              </DataTable>
            </ContextMenu>
          </>
        ) : null}
        {/* G9：AI とつなぐ（MCP）の区画（板 Xb0yc）。スタッフには出さない。 */}
        <McpConnectionsSection />
      </div>
    </ListPage></SaveErrorScope>
  )
}
