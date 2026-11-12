'use client'

import { Pencil, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, type OpsAnnouncement } from '@/lib/api'
import { opsCall } from '@/components/ops/ops-ui'
import { describeApiFailure, isForbiddenOrRateLimited } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import HelpTip from '@/components/shared/help-tip'
import ListState from '@/components/shared/list-state'
import { useListUrlState } from '@/components/shared/list-url-state'
import { RowMenu } from '@/components/shared/row-actions'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import { OpsHead } from './shell'
import { OPS_READONLY_LOCK_REASON, useOpsReadOnlyState } from './use-ops-read-only'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import parts from './parts.module.css'
import styles from './announcements.module.css'
import { formatDate as polishFormatDate, formatDateTime, formatNumber } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'

/**
 * 運営のお知らせ配信 V8（一覧）。
 *
 * 作る欄は別の画面（/ops/announcements/new）に分け、ここは一覧だけ。
 * 右上の［お知らせを作る］→作る画面（下の帯に［下書きを保存］［今すぐ送る］）。
 * 下書き・予約は行の「…」から編集・削除、送ったものは中身を写して新しく作る。
 * 閲覧のみの運営メンバーには、作るボタンも行の「…」も押せない形＋理由で出す
 * （2026-10-26 オーナー決定）。役割が分かるまでは理由なしの押せない形。
 */

const STATUS_TONE: Record<OpsAnnouncement['status'], StatusBadgeTone> = { draft: 'neutral', scheduled: 'info', sending: 'warning', sent: 'success', failed: 'danger' }

/** 一覧の小さい日時（9/18 10:00）。 */
function shortDateTime(value: string | null): string {
  return polishFormatDate(value, { style: 'list', fallback: '—' })
}

function loadDescription(err: unknown): string | undefined {
  if (isForbiddenOrRateLimited(err)) return undefined
  if (err instanceof TypeError) return '通信できませんでした。ネットワークを確認してもう一度お試しください'
  return describeApiFailure(err, '読み込み', { scope: 'hq' })
}

/** 行の「…」の中身。閲覧のみは押せない形＋理由、役割が分かるまでは理由なしの押せない形。 */
function rowItems(a: OpsAnnouncement, access: 'unknown' | 'readonly' | 'writer', busy: boolean, onRemove: () => void): ActionMenuItem[] {
  if (a.status === 'sending') return []
  const items: ActionMenuItem[] = a.status === 'draft' || a.status === 'scheduled'
    ? [
        { id: 'edit', label: '編集する', icon: <Pencil size={16} aria-hidden="true" />, disabled: busy, href: `/ops/announcements/new?id=${encodeURIComponent(a.id)}` },
        { id: 'remove', label: '削除する', tone: 'danger', icon: <Trash2 size={16} aria-hidden="true" />, disabled: busy, onSelect: onRemove },
      ]
    : [{ id: 'edit', label: '編集する', description: '送ったものは変えず、中身を写して新しく作ります', icon: <Pencil size={16} aria-hidden="true" />, disabled: busy, href: `/ops/announcements/new?copy=${encodeURIComponent(a.id)}` }]
  if (access === 'readonly') return items.map(({ href: _href, onSelect: _onSelect, ...item }) => ({ ...item, disabled: false, lockedReason: OPS_READONLY_LOCK_REASON }))
  if (access === 'unknown') return items.map((item) => ({ ...item, disabled: true }))
  return items
}

