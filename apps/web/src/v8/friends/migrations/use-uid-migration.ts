'use client'
import { uidAccountCandidates, uidDryRunBlockedReason } from '@/lib/uid-migration-input'
import { UID_IMPORT_COLUMNS } from '@/lib/csv-import-columns'

import { useStaffIdentity, useStaffRole, isOwnerRole, canManageRole } from '@/lib/staff-role'
import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'
import { effectiveStaffRole, readStaffIdentity, subscribeStaffIdentity } from '@/lib/staff-identity-state'
import { readPermissionSessionSnapshot, SESSION_SNAPSHOT_CHANGED } from '@/lib/session-snapshot'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import type { ApiResponse, LineAccount } from '@line-crm/shared'
import { api, ApiError, fetchApi, type UidMigrationItem, type UidMigrationRun } from '@/lib/api'
import { splitCsvRecords } from './friend-csv'
import { formatNumber } from '@/lib/format'
import { describeApiFailure, japaneseDetailOf } from '@/components/shared/api-error-message'

/*
 * ★V8 の写し（app/accounts/use-uid-migration.ts から。src/v8 は @/app を読めない）。
 * 判断・実行・切り戻しの口と失敗時の扱いは同じ。違いは最初に開く履歴を `?run=` で選べることだけ。
 */
/** API直前の本人・代理モード。理由の有無を認可に使わない。 */
function canWriteMigrationNow(ownerOnly = false): boolean {
  if (readPermissionSessionSnapshot()?.impersonation?.mode === 'read') return false
  const role = effectiveStaffRole(readStaffIdentity())
  return ownerOnly ? isOwnerRole(role) : canManageRole(role)
}

export const MIGRATION_STEPS: readonly string[] = ['移行の登録', '対応表の取込', '事前確認', '要確認の判断', '本移行と照合']

/**
 * CSVの1行を切り分ける。**引用符の中のカンマは区切りにしない。**
 * 単純な `split(',')` だと、名前やUIDにカンマが入った行で列がずれ、
 * 別人の結び付けになる。閉じていない引用符の行は `null` で返す。
 */
export function splitUidCsvLine(line: string): string[] | null {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') { current += '"'; index++ }
        else quoted = false
      } else current += char
    } else if (char === '"' && current === '') {
      quoted = true
    } else if (char === ',') {
      cells.push(current); current = ''
    } else current += char
  }
  if (quoted) return null
  cells.push(current)
  return cells
}

export function parseUidCsv(text: string) {
  const records = splitCsvRecords(text).filter((cells) => cells.some((cell) => cell.trim()))
  if (records.length < 2) return []
  const headers = records[0].map((value) => value.trim().toLowerCase())
  const oldIndex = headers.findIndex((value) => UID_IMPORT_COLUMNS.oldUid.some((name) => name === value))
  const newIndex = headers.findIndex((value) => UID_IMPORT_COLUMNS.newUid.some((name) => name === value))
  if (oldIndex < 0 || newIndex < 0) return []
  const rows: Array<{ oldUid: string; newUid: string | null; evidenceType: 'operator_csv' }> = []
  for (const cells of records.slice(1)) {
    // **列の数が合わない行は読み飛ばす。** ずれたまま結び付けると別人になる。
    if (cells.length !== headers.length) continue
    const oldUid = cells[oldIndex].trim()
    if (!oldUid) continue
    rows.push({ oldUid, newUid: cells[newIndex].trim() || null, evidenceType: 'operator_csv' as const })
  }
  return rows
}

/** 対応表の1ページの行数。口側の既定とそろえる。 */
export const ITEM_PAGE_SIZE = 20

