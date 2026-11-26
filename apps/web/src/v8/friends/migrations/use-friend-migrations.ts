'use client'

/*
 * ★V8 の写し（app/friends/migrations/use-friend-migrations.ts から。src/v8 は @/app を読めない）。
 * 手順・API・権限の言い分けは同じ。
 *
 * CSV で書き出す・取り込む（`friends/migrations/page.tsx` から移した
 * ロジックの正本）。管理画面 の画面と ★V8 の画面（`migrations-v8.tsx`）が
 * 同じ口を使う——確認だけ→反映の順序、二重取り込みの指紋、
 * 権限の言い分けはここでだけ変える。
 */
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { useCallback, useEffect, useState, useRef } from 'react'
import type { LineAccount } from '@line-crm/shared'
import { api, ApiError, downloadApiFile, type FriendMigrationJob } from '@/lib/api'
import { describeApiFailure, japaneseDetailOf } from '@/components/shared/api-error-message'
import { parseFriendCsv, type FriendImportRow } from './friend-csv'

export type ImportSummary = { add: number; update: number; unchanged: number; conflict: number; error: number }

export const JOB_STATUS_LABELS: Record<string, string> = Object.assign(Object.create(null), {
  completed: '反映ずみ', previewed: '確認まで', expired: '期限切れ', failed: '失敗',
})

// 取り込みファイルの上限（#496-22）。全文を画面のメモリへ読むため、
// 大きすぎるファイルは固まる前に断る。5000行の取り込み上限に対し十分な大きさ。
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024