export default function OpsAnnouncementsV8() {
  const saveErrors = useSaveFormErrors()

  const [rows, setRows] = useState<OpsAnnouncement[]>([])
  const [loaded, setLoaded] = useState(false)
  const [linked, setLinked] = useState<{ linked: number; total: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [actionError, setActionError] = useState('')
  const [deleting, setDeleting] = useState<OpsAnnouncement | null>(null)
  const access = useOpsReadOnlyState()
  const [urlState, setUrlState] = useListUrlState({ highlight: '' })
  // 作る画面は `?highlight=<作った行のID>` で戻ってくる。表の共通部品と同じく1回だけ使って消す。
  const [highlightId, setHighlightId] = useState('')

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const res = await api.ops.announcements.list()
      if (!res.success) { setLoadError(new Error(res.error || '読み込めませんでした')); return }
      setRows(res.data)
      setLinked(res.linked)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
      { if (!fieldFailure)
      setLoadError(caught) }
    } finally {
      setLoaded(true)
    }
  }, [saveErrors])

  useEffect(() => { void load() }, [load])

  // 対象の行が描かれてから印を消費する。読み込み中には消さない（表の共通部品と同じ）。
  useEffect(() => {
    if (!urlState.highlight || typeof document === 'undefined') return
    const found = rows.some((a) => a.id === urlState.highlight)
    if (!found) return
    setHighlightId(urlState.highlight)
    setUrlState({ highlight: '' })
    document.querySelector(`[data-row-id="${CSS.escape(urlState.highlight)}"]`)?.scrollIntoView({ block: 'center' })
  }, [rows, setUrlState, urlState.highlight])

  const remove = async () => {
    if (access !== 'writer' || !deleting || !rows.some(row => row.id === deleting.id && row.updatedAt === deleting.updatedAt)) return
    setBusy(true)
    const res = await opsCall(api.ops.announcements.remove(deleting.id))
    setBusy(false)
    if (!res.success) { setActionError(res.error || '消せませんでした'); return }
    setDeleting(null)
    setActionError('')
    await load()
  }

  return (
    <SaveErrorScope errors={saveErrors}><div data-design-node="tQ2MJ">
      <OpsHead
        title="お知らせ"
        description="契約先へ、画面のお知らせ・メール・契約者専用LINE でお知らせを送ります。"
        actions={access === 'unknown' ? (
          <Button variant="primary" disabled>
            お知らせを作る
          </Button>
        ) : (
          <Button variant="primary" href="/ops/announcements/new" lockedReason={access === 'readonly' ? OPS_READONLY_LOCK_REASON : undefined}>
            お知らせを作る
          </Button>
        )}
      />
      <div className={styles.listWrap}>
        <section aria-label="配信済みの表" className={styles.list}>
          <div className={styles.listHead}>
            <h2 className={parts.panelTitle}>配信済み・予約・下書き</h2>
            <HelpTip label="契約者専用LINEの登録状況">{linked ? `契約者専用LINEの登録 ${linked.linked} 人 / ${formatNumber(linked.total)} 人` : '登録状況を読み込んでいます'}</HelpTip>
          </div>
          {actionError && !deleting ? <Notice tone="danger" className={parts.alertNoticePlacement}>{actionError}</Notice> : null}
          {!loaded ? (
            <ListState permissionScope="hq" kind="loading" title="読み込んでいます" />
          ) : loadError ? (
            <div className={parts.panel}>
              <ListState permissionScope="hq" kind="error" title="お知らせを表示できませんでした" description={loadDescription(loadError)} error={loadError ?? undefined} onRetry={() => void load()} />
            </div>
          ) : rows.length === 0 ? (
            <div className={parts.panel}>
              <ListState permissionScope="hq" kind="empty" title="まだお知らせはありません" description="右上の「お知らせを作る」から作ると、ここに並びます。" />
            </div>
          ) : (
            <div className={parts.mini} role="table" aria-label="配信済み・予約・下書き">
              <div className={parts.miniHead} role="row">
                <span className={parts.grow} role="columnheader">件名</span>
                <span className={`${parts.fixed} ${styles.colTo}`} role="columnheader">宛先</span>
                <span className={`${parts.fixed} ${styles.colState}`} role="columnheader">状態</span>
                <span className={`${parts.num} ${styles.colRead}`} role="columnheader">画面で既読</span>
                <span className={`${parts.num} ${styles.colLine}`} role="columnheader">LINE送達</span>
                <span className={`${parts.fixed} ${styles.colOps}`} role="columnheader">操作</span>
              </div>
              {rows.map((a) => (
                <div key={a.id} className={`${parts.miniRow} ${styles.row}`} role="row" data-row-id={a.id} data-highlight={highlightId === a.id || undefined}>
                  <span className={`${parts.grow} ${styles.subject}`} role="cell">
                    <span className={styles.subjectText} title={a.subject}>{a.subject}</span>
                    <span className={styles.sub} title={`${a.channelLabels.join('・')} ${formatDateTime(a.sentAt ?? a.publishAt)}${a.lastError ? `・${a.lastError}` : ''}`}>
                      {`${shortDateTime(a.sentAt ?? a.publishAt)}${a.status === 'scheduled' ? ' 予約' : ''}${a.lastError ? `・${a.lastError}` : ''}`}
                    </span>
                  </span>
                  <span className={`${parts.fixed} ${styles.colTo}`} role="cell" title={a.audienceLabel}>{a.audienceKind === 'all' ? 'すべて' : a.audienceLabel}</span>
                  <span className={`${parts.fixed} ${styles.colState}`} role="cell"><StatusBadge tone={STATUS_TONE[a.status]}>{a.statusLabel}</StatusBadge></span>
                  <span className={`${parts.num} ${styles.colRead}`} role="cell">{a.channels.includes('screen') && a.status === 'sent' ? `${a.screenRead}/${a.screenTotal}` : emptyValue('unknown')}</span>
                  <span className={`${parts.num} ${styles.colLine}`} role="cell">{a.channels.includes('line') && a.status === 'sent' ? `${a.lineSent}/${a.recipientsTotal}` : emptyValue('unknown')}</span>
                  <span className={`${parts.fixed} ${styles.colOps}`} role="cell">
                    {/* 行の右端は「…」1つ（B-253）。閲覧のみにも押せない形＋理由で出す（2026-10-26 オーナー決定）。送信中は中身の無い「…」（使える操作はありません）。 */}
                    <RowMenu
                      label={`「${a.subject}」の操作`}
                      size="row"
                      items={rowItems(a, access, busy, () => setDeleting(a))}
                    />
                  </span>
                </div>
              ))}
            </div>
          )}
          <p className={parts.note}>下書き・予約は消せます。配信済みのものは消せません。</p>
        </section>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        title={deleting ? `「${deleting.subject}」を削除しますか？` : ''}
        description="下書き・予約を消します。配信済みのものは消せません。"
        confirmLabel="削除する"
        destructive
        busy={busy}
        error={actionError}
        onConfirm={() => remove()}
        onCancel={() => { if (!busy) setDeleting(null) }}
      ><OperationTargetSummary accounts={[{ id: '', name: '不明' }]} externalTarget={{ label: 'お知らせ 1件', name: deleting?.subject }} /></ConfirmDialog>
    </div></SaveErrorScope>
  )
}