/** 選んだ対応表の大きさを行に出すだけの短い表記。 */
export function formatMappingBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024) * 10) / 10}MB`
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

export const ITEM_CLASSIFICATIONS = ['auto', 'review', 'unmatched', 'conflict'] as const
export type ItemClassification = (typeof ITEM_CLASSIFICATIONS)[number]

/** ページ送り・絞り込み付きの対応表。口が `itemTotal` 等を返さない古い応答にも耐える。 */
export type UidMigrationDetail = UidMigrationRun & {
  itemTotal?: number
  itemLimit?: number
  itemOffset?: number
  unresolved?: number | null
  /** FRIEND-33: 実行前の確認画面に出す、判断別の全件数。 */
  decisionCounts?: { pending: number; link: number; create: number; exclude: number }
}

export const classLabel = { auto: '自動一致', review: '要確認', unmatched: '未一致', conflict: '競合' } as const
export const decisionLabel = { pending: '未判断', link: '結び付ける', create: '新規作成', exclude: '除外' } as const

/** 失敗応答の日本語だけを画面へ出す。内部文言・HTML は ApiError が捨てている。 */
function apiErrorMessage(error: unknown, fallback: string): string {
  // 「API error: 500」のような内部の文は出さない。画面で作った日本語の文はそのまま出す。
  if (error instanceof ApiError && !japaneseDetailOf(error)) return fallback
  if (error instanceof Error) return describeApiFailure(error, 'UID移行')
  return fallback
}

export type UidMigrationDecision = 'link' | 'create' | 'exclude'

/**
 * UID移行（/accounts?tab=migration）の状態と操作をまとめたフック。
 * 管理画面 の表示（migration.tsx）と V8 の表示（uid-migration-v8.tsx）の
 * 両方がこの口を使う。判断・実行・切り戻しの権限と失敗時の
 * 扱い（TECH-07/FRIEND-14/33/36）はここで一元管理する。
 */
export function useUidMigration(initialRunId: string | null = null) {
  const [accounts, setAccounts] = useState<LineAccount[]>([])
  const [runs, setRuns] = useState<UidMigrationRun[]>([])
  const [active, setActive] = useState<UidMigrationDetail | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [fromAccountId, setFromAccountId] = useState('')
  const [toAccountId, setToAccountId] = useState('')
  const [purpose, setPurpose] = useState('友だち情報と配信停止状態を新しいアカウントへ引き継ぐ')
  const [file, setFile] = useState<File | null>(null)
  const [mappings, setMappings] = useState<ReturnType<typeof parseUidCsv>>([])
  const fileSeq = useRef(0)
  const [mappingsFile, setMappingsFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  const [classification, setClassification] = useState<'' | ItemClassification>('')
  const [pendingOnly, setPendingOnly] = useState(false)
  /*
    FRIEND-16: 対応表の切替・ページ・絞り込みで応答が逆順に届いても
    最後に選んだ対象だけを表示するための世代番号。
  */
  const detailTicket = useRef(0)
  const [detailBusy, setDetailBusy] = useState(false)
  /* FRIEND-33/36: 実行・切り戻しの権限と作成者判定に使う自分自身の情報。 */
  const identity = useStaffIdentity()
  const staffRole = useStaffRole()
  const me = identity && staffRole ? { id: identity.id, role: staffRole } : null
  const canDecide = canWriteMigrationNow()
  const managerLockReason = usePermissionLockReason(canDecide, 'manager')
  const ownerLockReason = usePermissionLockReason(canWriteMigrationNow(true), 'owner')
  const accessEpoch = useRef(0), inputEpoch = useRef(0), writeLock = useRef(false), mounted = useRef(false)
  const current = useRef({ active, detailBusy, file, mappingsFile, mappings, fromAccountId, toAccountId, purpose })
  current.current = { active, detailBusy, file, mappingsFile, mappings, fromAccountId, toAccountId, purpose }
  const renderedDetailTicket = detailTicket.current
  const isCurrentRun = (id: string, ticket = renderedDetailTicket) => mounted.current && current.current.active?.id === id && detailTicket.current === ticket
  useEffect(() => {
    mounted.current = true
    const invalidate = () => { accessEpoch.current++ }
    const unsubscribe = subscribeStaffIdentity(invalidate)
    window.addEventListener(SESSION_SNAPSHOT_CHANGED, invalidate)
    return () => { mounted.current = false; invalidate(); unsubscribe(); window.removeEventListener(SESSION_SNAPSHOT_CHANGED, invalidate) }
  }, [])
  /* FRIEND-14: 「詳細を見る」は読み取り専用。判断はダイアログ内の明示操作だけ。 */
  const [detailItem, setDetailItem] = useState<UidMigrationItem | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [confirmExecute, setConfirmExecute] = useState(false)
  const [executeError, setExecuteError] = useState<string | null>(null)
  const [confirmRollback, setConfirmRollback] = useState(false)
  const [rollbackError, setRollbackError] = useState<string | null>(null)
  const [rollbackConflicts, setRollbackConflicts] = useState<Array<{ itemId: string; oldUid: string; reason: string }>>([])

  /**
   * 対応表を1ページずつ読む。**全件は読まない。**
   * 数千行の対応表でも応答が重くならない。
   *
   * FRIEND-16: 応答が遅れて届いても、最新の要求（ticket）の結果だけを
   * 反映する。履歴A→Bと選び直したあとにAの応答で対応表が戻らない。
   */
  const loadDetail = useCallback(async (
    runId: string,
    targetPage: number,
    targetClassification: '' | ItemClassification,
    targetPendingOnly: boolean,
  ): Promise<UidMigrationDetail | null> => {
    const ticket = ++detailTicket.current
    setDetailBusy(true)
    try {
      const params = new URLSearchParams({ limit: String(ITEM_PAGE_SIZE), offset: String(targetPage * ITEM_PAGE_SIZE) })
      if (targetClassification) params.set('classification', targetClassification)
      if (targetPendingOnly) params.set('pendingOnly', '1')
      const response = await fetchApi<ApiResponse<UidMigrationDetail>>(`/api/friends/migrations/${runId}?${params.toString()}`)
      if (ticket !== detailTicket.current) return null
      if (!response.success) {
        setMessage(response.error)
        return null
      }
      const detail = response.data
      if (!detail || detail.id !== runId || !detail.counts || typeof detail.counts !== 'object'
        || !(['total', 'auto', 'review', 'unmatched', 'conflict', 'applied', 'failed'] as const)
          .every((key) => Number.isInteger(detail.counts[key]) && detail.counts[key] >= 0)
        || (detail.items !== undefined && !Array.isArray(detail.items))
        || (detail.items?.some((item) => !item || typeof item !== 'object' || typeof item.id !== 'string'
          || typeof item.oldUid !== 'string' || (item.newUid !== null && typeof item.newUid !== 'string')
          || !ITEM_CLASSIFICATIONS.includes(item.classification)
          || !(['pending', 'link', 'create', 'exclude'] as const).includes(item.decision)) ?? false)) {
        setMessage('対応表を読み直せませんでした。移行履歴からもう一度選んでください。')
        return null
      }
      setActive(detail)
      return detail
    } catch {
      if (ticket === detailTicket.current) setMessage('対応表を読み直せませんでした。')
      return null
    } finally {
      if (ticket === detailTicket.current) setDetailBusy(false)
    }
  }, [])

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const [accountResponse, runResponse] = await Promise.all([api.lineAccounts.list(), api.friendMigrations.list()])
      if (!accountResponse.success || !runResponse.success) throw new Error('load failed')
      setAccounts(uidAccountCandidates(accountResponse.data))
      setRuns(runResponse.data)
      setFromAccountId((value) => value || accountResponse.data[0]?.id || '')
      setToAccountId((value) => accountResponse.data.some((account) => account.id === value) ? value : '')
      setPage(0)
      setClassification('')
      setPendingOnly(false)
      const first = runResponse.data.find((run) => run.id === initialRunId) ?? runResponse.data[0]
      if (first) {
        await loadDetail(first.id, 0, '', false)
      }
      setStatus('ready')
    } catch {
      setStatus('error')
    }

  }, [loadDetail, initialRunId])

  useEffect(() => { void load() }, [load])

  /*
    対応表CSVの受け口。選ぶ・落とすのどちらもここへ来る。
    受け付ける種類（accept）・読み方・読み飛ばしの文は変えない。
  */
  const onUidFile = async (files: File[]) => {
    if (!canWriteMigrationNow() || writeLock.current) return
    const permissionEpoch = accessEpoch.current
    const selected = files[0] ?? null
    const seq = ++fileSeq.current
    setMappings([])
    setMappingsFile(null)
    setFile(selected)
    if (!selected) { setMappings([]); return }
    let text: string
    try {
      text = await selected.text()
    } catch {
      if (mounted.current && seq === fileSeq.current && permissionEpoch === accessEpoch.current && canWriteMigrationNow()) {
        setMessage('CSVを読み込めませんでした。ファイルを確認して、もう一度選んでください。')
      }
      return
    }
    if (!mounted.current) return
    if (seq !== fileSeq.current) return
    if (permissionEpoch !== accessEpoch.current || !canWriteMigrationNow()) {
      setMessage('権限が変わったため、CSVの読み込みを中止しました。')
      return
    }
    const parsed = parseUidCsv(text)
    setMappings(parsed)
    setMappingsFile(selected)
    const dataLines = Math.max(text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim()).length - 1, 0)
    setMessage(dataLines > parsed.length
      ? `対応表のうち ${dataLines - parsed.length} 行は読み取れなかったため除いています。列の数と引用符を確認してください。`
      : null)
  }

  const dryRunBlockedReason = uidDryRunBlockedReason({ fromAccountId, toAccountId, purpose, file, mappingsFile, mappings })

  const createDryRun = async () => {
    if (!mounted.current || !canWriteMigrationNow() || busy || writeLock.current) return
    if (dryRunBlockedReason || !file) {
      setMessage(dryRunBlockedReason)
      return
    }
    const permissionEpoch = accessEpoch.current, selectionEpoch = inputEpoch.current
    writeLock.current = true
    setBusy(true)
    setMessage(null)
    try {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(await file.text()))
      const sourceChecksum = Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, '0')).join('')
      const latest = current.current
      if (!mounted.current) return
      if (!canWriteMigrationNow() || permissionEpoch !== accessEpoch.current) {
        setMessage('権限が変わったため、テスト移行を中止しました。')
        return
      }
      if (selectionEpoch !== inputEpoch.current || latest.file !== file || latest.mappingsFile !== file || latest.mappings !== mappings
        || latest.fromAccountId !== fromAccountId || latest.toAccountId !== toAccountId || latest.purpose !== purpose) {
        setMessage('入力が変わったため、テスト移行を中止しました。内容を確認してから実行してください。')
        return
      }
      const response = await api.friendMigrations.dryRun({
        fromAccountId, toAccountId, purpose: purpose.trim(), sourceFilename: file.name, sourceChecksum, mappings,
      })
      if (!response.success) throw new Error(response.error)
      setPage(0)
      setClassification('')
      setPendingOnly(false)
      const detail = await loadDetail(response.data.id, 0, '', false)
      if (!detail) throw new Error('結果を読み直せませんでした。')
      setRuns((current) => [{ ...detail, items: undefined }, ...current.filter((run) => run.id !== detail.id)])
      setMessage('テスト移行が完了しました。実データはまだ変更していません。')
    } catch (error) {
      setMessage(apiErrorMessage(error, 'テスト移行を実行できませんでした。'))
    } finally {
      writeLock.current = false
      setBusy(false)
    }
  }

  const decideChecked = async (item: UidMigrationItem, decision: UidMigrationDecision, ticket: number, onAcknowledged?: () => void) => {
    if (!canWriteMigrationNow() || !active || !isCurrentRun(active.id, ticket) || writeLock.current || busy || current.current.detailBusy || !['review', 'ready', 'failed'].includes(current.current.active!.status)) return
    writeLock.current = true
    setBusy(true)
    setMessage(null)
    setDetailError(null)
    try {
      const response = await api.friendMigrations.decide(active.id, item.id, decision)
      if (!response.success) throw new ApiError(400, response.error)
      onAcknowledged?.()
      if (detailTicket.current !== ticket || current.current.active?.id !== active.id) return
      let reading = loadDetail(active.id, page, classification, pendingOnly)
      let ownTicket = detailTicket.current
      let detail = await reading
      // 絞り込みで今のページが空になったら1ページ戻る。
      if (detail && (detail.items?.length ?? 0) === 0 && page > 0) {
        setPage(page - 1)
        reading = loadDetail(active.id, page - 1, classification, pendingOnly)
        ownTicket = detailTicket.current
        detail = await reading
      }
      if (!detail || detailTicket.current !== ownTicket) return
      current.current = { ...current.current, active: detail, detailBusy: false }
      // 詳細ダイアログを開いたままの判断は、中の表示も追従させる。
      setDetailItem((current) => (current && current.id === item.id ? { ...current, decision } : current))
      return ownTicket
    } catch (error) {
      /*
        TECH-07: 通信断・タイムアウト（ApiError ではない例外）は
        「サーバーが拒否した」のか「応答だけ失われた」のか分からない。
        確定失敗と結果不明を分け、結果不明では対応表を読み直して
        実際の判断結果を表示する。無条件の再送はしない。
      */
      const text = error instanceof ApiError
        ? apiErrorMessage(error, '判断を保存できませんでした。')
        : '応答を確認できませんでした。判断が保存されている可能性があります。対応表を読み直してから確認してください。'
      setMessage(text)
      setDetailError(text)
      if (!(error instanceof ApiError) && detailTicket.current === ticket && current.current.active?.id === active.id) void loadDetail(active.id, page, classification, pendingOnly)
    } finally {
      writeLock.current = false
      setBusy(false)
    }
  }

  const decide = (item: UidMigrationItem, decision: UidMigrationDecision) => decideChecked(item, decision, renderedDetailTicket)

  /** 一括判断は自分の再読取で進んだ世代だけを引き継ぎ、外部の画面切替では止める。 */
  const decideMany = async (items: UidMigrationItem[], decision: UidMigrationDecision, acknowledged = new Set<string>()) => {
    const permissionEpoch = accessEpoch.current
    let ticket = renderedDetailTicket
    for (const [index, item] of items.entries()) {
      if (!mounted.current) return
      if (acknowledged.has(item.id)) continue
      if (permissionEpoch !== accessEpoch.current) {
        setMessage(`${index + 1}件目で止めました。理由：権限が変わったため、残りの判断を中止しました。`)
        return false
      }
      const latest = current.current.active?.items?.find(row => row.id === item.id)
      if (!latest || latest.decision !== 'pending') {
        if (latest?.decision === decision) { acknowledged.add(item.id); continue }
        setMessage('表示内容が変わりました。閉じて対応表を確認してください。')
        return false
      }
      const next = await decideChecked(item, decision, ticket, () => acknowledged.add(item.id))
      if (next === undefined) {
        if (mounted.current) setMessage(reason => `${index + 1}件目で止めました。理由：${reason ?? '表示内容または操作できる状態が変わりました。対応表を確認してください。'}`)
        return false
      }
      ticket = next
    }
    return true
  }

  // 口が返す未判断数があればそれを使い、なければ表示中の行で数える。
  const unresolved = active?.unresolved ?? active?.items?.filter((item) => item.decision === 'pending').length ?? null

  /*
    FRIEND-33: 「本移行を実行」は確認画面を開くだけ。実際の実行は
    ダイアログの確定ボタンだけが行う（入口クリック時の書込みは0回）。
    作成者本人・owner以外はここで理由を示し、確定ボタンを出さない
    （サーバー側でも 409/403 で拒否する）。
  */
  const canRunExecute = Boolean(me && canWriteMigrationNow(true) && me.id !== active?.createdBy)
  const canRunRollback = Boolean(me && canWriteMigrationNow(true))

  const execute = async () => {
    if (!canWriteMigrationNow(true) || !active || !isCurrentRun(active.id) || current.current.active!.createdBy === readStaffIdentity()?.id
      || writeLock.current || busy || current.current.detailBusy || !['ready', 'failed'].includes(current.current.active!.status) || unresolved !== 0) return
    writeLock.current = true
    setBusy(true)
    setExecuteError(null)
    try {
      const response = await api.friendMigrations.execute(active.id)
      if (!response.success) throw new ApiError(400, response.error)
      const detail = await loadDetail(active.id, page, classification, pendingOnly)
      const failed = response.data.counts.failed
      const applied = response.data.counts.applied
      setMessage(
        failed > 0
          ? `本移行で ${formatNumber(applied)} 件を反映しましたが、${formatNumber(failed)} 件が失敗しました。失敗した行を確認して再実行するか、反映済みの分だけ切り戻せます。`
          : '本移行と照合が完了しました。必要な場合はこの履歴から切り戻せます。',
      )
      if (detail) setRuns((current) => current.map((run) => (run.id === detail.id ? { ...detail, items: undefined } : run)))
      setConfirmExecute(false)
    } catch (error) {
      /*
        TECH-07/FRIEND-33: 通信断・タイムアウトは「応答だけ失われた」
        可能性がある（サーバーでは実行が完了していることがある）。
        確定失敗（サーバーの拒否応答）と分け、結果不明では履歴を
        読み直して実際の状態を見せる。再実行はサーバー側が
        executing/completed で止めるので二重反映にはならない。
      */
      if (error instanceof ApiError) {
        /*
         * R398: 500でも「実データはまだ変更していません」と残さない。
         * 一部反映のまま失敗することがあるので、必ず履歴を読み直して
         * 実際の反映件数を見せる。再取得できなければ結果未確認にする。
         * POSTの再送はしない（loadDetailはGETだけ）。
         */
        const detail = await loadDetail(active.id, page, classification, pendingOnly)
        if (detail) {
          setRuns((current) => current.map((run) => (run.id === detail.id ? { ...detail, items: undefined } : run)))
          const applied = detail.counts.applied
          setExecuteError(applied > 0 || detail.status === 'failed' || detail.status === 'completed'
            ? `本移行で ${formatNumber(applied)} 件が反映されています。失敗した行を確認して再実行するか、反映済みの分だけ切り戻せます。`
            : apiErrorMessage(error, '本移行を実行できませんでした。'))
        } else {
          setExecuteError('実行結果を確認できませんでした。履歴を読み直して状態を確認してください。')
        }
      } else {
        setExecuteError('応答を確認できませんでした。サーバーでは実行が完了している可能性があります。履歴を読み直して状態を確認してから、必要な場合だけ再実行してください。')
        void loadDetail(active.id, page, classification, pendingOnly)
      }
    } finally {
      writeLock.current = false
      setBusy(false)
    }
  }

  /*
    FRIEND-36: 完了・一部失敗の履歴から切り戻しへ進む。確認ダイアログで
    対象件数・制約・権限を示し、競合があればサーバーの409をそのまま表示する。
  */
  const rollback = async () => {
    if (!canWriteMigrationNow(true) || !active || !isCurrentRun(active.id) || writeLock.current || busy || current.current.detailBusy
      || !(current.current.active!.status === 'completed' || current.current.active!.status === 'failed' && current.current.active!.counts.applied > 0)) return
    writeLock.current = true
    setBusy(true)
    setRollbackError(null)
    setRollbackConflicts([])
    try {
      const response = await api.friendMigrations.rollback(active.id)
      if (!response.success) throw new ApiError(400, response.error)
      setPage(0)
      setClassification('')
      setPendingOnly(false)
      const detail = await loadDetail(active.id, 0, '', false)
      const rolledBack = (response.data as UidMigrationRun & { rolledBack?: number }).rolledBack
      setMessage(typeof rolledBack === 'number'
        ? `切り戻しが完了しました（${formatNumber(rolledBack)} 件を移行前の状態に戻しました）。`
        : '切り戻しが完了しました。')
      if (detail) setRuns((current) => current.map((run) => (run.id === detail.id ? { ...detail, items: undefined } : run)))
      setConfirmRollback(false)
    } catch (error) {
      // TECH-07: 応答喪失と確定失敗を分ける（execute と同じ考え方）。
      if (error instanceof ApiError) {
        setRollbackError(apiErrorMessage(error, '切り戻しを実行できませんでした。'))
        const data = error.data
        const conflicts = data && typeof data === 'object' && 'conflicts' in data
          ? (data as { conflicts?: Array<{ itemId: string; oldUid: string; reason: string }> }).conflicts
          : undefined
        setRollbackConflicts(Array.isArray(conflicts) ? conflicts : [])
      } else {
        setRollbackError('応答を確認できませんでした。切り戻しが完了している可能性があります。履歴を読み直して状態を確認してください。')
        void loadDetail(active.id, 0, '', false)
      }
    } finally {
      writeLock.current = false
      setBusy(false)
    }
  }

  /** 履歴の行を選んだとき：絞り込みを戻して先頭ページから読み直す。 */
  const selectRun = (runId: string) => {
    setPage(0)
    setClassification('')
    setPendingOnly(false)
    void loadDetail(runId, 0, '', false)
  }

  const onFilterChange = (runId: string, nextClassification: '' | ItemClassification, nextPendingOnly: boolean) => {
    setClassification(nextClassification)
    setPendingOnly(nextPendingOnly)
    setPage(0)
    void loadDetail(runId, 0, nextClassification, nextPendingOnly)
  }

  const onPageChange = (runId: string, nextPage: number) => {
    setPage(nextPage)
    void loadDetail(runId, nextPage, classification, pendingOnly)
  }

  return {
    accounts,
    runs,
    active,
    status,
    fromAccountId,
    setFromAccountId: (next: SetStateAction<string>) => { if (canWriteMigrationNow() && !writeLock.current) { inputEpoch.current++; setFromAccountId(next) } },
    toAccountId,
    setToAccountId: (next: SetStateAction<string>) => { if (canWriteMigrationNow() && !writeLock.current) { inputEpoch.current++; setToAccountId(next) } },
    purpose,
    setPurpose: (next: SetStateAction<string>) => { if (canWriteMigrationNow() && !writeLock.current) { inputEpoch.current++; setPurpose(next) } },
    file,
    setFile: (next: SetStateAction<File | null>) => { if (canWriteMigrationNow() && !writeLock.current) { inputEpoch.current++; fileSeq.current++; setMappingsFile(null); setFile(next) } },
    mappings,
    setMappings: (next: SetStateAction<ReturnType<typeof parseUidCsv>>) => { if (canWriteMigrationNow() && !writeLock.current) { inputEpoch.current++; setMappings(next) } },
    busy,
    message,
    setMessage,
    page,
    setPage,
    classification,
    setClassification,
    pendingOnly,
    setPendingOnly,
    detailBusy,
    me,
    canDecide,
    managerLockReason: me ? managerLockReason : undefined,
    ownerLockReason: me ? ownerLockReason : undefined,
    detailItem,
    setDetailItem,
    detailError,
    setDetailError,
    confirmExecute,
    setConfirmExecute,
    executeError,
    setExecuteError,
    confirmRollback,
    setConfirmRollback,
    rollbackError,
    setRollbackError,
    rollbackConflicts,
    setRollbackConflicts,
    load,
    loadDetail,
    onUidFile,
    createDryRun,
    dryRunBlockedReason,
    decide,
    decideMany,
    clearDecisionError: () => { setMessage(null); setDetailError(null) },
    unresolved,
    canRunExecute,
    canRunRollback,
    execute,
    rollback,
    selectRun,
    onFilterChange,
    onPageChange,
  }
}

export type UidMigrationState = ReturnType<typeof useUidMigration>
