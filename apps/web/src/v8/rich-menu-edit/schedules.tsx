'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import Dialog from '@/components/shared/dialog'
import Notice from '@/components/shared/notice'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { formatDateTime } from '@/lib/format'
import styles from '@/app/rich-menus/new/create-v8.module.css'

type Schedule = {
  id: string; mode: 'scheduled' | 'period'; startsAt: string; endsAt: string | null
  restoreGroupId: string | null; restoreDefaultState: 'captured' | 'no_default' | null
  status: string; attemptCount: number; nextRetryAt: string | null; lastErrorCode: string | null; createdAt: string
}
const STATUS: Record<string, string> = {
  scheduled: '予約中', publishing: '公開処理中', published: '期間公開中', restoring: '復元処理中',
  completed: '完了', cancelled: '取消済み', failed: '失敗・要対応',
}

/** 公開前の予約と、期間終了時の戻し先を確認する。 */
export default function RichMenuSchedules({ groupId, canOperate, restoreMenus }: {
  groupId: string; canOperate: boolean; restoreMenus: Array<{ id: string; name: string }>
}) {
  const [open, setOpen] = useState(false)
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const cancelling = useRef(false)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const request = ++generation.current
    try {
      const res = await api.richMenuGroups.listSchedules(groupId)
      if (request !== generation.current) return
      if (!res.success || !Array.isArray(res.data)) throw new Error('schedule response')
      setSchedules(res.data)
      setError('')
    } catch {
      if (request !== generation.current) return
      setError('公開予約の一覧を読み込めませんでした。時間をおいて、もう一度お試しください。')
    }
  }, [groupId])
  useEffect(() => {
    if (open) void load()
    return () => { generation.current += 1 }
  }, [open, load])

  async function cancelSchedule(id: string) {
    if (!canOperate || cancelling.current) return
    cancelling.current = true
    setCancellingId(id)
    setNotice('')
    const request = generation.current
    try {
      const res = await api.richMenuGroups.cancelSchedule(groupId, id)
      if (request !== generation.current) return
      if (!res.success) throw new Error('cancel schedule')
      setNotice('予約を取り消しました。')
    } catch {
      if (request !== generation.current) return
      setNotice('予約を取り消せませんでした。実行が始まっている可能性があります。')
    } finally {
      if (request === generation.current) await load()
      cancelling.current = false
      setCancellingId(null)
    }
  }

  function restoreText(item: Schedule) {
    if (item.mode !== 'period') return ''
    if (item.restoreGroupId) return `戻し先 ${restoreMenus.find(menu => menu.id === item.restoreGroupId)?.name ?? item.restoreGroupId}`
    if (item.restoreDefaultState === 'captured') return '戻し先確定済み（切替前の表示へ戻す）'
    if (item.restoreDefaultState === 'no_default') return '戻し先なし（終了時に表示を外す）'
    return '戻し先は実行開始時に確定'
  }

  return <>
    <Button type="button" variant="text" size="inline" onClick={() => setOpen(true)}>公開予約の一覧</Button>
    <Dialog open={open} title="公開予約の一覧" size="large" cancelLabel="閉じる" onCancel={() => { if (!cancelling.current) setOpen(false) }}>
      <div className={styles.stack}>
        {notice ? <Notice tone={notice === '予約を取り消しました。' ? 'success' : 'warn'} message={notice} /> : null}
        {error ? <Notice tone="danger" message={error} action={<Button type="button" variant="text" size="inline" onClick={() => void load()}>再試行</Button>} />
          : schedules === null ? <p className={styles.cardNote} role="status">読み込み中…</p>
            : schedules.length === 0 ? <p className={styles.cardNote}>まだ公開予約はありません。日時を決めて予約するとここに出ます。</p>
              : <DataTable label="公開予約の一覧">
                <thead><TableHeadRow><Th>開始・終了</Th><Th>状態・戻し先</Th><Th>操作</Th></TableHeadRow></thead>
                <tbody>{schedules.map(item => <Tr key={item.id}>
                  <Td>{formatDateTime(item.startsAt)}{item.mode === 'period' && item.endsAt ? ` 〜 ${formatDateTime(item.endsAt)}` : ''}</Td>
                  <Td><p title={item.status === 'failed' ? item.lastErrorCode?.slice(0, 40) : undefined}>{STATUS[item.status] ?? '状態を確認しています'}</p>
                    {restoreText(item) ? <p className={styles.cardNote}>{restoreText(item)}</p> : null}
                    {item.nextRetryAt ? <p className={styles.cardNote}>次回 {formatDateTime(item.nextRetryAt)}</p> : null}</Td>
                  <Td>{item.status === 'scheduled' ? <PermissionGatedButton allowed={canOperate} type="button" size="compact" disabled={cancellingId !== null} busy={cancellingId === item.id} busyLabel="取消中…" onClick={() => void cancelSchedule(item.id)}>予約を取り消す</PermissionGatedButton> : null}</Td>
                </Tr>)}</tbody>
              </DataTable>}
      </div>
    </Dialog>
  </>
}
