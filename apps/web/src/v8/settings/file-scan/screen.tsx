'use client'

import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { isForbiddenOrRateLimited } from '@/components/shared/api-error-message'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import Button from '@/components/shared/button'
import Card,{ CardHeader } from '@/components/shared/card'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { emptyValue, EmptyCell } from '@/components/shared/empty-value'
import SegmentedControl from '@/components/shared/segmented'
import { Field } from '@/components/shared/form-controls'
import { GridCell,GridHeadRow,GridRow,GridTable } from '@/components/shared/grid-table'
import ListState from '@/components/shared/list-state'
import ListToolbar from '@/components/shared/list-toolbar'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import { RowMenu } from '@/components/shared/row-actions'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextArea,TextField } from '@/components/shared/text-field'
import ListRange from '@/components/ui/list-range'
import type { FileScanItem } from '@/lib/api'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { RotateCcw,SlidersHorizontal,Trash2 } from 'lucide-react'
import { useEffect,useRef,useState } from 'react'
import { SbSettingsScreen } from '../sb-frame/settings-screen'
import styles from './screen.module.css'
import { FILE_SCAN_PAGE_SIZE,useFileScan } from './use-file-scan'

/*
 * ★V8 ファイルの安全確認（Pencil 、状態は ）。
 *
 * 動き（権限・一覧・札の絞り込み・探す・ページ送り・使えるように戻す・消す・外の検査の設定）は
 * 今までの V8（app/settings/file-scan/file-scan-v8.tsx）と同じ。処理は同じ場所の use-file-scan.ts（写し）。
 * 行の右端は「使えるように戻す」＋「…」（中の「削除する」）。
 */

const TITLE = 'ファイルの安全確認'
const DESCRIPTION = '上げたファイルに危ないものがないかを確かめます'
/* 決まり2: いつも同じ説明は帯にせず、題の横の「？」へ入れる。 */
const EXPLANATION = '確かめ終わるまで、上げたファイルは配信・公開・審査に出せません。'

/* 板の札。`使えません`・`使えます` の絞り込みは 管理画面 の画面に残す。 */
const STATUS_CHIPS = [
  { value: 'quarantined', label: 'しまったファイル' },
  { value: 'pending', label: '確かめ中' },
  { value: 'released', label: '戻した' },
] as const

/** 見つかったものの色。画像の後ろのデータ（ほぼ無害なことが多い）は琥珀、ほかは赤。 */
function reasonTone(item: FileScanItem): 'warn' | 'danger' | 'none' {
  if (!item.reasonCode) return 'none'
  return item.reasonCode === 'trailing_data' ? 'warn' : 'danger'
}

