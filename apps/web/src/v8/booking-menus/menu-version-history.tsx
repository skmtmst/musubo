'use client'
import { DetailContent, DetailSectionTitle } from '@/components/shared/detail-content'

import { useActionError } from '@/lib/use-action-error'

import { useCallback, useEffect, useRef, useState } from 'react'
import Drawer from '@/components/shared/drawer'
import Button from '@/components/shared/button'
import { useStaffRole } from '@/lib/staff-role'
import { lockReason } from '@/components/shared/permission-lock'
import ListState from '@/components/shared/list-state'
import VersionCompare from '@/components/shared/version-compare'
import VersionHistory, { type HistoryVersion } from '@/components/shared/version-history'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { notifyToast } from '@/components/shared/toast'
import { ApiError, bookingApi, type BookingMenuVersion } from '@/lib/api'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import Notice from '@/components/shared/notice'

/**
 * T: 予約メニューの版の履歴（右から出る欄）。
 * 版そのものは共通部品（VersionHistory・VersionCompare）で見せる。
 * この引き出しは読み・比べ・戻すの配線だけを持つ。
 */
export default function MenuVersionHistory({
  menuId,
  menuName,
  currentVersion,
  accountId,
  canRevert,
  onReverted,
  onClose,
}: {
  menuId: string
  menuName: string
  currentVersion: number
  accountId: string
  canRevert: boolean
  onReverted: (version: number) => void
  onClose: () => void
}) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [versions, setVersions] = useState<BookingMenuVersion[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [comparing, setComparing] = useState(false)
  const [confirming, setConfirming] = useState<{ accountId: string; menuId: string; menuName: string; selected: number; expectedVersion: number } | null>(null)
  const [reverting, setReverting] = useState(false)
  const [reviewRequired, setReviewRequired] = useState(false)
  const loadSequence = useRef(0)
  const { error: revertError, setError: setRevertError } = useActionError(`${accountId}:${menuId}`)

  /*
   * WEB051：戻すときに送る「いまの版」。開いたときの版（親の値）から始め、
   * 読み直したら最新の版へ進める。409 のあと古い版のまま送り直して黙って失敗しない。
   */
  const [expectedVersion, setExpectedVersion] = useState(currentVersion)
  useEffect(() => { setExpectedVersion(currentVersion) }, [currentVersion])

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setLoadState('loading')
    // WEB051：競合の知らせは読み直しで消さない。
    try {
      const response = await bookingApi.listMenuVersions(accountId, menuId)
      if (sequence !== loadSequence.current) return
      const list = Array.isArray(response.versions) ? response.versions : []
      setVersions(list)
      const latest = list.find((v) => v.status === 'in_use')?.version_number
        ?? list.reduce<number | null>((max, v) => (max == null || v.version_number > max ? v.version_number : max), null)
      // 版は増えるだけ。409 で口が返した版より古い一覧が届いても戻さない。
      if (latest != null) setExpectedVersion((known) => Math.max(known, latest))
      setSelected((current) => {
        if (current != null && list.some((v) => v.version_number === current)) return current
        return list[0]?.version_number ?? null
      })
      setLoadState('ready')
    } catch {
      if (sequence !== loadSequence.current) return
      setLoadState('error')
    }
  }, [accountId, menuId])

  useEffect(() => {
    void load()
    return () => { loadSequence.current += 1 }
  }, [load])

  const history: HistoryVersion[] = versions.map((version) => ({
    versionNumber: version.version_number,
    title: version.title,
    status: version.status === 'in_use' ? 'in_use' : 'past',
    statusNote: version.status === 'in_use' ? 'いま使っている' : null,
    summary: version.summary,
    author: version.author,
    at: version.at,
  }))
  const selectedVersion = versions.find((v) => v.version_number === selected) ?? null
  const current = versions.find((v) => v.version_number === expectedVersion)
    ?? versions.find((v) => v.status === 'in_use') ?? null

  const currentKnown = versions.some(version => version.version_number === expectedVersion)
  const openConfirm = () => {
    if (!canRevert || !currentKnown || selected == null) return
    setRevertError('')
    setReviewRequired(false)
    setConfirming({ accountId, menuId, menuName, selected, expectedVersion })
  }
  const doRevert = async () => {
    if (!confirming || reviewRequired || !currentKnown || !canRevert) return false
    if (confirming.accountId !== accountId || confirming.menuId !== menuId || confirming.selected !== selected || confirming.expectedVersion !== expectedVersion) {
      setRevertError('対象が変わりました。閉じて内容を確かめ、もう一度選んでください。')
      return false
    }
    setReverting(true)
    setRevertError('')
    try {
      const response = await bookingApi.revertMenuVersion(confirming.accountId, confirming.menuId, confirming.selected, confirming.expectedVersion)
      setConfirming(null)
      notifyToast(`第${confirming.selected}版の中身で新しい版（第${response.version}版）を作りました。`)
      onReverted(response.version)
      await load()
      return true
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setReviewRequired(true)
        // WEB051：口が返した今の版を、次に送る版にする。
        const latest = Number((error.data as { currentVersion?: unknown } | undefined)?.currentVersion)
        if (Number.isInteger(latest) && latest > 0) setExpectedVersion(latest)
        setRevertError('ほかの人が先に保存しました。最新の版を読み直しました。内容を確かめてから、もう一度お試しください。')
        await load()
      } else if (error instanceof ApiError && error.status === 403) {
        setRevertError(permissionDeniedMessage('store'))
      } else {
        setRevertError('版を戻せませんでした。通信状態を確認して、もう一度お試しください。')
      }
      return false
    } finally {
      setReverting(false)
    }
  }

  const role = useStaffRole()
  return (
    <Drawer
      open
      title={`「${menuName}」の版の履歴`}
      description="保存するたびに版が1つ増えます。前の版は変わりません。"
      busy={reverting}
      onClose={onClose}
      actions={loadState === 'ready' && versions.length > 0 ? {
        secondary: <Button variant="secondary" disabled={!selectedVersion || reverting} onClick={() => setComparing(true)}>いまと比べる</Button>,
        primary: <Button variant="primary" disabled={!selectedVersion || !canRevert || reverting || !currentKnown} lockedReason={role === null ? undefined : lockReason(canRevert)} onClick={openConfirm}>この版に戻す</Button>,
      } : undefined}
    >
<DetailContent>
      {loadState === 'loading' ? (
        <ListState kind="loading" title="版の履歴を読み込んでいます" />
      ) : loadState === 'error' ? (
        <ListState
          kind="error"
          title="版の履歴"
          description="版の履歴を読み込めませんでした。"
          onRetry={() => void load()}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {revertError ? (
            <Notice tone="danger" >{revertError}</Notice>
          ) : null}
          <VersionHistory
            showActions={false}
            versions={history}
            selectedVersionNumber={selected}
            onSelect={(versionNumber) => {
              setSelected(versionNumber)
              setComparing(false)
            }}
            compareLabel="いまと比べる"
            onCompare={() => setComparing(true)}
            revertLabel="この版に戻す"
            onRevert={openConfirm}
            canRevert={canRevert && currentKnown}
            revertDisabledReason={canRevert ? undefined : '版を戻す権限がありません。'}
            busy={reverting}
          />
          {comparing && selectedVersion ? (
            <section aria-label="版の比べ">
              <DetailSectionTitle>
                {selectedVersion.title}と{current?.title ?? 'いまの版'}の比べ
              </DetailSectionTitle>
              <VersionCompare
                before={selectedVersion.lines.join('\n')}
                after={(selectedVersion.version_number === current?.version_number
                  ? selectedVersion
                  : current)?.lines.join('\n') ?? ''}
              />
            </section>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={confirming !== null}
        title={`第${confirming?.selected ?? ''}版に戻しますか？`}
        description="いまの版は残ります。この版の中身で新しい版を作ります。"
        confirmLabel="新しい版を作る"
        cancelLabel="キャンセル"
        busy={reverting}
        confirmDisabled={reviewRequired}
        confirmDisabledReason="閉じて最新の版と比べ、戻す内容を確認してください。"
        onCancel={() => { setConfirming(null); if (reviewRequired) void load() }}
        error={revertError || undefined} onSuccess={() => setConfirming(null)} onConfirm={() => doRevert()}
      ><OperationTargetSummary accounts={[{ id: confirming?.accountId ?? '' }]} externalTarget={{ label: '予約メニュー', name: confirming?.menuName }} /></ConfirmDialog>

</DetailContent>
</Drawer>
  )
}