/** 選んだCSVの大きさを行に出すだけの短い表記。 */
export function formatImportBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024) * 10) / 10}MB`
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

/*
 * M016：操作の失敗は原文（`API error: NNN`・英語生文）のまま出さない。
 * 安全なサーバ文があればそのまま、無ければ共通の状態別案内へ渡す。
 */
export const MANAGE_FORBIDDEN = '書き出し・取り込みの操作はオーナーか管理者だけができます。必要なときはオーナーか管理者の方に操作してもらってください。'

export function useFriendMigrations() {
  const [accounts, setAccounts] = useState<LineAccount[]>([])
  const [accountId, setAccountId] = useState('')
  const [jobs, setJobs] = useState<FriendMigrationJob[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading')
  // M016：書き出し・取り込みは owner/admin 専用。押せる人かで案内を変える目安。
  const role = useStaffRole()
  // R114: タグ・友だち情報と対応情報の書き出しは未接続のため、初期選択は
  // 実際に出る基本だけにする。選べるのに出ない状態を作らない。
  const [columns, setColumns] = useState<Array<'basic' | 'tags_fields' | 'support'>>(['basic'])
  // Shift_JIS書き出しはAPI未対応(#496-5)。対応までUTF-8固定で、選択肢は出さない。
  const encoding = 'utf-8' as const
  const [exportResult, setExportResult] = useState<{ id: string; rowCount: number | null; downloadUrl: string } | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [rows, setRows] = useState<FriendImportRow[]>([])
  const [importId, setImportId] = useState<string | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const downloading = useRef(false)
  const [downloadId, setDownloadId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const [accountResponse, jobResponse] = await Promise.all([api.lineAccounts.list(), api.friendMigrations.jobs()])
      if (!accountResponse.success || !jobResponse.success) throw new Error('load failed')
      setAccounts(accountResponse.data)
      setAccountId((value) => value || accountResponse.data[0]?.id || '')
      setJobs(jobResponse.data)
      setStatus('ready')
    } catch (caught) {
      // M016：読み込み 403 は権限不足として分ける（押しても直らない再試行は出さない）。
      setStatus(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : 'error')
    }
  }, [])

  useEffect(() => {
    void load()
    try {
    } catch {
      // ストレージが使えなくても画面は出せる
    }
  }, [load])

  const operationFailureMessage = (caught: unknown, action: string): string =>
    japaneseDetailOf(caught) || describeApiFailure(caught, action, { forbidden: MANAGE_FORBIDDEN })
  // 役割が分かっていて owner/admin でないときだけ、ボタンの近くに理由を出す。
  const managerReason = usePermissionLockReason(canManageRole(role), 'manager')
  const manageLocked = !canManageRole(role) || Boolean(managerReason)

  const toggleColumn = (column: 'basic' | 'tags_fields' | 'support') => {
    setColumns((current) => current.includes(column) ? current.filter((value) => value !== column) : [...current, column])
  }

  const createExport = async () => {
    if (manageLocked || busy) return
    if (!accountId || columns.length === 0) { setMessage('対象と書き出す項目を選んでください。'); return }
    setBusy(true); setMessage(null)
    try {
      const response = await api.friendMigrations.createExport({ accountId, columns, encoding })
      if (!response.success) { setMessage(response.error); return }
      setExportResult(response.data)
      setMessage('書き出しを作りました。ダウンロードできる期間は7日です。')
      await load()
    } catch (error) { setMessage(operationFailureMessage(error, '書き出し')) }
    finally { setBusy(false) }
  }

  const downloadExport = async (id: string) => {
    if (manageLocked || busy || downloading.current) return
    downloading.current = true
    setDownloadId(id)
    setBusy(true); setMessage(null)
    try {
      await downloadApiFile(`/api/friends/exports/${encodeURIComponent(id)}/download`, '友だち.csv')
    } catch (error) {
      setMessage(operationFailureMessage(error, 'CSVの保存'))
    } finally {
      downloading.current = false
      setDownloadId(null)
      setBusy(false)
    }
  }

  const onPickFile = async (selected: File | null) => {
    setSummary(null)
    if (!selected) { setFile(null); setRows([]); return }
    // 元バイトで重複判定の指紋を取る（再符号化した文の指紋では意味が薄れる、#496-22）。
    // UTF-8以外（Shift_JIS等）は文字化けするため、UTF-8の案内とセットで断る。
    if (selected.size > MAX_IMPORT_FILE_BYTES) {
      setFile(null); setRows([])
      setMessage('ファイルが大きすぎます（上限5MB）。分割するか、UTF-8で保存し直してください。')
      return
    }
    setFile(selected)
    try {
      setRows(parseFriendCsv(await selected.text()))
    } catch {
      setRows([])
      setMessage('CSVを読めませんでした。UTF-8のCSVを選んでください。')
    }
  }

  const previewImport = async () => {
    if (manageLocked || busy) return
    if (!accountId || !file || rows.length === 0) { setMessage('このシステムから書き出したCSVを選んでください。'); return }
    setBusy(true); setMessage(null)
    try {
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
      const sourceChecksum = Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('')
      const response = await api.friendMigrations.previewImport({ accountId, sourceFilename: file.name, sourceChecksum, rows })
      if (!response.success) { setMessage(response.error); return }
      setImportId(response.data.id); setSummary(response.data.result.summary)
      // 初めての確認は、結果の箱の「まだ友だち情報は変えていません」で伝わるので帯を重ねない。
      setMessage(response.data.duplicate ? '同じファイルの確認結果を表示しました。二重には反映しません。' : null)
      await load()
    } catch (error) { setMessage(operationFailureMessage(error, '確認')) }
    finally { setBusy(false) }
  }

  /*
   * M015：反映の失敗で画面が固まっていた（try/catch が無く、throw が
   * 未捕捉になり busy が戻らなかった）。失敗文を出して busy を戻し、
   * 履歴を読み直す。
   */
  const executeImport = async () => {
    if (manageLocked || !importId || busy) return
    setBusy(true)
    try {
      const response = await api.friendMigrations.executeImport(importId)
      setMessage(response.success ? `${response.data.applied ?? 0} 件を反映しました。` : response.error)
    } catch (error) {
      setMessage(operationFailureMessage(error, '反映'))
    } finally {
      setBusy(false)
    }
    await load()
  }

  /* 「取り込みをやめる」：確認した内容を捨てて、選び直せる状態へ戻す。 */
  const cancelImport = () => {
    setFile(null)
    setRows([])
    setImportId(null)
    setSummary(null)
  }

  return {
    accounts,
    accountId,
    setAccountId,
    jobs,
    status,
    role,
    columns,
    encoding,
    exportResult,
    file,
    rows,
    importId,
    summary,
    busy,
    message,
    manageLocked,
    load,
    toggleColumn,
    createExport,
    downloadExport,
    downloadId,
    onPickFile,
    previewImport,
    executeImport,
    cancelImport,
  }
}