export default function FileScanScreen() {
  const {
    selectedAccountId,
    phase,
    loadError,
    canEdit,
    items,
    total,
    counts,
    statusFilter,
    query,
    page,
    setPage,
    actionError,
    setActionError,
    actionDone,
    releaseTarget,
    setReleaseTarget,
    releaseReason,
    setReleaseReason,
    releaseBusy,
    releaseError,
    setReleaseError,
    deleteTarget,
    setDeleteTarget,
    deleteBusy,
    deleteError,
    setDeleteError,
    config,
    configOpen,
    provider,
    setProvider,
    endpoint,
    setEndpoint,
    secretRef,
    setSecretRef,
    configBusy,
    configDirty,
    configFields,
    stopExternal,
    setStopExternal,
    stopError,
    setStopError,
    leaveTarget,
    confirmLeave,
    cancelLeave,
    load,
    release,
    remove,
    saveConfig,
    stopExternalConfig,
    toggleConfigOpen,
    changeQuery,
    changeStatusFilter,
  } = useFileScan()
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const releaseReasonRef = useRef<HTMLTextAreaElement>(null)
  const releaseReasonError = releaseError === '理由を入力してください' ? releaseError : ''
  useEffect(() => {
    if (!releaseReasonError) return
    releaseReasonRef.current?.focus()
    releaseReasonRef.current?.scrollIntoView({ block: 'center' })
  }, [releaseReasonError])

  const openRelease = (item: FileScanItem) => { setReleaseTarget(item); setReleaseReason(''); setReleaseError('') }
  const openDelete = (item: FileScanItem) => { setDeleteTarget(item); setDeleteError('') }

  const dialogs = (
    <>
      {releaseTarget ? (
        <ConfirmDialog
          open
          title="使えるように戻す"
          description={`${releaseTarget.filename} は誤りだったとして、使えるように戻します。理由は記録に残ります。`}
          confirmLabel="使えるように戻す"
          cancelLabel="キャンセル"
          busy={releaseBusy}
          error={releaseReasonError ? undefined : releaseError || undefined}
          onCancel={() => { setReleaseTarget(null); setReleaseReason(''); setReleaseError('') }}
          onConfirm={() => {
            if (!releaseReason.trim()) {
              setReleaseError('理由を入力してください')
              releaseReasonRef.current?.focus()
              releaseReasonRef.current?.scrollIntoView({ block: 'center' })
              return
            }
            return release()
          }}
        >
          <OperationTargetSummary accounts={[{ id: releaseTarget.lineAccountId ?? '' }]} />
          <Field label="理由（必須）" htmlFor="file-scan-release-reason" error={releaseReasonError || undefined}>
            <SaveErrorField names={["releaseReason","release_reason"]}><TextArea
              ref={releaseReasonRef}
              id="file-scan-release-reason"
              aria-required="true"
              value={releaseReason}
              onChange={(event) => { setReleaseReason(event.target.value); setReleaseError('') }}
              placeholder="例：社内の画像と確認できたため"
            /></SaveErrorField>
          </Field>
        </ConfirmDialog>
      ) : null}

      <UnsavedLeaveDialog
        open={leaveTarget !== null}
        subject="外の検査の設定の変更"
        busy={configBusy}
        onCancel={() => { if (!configBusy) cancelLeave() }}
        onConfirm={() => { confirmLeave() }}
      />

      {stopExternal ? (
        <ConfirmDialog
          open
          title="外の検査を止める"
          description="外の検査サービスへの送信設定を消します。内蔵の簡易検査は続きます。もう一度使うには設定を入れ直します。"
          confirmLabel="外の検査を止める"
          cancelLabel="キャンセル"
          busy={configBusy}
          error={stopError || undefined}
          onCancel={() => { setStopExternal(false); setStopError('') }}
          onConfirm={() => stopExternalConfig()}
        >
          <OperationTargetSummary accounts={[{ id: selectedAccountId ?? '' }]} />
        </ConfirmDialog>
      ) : null}

      {deleteTarget ? (
        <ConfirmDialog
          open
          title="ファイルを削除する"
          deleteName={deleteTarget.filename}
          description={`${deleteTarget.filename} を消します。中身は画面に出ません。監査の記録は残ります。`}
          confirmLabel="削除する"
          cancelLabel="キャンセル"
          destructive
          busy={deleteBusy}
          error={deleteError || undefined}
          onCancel={() => { setDeleteTarget(null); setDeleteError('') }}
          onConfirm={() => remove()}
        >
          <OperationTargetSummary accounts={[{ id: deleteTarget.lineAccountId ?? '' }]} />
        </ConfirmDialog>
      ) : null}
    </>
  )

  if (phase === 'loading' || phase === 'error' || phase === 'forbidden' || !selectedAccountId) {
    return (
      <SbSettingsScreen boardId="PfA4o" title={TITLE} help={DESCRIPTION} explanation={EXPLANATION}>
        {phase === 'loading' ? (
          <ListState kind="loading" />
        ) : phase === 'error' ? (
          <ListState
            kind="error"
            title={isForbiddenOrRateLimited(loadError) ? undefined : 'ファイルの安全確認を読み込めませんでした'}
            description={isForbiddenOrRateLimited(loadError) ? undefined : '通信状態を確認して、もう一度読み込んでください。'}
            error={loadError ?? undefined}
            onRetry={() => void load()}
          />
        ) : phase === 'forbidden' ? (
          <ListState
            kind="forbidden"
            title="ファイルの安全確認は管理者だけが開けます"
            description="しまったファイルの確認は、owner・admin の操作です。変えたいときは管理者に頼んでください。"
          />
        ) : (
          <ListState kind="empty" title="LINEアカウントを選んでください" description="ファイルの安全確認はLINEアカウントごとに管理します。" />
        )}
        {canEdit ? dialogs : null}
      </SbSettingsScreen>
    )
  }

  const menuItems = (item: FileScanItem): ActionMenuItem[] => [
    { id: 'delete', label: '削除する', tone: 'danger', icon: <Trash2 size={16} aria-hidden="true" />, onSelect: () => openDelete(item) },
  ]
  const externalConfigured = Boolean(config?.externalProvider || config?.externalEndpointUrl || config?.externalSecretRef)
  const externalOn = config?.externalEnabled === true
  const legacySecret = Boolean(config?.externalSecretRef && !/^FILE_SCAN_SECRET_[A-Z0-9_]+$/.test(config.externalSecretRef))

  return (
      <SbSettingsScreen boardId="PfA4o" title={TITLE} help={DESCRIPTION} explanation={EXPLANATION}
        saveActions={canEdit && configOpen && (configDirty || configBusy) ? <><Button disabled={configBusy} onClick={() => { setProvider(config?.externalProvider ?? ''); setEndpoint(config?.externalEndpointUrl ?? ''); setSecretRef(config?.externalSecretRef ?? ''); setActionError(''); configFields.reset() }}>キャンセル</Button><Button variant="primary" disabled={configBusy} onClick={() => void saveConfig()} busy={configBusy} busyLabel="保存しています…">外の検査の設定を保存する</Button></> : undefined}>
      {actionError ? <Notice tone="danger" message={actionError} /> : null}
      {actionDone ? <Notice tone="success" role="status">{actionDone}</Notice> : null}

      <ListToolbar
        search={{ value: query, onChange: changeQuery, label: 'ファイル名で探す', placeholder: 'ファイル名で探す' }}
        filters={<SegmentedControl
          aria-label="状態で絞り込む"
          value={statusFilter}
          onChange={changeStatusFilter}
          options={STATUS_CHIPS.map((chip) => ({
            value: chip.value,
            label: chip.label,
            count: chip.value === 'released' ? undefined : counts[chip.value],
          }))}
        />}
      />

      {items.length === 0 ? (
        statusFilter === 'quarantined' && !query ? (
          <ListState kind="empty" title="しまったファイルはありません" description="危ないものが見つかったファイルは、ここに入ります。" />
        ) : (
          <ListState
            kind="empty"
            emptyPreset="filtered"
            title="条件に合うものはありません"
            description="絞り込みや検索を外すと、すべて出ます"
            action={query ? <Button variant="secondary" onClick={() => changeQuery('')}>条件を外す</Button> : undefined}
          />
        )
      ) : (
        <GridTable label="しまったファイルの一覧" design={{ columns: 'minmax(0, 1fr) var(--tpl-sb-fs-col-uploader) minmax(0, 1fr) var(--tpl-sb-fs-col-action)', gap: 'var(--tpl-sb-tbl-gap)', padding: 'var(--tpl-sb-tbl-pad)', rowPadding: 'var(--tpl-sb-tbl-row-pad)', fontSize: 'var(--tpl-sb-tbl-head)', color: 'var(--color-ink)' }}>
          <div role="rowgroup">
            <GridHeadRow>
              <GridCell role="columnheader">ファイル</GridCell>
              <GridCell role="columnheader">上げた人</GridCell>
              <GridCell role="columnheader">見つかったもの</GridCell>
              <GridCell role="columnheader"><span className={styles.srOnly}>操作</span></GridCell>
            </GridHeadRow>
          </div>
          <div role="rowgroup">
            {items.map((item) => (
              <GridRow key={item.id}>
                <GridCell role="cell" className={`${styles.cell} ${styles.name}`} title={item.filename}>
                  {item.filename}
                  {item.releasedAt ? <span className={styles.released}>戻した</span> : null}
                </GridCell>
                <GridCell role="cell" className={styles.cell} title={item.uploaderLabel ?? emptyValue('unknown')}>{item.uploaderLabel ?? emptyValue('unknown')}</GridCell>
                <GridCell role="cell" className={styles.cell} data-tone={reasonTone(item)} title={item.reasonLabel ?? '確認が必要です'}>
                  {item.reasonLabel ?? '確認が必要です'}
                </GridCell>
                <GridCell role="cell" className={styles.actions}>
                  {canEdit && item.status === 'quarantined' ? (
                    <Button variant="text" onClick={() => openRelease(item)}>
                      <RotateCcw className={styles.btnIcon} aria-hidden="true" />
                      使えるように戻す
                    </Button>
                  ) : null}
                  {canEdit && (item.status === 'quarantined' || item.status === 'rejected') ? (
                    <span className={styles.menuBox}>
                      <RowMenu
                        label={`${item.filename}のその他操作`}
                        items={menuItems(item)}
                        open={openMenuId === item.id}
                        onOpenChange={(next) => setOpenMenuId(next ? item.id : null)}
                      />
                    </span>
                  ) : (
                    <EmptyCell />
                  )}
                </GridCell>
              </GridRow>
            ))}
          </div>
        </GridTable>
      )}

      {total > FILE_SCAN_PAGE_SIZE ? (
        <div className={styles.toolbar}>
          <ListRange
            total={total}
            first={(page - 1) * FILE_SCAN_PAGE_SIZE + 1}
            last={Math.min(page * FILE_SCAN_PAGE_SIZE, total)}
          />
          <Pagination page={page} pageCount={Math.ceil(total / FILE_SCAN_PAGE_SIZE)} onPageChange={setPage} />
        </div>
      ) : null}

      {!canEdit ? <ReadOnlyNotice /> : null}
      <Card variant="form" aria-label="外の検査サービス">
        <CardHeader title="外の検査サービス" size="content" meta={externalOn
                ? '外の検査への送信は有効です。接続先の稼働状況を確認した表示ではありません。'
                : externalConfigured && config?.externalEnabled === undefined
                  ? '外の検査への送信状態を確認できません。読み直してください。'
                  : '外の検査への送信は停止中です。いまは内蔵の簡易検査だけです。'} action={canEdit ? <>
          {externalConfigured ? <Button variant="secondary" type="button" disabled={configBusy} onClick={() => { setStopExternal(true); setStopError('') }}>外の検査を止める</Button> : null}
          <Button variant="secondary" type="button" actionWording onClick={toggleConfigOpen}><SlidersHorizontal aria-hidden="true" />{configOpen ? '設定を閉じる' : '設定を編集'}</Button>
        </> : undefined} />
        {legacySecret ? <Notice tone="warn">古い鍵の名前は使えません。運営が用意した検査専用の鍵の名前へ変更してください。</Notice> : null}
        {externalConfigured && !externalOn && config?.externalEnabled === false && !legacySecret ? <Notice tone="warn">現在の設定では外の検査へ送信できません。送り先と鍵の名前の組を運営に確認してください。</Notice> : null}
        {canEdit && configOpen ? (
          <div className={styles.form}>
            <Field label="提供元" htmlFor="file-scan-provider" requirement={configFields.requirement('externalProvider')} error={configFields.error('externalProvider')}>
              <SaveErrorField names={["externalProvider","provider"]}><TextField {...configFields.bind('externalProvider')} id="file-scan-provider" value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="例：example-scan" /></SaveErrorField>
            </Field>
            <Field label="送り先（https）" htmlFor="file-scan-endpoint" requirement={configFields.requirement('externalEndpointUrl')} error={configFields.error('externalEndpointUrl')} note="運営が許可した送り先と鍵の名前の組だけ使えます。転送する宛先は使えません。">
              <SaveErrorField names={["externalEndpointUrl","endpoint"]}><TextField {...configFields.bind('externalEndpointUrl')} id="file-scan-endpoint" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://example.com/scan" /></SaveErrorField>
            </Field>
            <Field label="鍵の名前" htmlFor="file-scan-secret-ref" requirement={configFields.requirement('externalSecretRef')} error={configFields.error('externalSecretRef')} note="FILE_SCAN_SECRET_ で始まる大文字・数字・下線、120文字以内。送り先と同じ組の名前を指定します。鍵の値は入力しません。">
              <SaveErrorField names={["externalSecretRef","secretRef","secret_ref"]}><TextField {...configFields.bind('externalSecretRef')} id="file-scan-secret-ref" value={secretRef} onChange={(event) => setSecretRef(event.target.value)} placeholder="例：FILE_SCAN_SECRET_PRIMARY" /></SaveErrorField>
            </Field>

          </div>
        ) : null}
      </Card>

      {canEdit ? dialogs : null}
    </SbSettingsScreen>
  )
}
