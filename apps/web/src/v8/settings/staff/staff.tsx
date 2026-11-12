'use client'
import { loadStaffIdentity, canManageRole, useStaffRole, useStaffIdentity } from '@/lib/staff-role'
import SelfSecurity from './self-security'
import MfaPolicy from './mfa-policy'
import { logoutAndGoToLogin } from '@/lib/logout'
import TotpQr from '@/components/shared/totp-qr'

import { formatDate as polishFormatDate, formatDateTime } from '@/lib/format';
import ListToolbar from '@/components/shared/list-toolbar'
import SegmentedControl from '@/components/shared/segmented'
import { useListUrlValue } from '@/components/shared/list-url-state';
import { avatarInitials } from '@/components/shared/avatar';
import { notifySaved, notifyToast } from '@/components/shared/toast';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { UserPlus } from 'lucide-react';

import Link from '@/components/shared/list-navigation'
import { useMergedTab } from '@/components/layout/merged-tabs';
import LoginAudit from '@/components/staff/login-audit'
import Button from '@/components/shared/button'
import { GridTable, GridHeadRow, GridRow, GridCell, GridNameCell } from '@/components/shared/grid-table';
import { Field } from '@/components/shared/form-controls';
import { TextField } from '@/components/shared/text-field';

import { Tabs } from '@/components/shared/tabs';
import Pagination from '@/components/shared/pagination'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import Disclosure from '@/components/shared/disclosure'
import Notice from '@/components/shared/notice'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest as SharedStepUpRequest } from '@/components/step-up-prompt';
import NotificationSwitch from '@/components/ui/notification-switch'
import { usePageTitle } from '@/components/shell/page-chrome';
import { PageFrame, PageHeading } from '@/components/templates/page-frame';
import SettingsInnerNav from '@/components/layout/settings-inner-nav'
import { type ActionMenuItem } from '@/components/shared/action-menu';
import { RowMenu } from '@/components/shared/row-actions';
import styles from './staff.module.css'
import StatusBadge from '@/components/shared/status-badge'
import { useAccount } from '@/contexts/account-context';
import { ApiError, api, describeSaveFailure, fetchApi, type AccessRoleBundle, type AccessRoleItem, type AccessUserItem, type AccessUserSummary, type AuditEventItem } from '@/lib/api';
import type { StaffMember } from '@line-crm/shared';
import { SCOPE_ITEMS, BUNDLE_PRESETS, BROADCAST_EDIT_OPERATION_KEYS, type FeatureAccessLevel, type ScopeLevels } from '@line-crm/shared';
import { csvCell } from '@/lib/presentation';
import { qrToDataURL } from '@/lib/qr-image';
import { isActiveAdministrator, matchStaffMember, staffActionPolicy } from './staff-actions';
import { applyScopeRowChange, findPartialScopeRows, restoreSavedLevels, scopePiiToEmailMask } from './staff-scope-draft';
import { CONVERSION_APPROVAL_EDIT_KEY, PERMISSION_LABELS, normalizeStaffPermissionKeys, permissionLabel, toggleStaffPermissionKey } from './permission-labels';
import OtpInput, { otpFailureMessage } from '@/components/shared/otp-input';
import { describeApiFailure, withPermissionFailure } from '@/components/shared/api-error-message';
import { csvFileName } from '@/lib/csv-file-name';
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors';
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select';
import EditorSurface from '@/components/shared/editor-surface'
import { PageFooter } from '@/components/templates/page-footer'
import ListState from '@/components/shared/list-state'
import { useSearchParams } from 'next/navigation';
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { formatNumber } from '@/lib/format'

import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation';
import { ToggleField } from '@/components/shared/toggle'

type Channel = { email: boolean; line: boolean }
type CopyableAccessUser = AccessUserItem & { roleBundle: Exclude<AccessRoleBundle, 'custom'> }
const ROLE_LABEL: Record<string, string> = { owner: 'オーナー', admin: '管理者', staff: 'スタッフ', viewer: '閲覧のみ' }
const ACCESS_ROLE_LABEL: Record<AccessRoleBundle, string> = {
  administrator: '管理者',
  operations: 'スタッフ',
  reception: '受付',
  view_only: '閲覧のみ',
  custom: '個別設定',
}
const EMPTY_ACCESS_SUMMARY: AccessUserSummary = {
  active: 0,
  invited: 0,
  expiredInvitations: 0,
  unused90Days: 0,
  mfaEnabled: 0,
  mfaRate: null,
  roleCounts: { administrator: 0, operations: 0, reception: 0, view_only: 0, custom: 0 },
}
const NOTIFICATIONS = [
  ['operations', '運用状態のエラー', '異常を検知したとき'], ['emergency', '緊急停止・復旧', '停止または復旧したとき'],
  ['security', 'ログイン・権限変更', 'ログインや権限が変わったとき'], ['updates', 'システム更新', '更新が完了したとき'],
] as const
/*
 * 編集窓で付け外しできる顔ぶれはこの21件のまま。追加画面の分類表とは
 * 載せる顔ぶれが違うが、表示名は `permission-labels.ts` が正本。
 * 載せる顔ぶれ自体をそろえるかは仕様判断が要るので変えない(#581)。
 * 操作権限（成果の承認）は別枠で1件だけ足す。表示21件には数えない。
 */
const EDIT_PERMISSION_PATHS = ['/', '/chats', '/friends', '/tags', '/scenarios', '/broadcasts', '/reminders', '/auto-replies', '/templates', '/rich-menus', '/form-submissions', '/contents/vars', '/contents', '/analytics', '/automations', '/webhooks', '/booking/bookings', '/ec-commerce', '/line-notifications', '/nen-campaigns', '/nen-members'] as const
const PERMISSIONS: Array<readonly [string, string]> = EDIT_PERMISSION_PATHS.map((path) => [path, PERMISSION_LABELS[path]] as const)

function messageOf(error: unknown): string { return describeApiFailure(error, '保存') }

function auditActionLabel(action: string): string {
  const normalized = action.toLowerCase()
  if (normalized === 'auth.login' || normalized === 'login') return 'ログイン'
  if (normalized === 'auth.logout' || normalized === 'logout') return 'ログアウト'
  if (normalized.includes('delete')) return '削除'
  if (normalized.includes('send') || normalized.includes('publish')) return '配信'
  if (normalized.includes('update') || normalized.includes('change')) return '設定変更'
  return '操作記録'
}
/** 二段階認証の QR の色（globals.css の --tpl-sa-qr-*。読めないときは墨と白）。 */
function qrColors(): { dark: string; light: string } {
  const css = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null
  return {
    dark: css?.getPropertyValue('--tpl-sa-qr-dark').trim() || 'black',
    light: css?.getPropertyValue('--tpl-sa-qr-light').trim() || 'white',
  }
}
function formatStaffDate(value: string | undefined): string { if (!value) return 'まだ入っていません'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '日時を読み込めませんでした' : formatDateTime(date) }
/* 一覧の StaffMember には招待期限が載っていない。再送口の返事を読むための形。 */
type StaffMemberWithInvite = StaffMember & { inviteExpiresAt?: string | null }
function formatInviteExpiry(value: string | null | undefined): string {
  if (!value) return '期限を読み込めませんでした'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '期限を読み込めませんでした'
  const text = formatDateTime(date)
  return date.getTime() < Date.now() ? `期限切れ（${text}まででした）` : `${text}まで`
}
function downloadAuditCsv(rows: AuditEventItem[]): void {
  const body = [
    ['日時', 'ユーザー', '操作', '対象', '結果', '接続元'],
    ...rows.map((row) => [
      row.createdAt,
      row.actor.name ?? '',
      auditActionLabel(row.action),
      [row.target?.kind, row.target?.id].filter(Boolean).join(' / '),
      row.result,
      [row.ipPrefix, row.deviceFamily].filter(Boolean).join(' / '),
    ]),
  ].map((line) => line.map(csvCell).join(',')).join('\r\n')
  const url = URL.createObjectURL(new Blob([`\uFEFF${body}`], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = csvFileName("権限の履歴")
  anchor.click()
  URL.revokeObjectURL(url)
}

function accessScopeLabel(user: AccessUserItem, accountNames: Record<string, string>): string {
  if (user.accountScope.type === 'all') return 'すべてのLINEアカウント'
  const ids = new Set(user.accountScope.lineAccountIds)
  if (user.accountScope.assignedLineAccountId) ids.add(user.accountScope.assignedLineAccountId)
  const names = [...ids].map((id) => accountNames[id] ?? '不明なLINEアカウント')
  return names.length > 0 ? names.join('、') : '担当アカウント未設定'
}

function Modal({ children, onClose, wide = false, title }: { children: React.ReactNode; onClose: () => void; wide?: boolean; title: string }) {
  return <Dialog open title={title} onCancel={onClose} size={wide ? 'large' : 'medium'}>{children}</Dialog>
}

function LoginHistoryNote({ count, loading, failed = false }: { count: number | null; loading: boolean; failed?: boolean }) {
  if (loading) return <p className="text-xs text-ink-secondary">ログイン履歴を確認中…</p>
  if (failed) return <p className="text-xs text-warning">ログイン履歴を読み込めませんでした。操作は続けられます。</p>
  return <p className="text-xs font-medium text-ink-secondary">{count ? `このユーザーにはログイン履歴が ${formatNumber(count)} 件あります` : 'ログイン履歴はありません'}</p>
}

/* 高危険操作が STEP_UP_REQUIRED で止まったとき、直前に立てる本人確認の窓（N-427 → V-1共通部品）。 */
type StepUpRequest = SharedStepUpRequest

/** 本人がいまログインしている端末の一覧と失効（N-427）。 */
function SessionsCard() {
  const [sessions, setSessions] = useState<Array<{ id: string; current: boolean; createdAt: string; expiresAt: string; userAgent: string | null; ipPrefix: string | null }> | null>(null)
  const [error, setError] = useState('')
  const [revokingId, setRevokingId] = useState<string | null>(null), [confirmCurrent, setConfirmCurrent] = useState(false), [confirmOthers, setConfirmOthers] = useState(false)
  const load = useCallback(async () => {
    try {
      const res = await api.sessions.list()
      if (res.success) setSessions(res.data.sessions)
      else setError('ログイン中の端末を読み込めませんでした')
    } catch { setError('ログイン中の端末を読み込めませんでした') }
  }, [])
  useEffect(() => { void load() }, [load])
  const revoke = async (id: string, isCurrent: boolean) => {
    setRevokingId(id); setError('')
    try {
      await api.sessions.revoke(id, { confirmCurrent: isCurrent })
      if (isCurrent) {
        // 自分のセッションを消したので、この画面はもう使えない。ログインへ戻す。
        window.location.assign('/login')
        return true
      }
      notifyToast('その端末のログインを終了しました')
      await load()
      return true
    } catch (caught) { setError(messageOf(caught)); return false } finally { setRevokingId(null) }
  }
  const revokeOthers = async () => {
    setRevokingId('others'); setError('')
    try {
      const res = await api.sessions.revokeOthers()
      if (!res.success) throw new Error(res.error)
      setConfirmOthers(false)
      if (res.success) { notifyToast(res.data.revoked > 0 ? `この端末以外の ${res.data.revoked} 件のログインを終了しました` : '他にログイン中の端末はありませんでした') }
      await load()
      return true
    } catch (caught) { setError(messageOf(caught)); return false } finally { setRevokingId(null) }
  }
  const deviceLabel = (userAgent: string | null): string => {
    if (!userAgent) return '端末情報なし'
    const os = /iPhone|iPad/.test(userAgent) ? 'iPhone / iPad' : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows' : /Mac OS/.test(userAgent) ? 'Mac' : /Linux/.test(userAgent) ? 'Linux' : 'その他の端末'
    const browser = /Edg\//.test(userAgent) ? 'Edge' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : /Firefox\//.test(userAgent) ? 'Firefox' : ''
    return browser ? `${os}・${browser}` : os
  }
  return <section className="rounded-card border content-card bg-canvas p-4" aria-label="ログイン中の端末">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-sm font-bold text-ink">ログイン中の端末</h2><p className="mt-1 text-xs text-ink-secondary">あなたのアカウントでいまログインしている端末です。見覚えのない端末があれば「ログインを終了」で切り離せます。</p></div>
      {sessions && sessions.length > 1 && <Button variant="secondary" onClick={() => { setError(''); setConfirmOthers(true) }}>この端末以外をすべて終了</Button>}</div>
    {error && <Notice tone="danger" className="mt-3" message={error} />}
    {sessions === null ? <p className="mt-3 text-xs text-ink-faint">読み込んでいます…</p> : sessions.length === 0 ? <p className="mt-3 text-xs text-ink-faint">ログイン中の端末はありません。</p> : (
      <ul className="mt-3 divide-y divide-hairline">
        {sessions.map((session) => <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0"><p className="truncate text-sm font-medium text-ink" title={session.userAgent ?? undefined}>{deviceLabel(session.userAgent)}{session.current && <span className="ml-2 rounded-pill bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-deep">この端末</span>}</p>
            <p className="mt-0.5 text-xs text-ink-faint">ログイン：{formatStaffDate(session.createdAt)}{session.ipPrefix ? `・接続元：${session.ipPrefix}` : ''}</p></div>
          <Button variant="secondary" disabled={revokingId === session.id} onClick={() => { setError(''); if (session.current) setConfirmCurrent(true); else void revoke(session.id, false) }} busy={revokingId === session.id} busyLabel="終了中…">ログインを終了</Button>
        </li>)}
      </ul>
    )}
    <ConfirmDialog
      open={confirmCurrent}
      title="この端末のログインを終了しますか？"
      description="いま使っているこの端末のログインが終わり、ログイン画面へ戻ります。"
      confirmLabel="この端末を終了する"
      busy={revokingId === sessions?.find((s) => s.current)?.id}
      error={error || undefined} onSuccess={() => setConfirmCurrent(false)} onConfirm={() => { const current = sessions?.find(s => s.current); return current ? revoke(current.id, true) : undefined }}
      onCancel={() => setConfirmCurrent(false)}
    />
    <ConfirmDialog
      open={confirmOthers}
      title="この端末以外のログインをすべて終了しますか？"
      description="他の端末はすべてログイン画面へ戻ります。この端末のログインは続きます。"
      confirmLabel="すべて終了する"
      busy={revokingId === 'others'}
      error={error || undefined} onSuccess={() => setConfirmOthers(false)} onConfirm={() => revokeOthers()}
      onCancel={() => { if (revokingId === 'others') return; setConfirmOthers(false) }}
    />
  </section>
}

/*
 * 「項目ごとに決める」の各行（STAFF-01）。3段階は [edit, view, none] の順で、
 * 説明文はその段階で実際にできることだけを書く。
 *   - 変えられる(edit): 閲覧に加えて、配信・返信・変更・操作などの実行も許す
 *   - 見えるだけ(view): 読み取り専用。配信・返信・変更はできない
 *   - 出さない(none):   メニューにも出さない（URL直打ちも拒否）
 * 「個人情報」だけは機能のON/OFFではなくメール等の見せ方を選ぶ行なので、
 * 選択肢の見出しを「そのまま見せる／伏せて見せる／見せない」に変える（例外）。
 * 並びは SCOPE_ITEMS と同じ順で、index で対応させる（N-411）。
 */
const SCOPE_LEVEL_LABELS = ['変えられる', '見えるだけ', '出さない'] as const
const SCOPE_MASK_LEVEL_LABELS = ['そのまま見せる', '伏せて見せる', '見せない'] as const
const SCOPE_ROWS = [
  ['友だち', '名前・タグ・対応状況', '追加・変更できる', '閲覧のみ', '見せない'],
  ['個人情報', '電話番号・住所・メール', 'すべて表示', '一部を伏せて表示', '見せない'],
  ['配信', '一斉配信・シナリオ・リマインダ', '作成・配信できる', '閲覧のみ', '見せない'],
  ['受信箱', '友だちとのやりとり', '返信できる', '閲覧のみ', '見せない'],
  ['予約', '予約・イベントの受付', '受付・変更できる', '閲覧のみ', '見せない'],
  ['予約メニュー', 'メニューと担当の編集', '変更できる', '閲覧のみ', '見せない'],
  ['予約設定', '受付枠・資源・予約スタッフ', '変更できる', '閲覧のみ', '見せない'],
  ['本人の勤務', '自分のシフト・休憩・連携', '変更できる', '閲覧のみ', '見せない'],
  ['分析', '成果・流入・レポート', '承認・変更できる', '閲覧のみ', '見せない'],
  ['設定', 'LINE・外部連携・ユーザー', '変更できる', '閲覧のみ', '見せない'],
  ['運用状態', '健全性・緊急停止・更新履歴', '操作できる', '閲覧のみ', '見せない'],
  ['来店スタンプ', 'カード・押印・紙の移行', '押印・変更できる', '閲覧のみ', '見せない'],
] as const

/*
 * R497: 見せる範囲の表が管理するキーの集合。表にない既存キー
 * （`/automations` など）は保存で落とさないことを画面でも約束し、
 * あるときは右欄に「そのまま残す」対象として出す。
 */
const SCOPE_COVERED_KEYS: ReadonlySet<string> = new Set([
  ...SCOPE_ITEMS.flatMap((item) => item.keys),
  ...BROADCAST_EDIT_OPERATION_KEYS,
])

function PermissionScopeView({ user, memberId, canSave, copyCandidates, roleCounts, accountNames, savedEditKeys, savedViewKeys, savedEmailMask, onClose, onSaved, onConflict }: {
  user: AccessUserItem
  memberId: string | null
  canSave: boolean
  copyCandidates: CopyableAccessUser[]
  roleCounts: AccessUserSummary['roleCounts']
  accountNames: Record<string, string>
  savedEditKeys: string[]
  savedViewKeys: string[]
  savedEmailMask: 'full' | 'masked' | 'none' | null
  onClose: () => void
  onSaved: () => Promise<void>
  onConflict: () => Promise<void>
}) {
  const saveErrors = useSaveFormErrors()

  const isCustom = user.roleBundle === 'custom'
  const hasSaved = memberId !== null
  /*
   * R497: 個別設定の人は保存済みキーを3択へ写して出す。
   * プリセット（受付など）への当てはめはしない。結び付いていない人
   * （保存済みが取れない）は従来どおりかたまり表示のままにする。
   */
  // 開いたときの保存済みが土台。11行の写しなので描画ごとに作り直す。
  const savedBase: ScopeLevels | null =
    isCustom && hasSaved ? restoreSavedLevels(savedEditKeys, savedViewKeys, savedEmailMask) : null
  /*
   * R497b: 3択では表せない「一部だけ許可」の行（例：分析の1キーのみ）。
   * keysToScopeLevels は none（出さない）と写すが、実際には許可中のキーが
   * あるので、そのまま「出さない」と押した表示にしない。内訳を別に示す。
   */
  const partialRows = isCustom && hasSaved ? findPartialScopeRows(savedEditKeys, savedViewKeys) : []
  const partialRowIds = new Set(partialRows.map((row) => row.itemId))
  const [bundle, setBundle] = useState<Exclude<AccessRoleBundle, 'custom'>>(
    user.roleBundle === 'custom' ? 'reception' : user.roleBundle,
  )
  /*
   * 「項目ごとに決める」の上書き。null は下書きの土台のまま。
   * 1項目でも触ると個別設定（custom）として保存される。
   */
  const [customLevels, setCustomLevels] = useState<ScopeLevels | null>(null)
  /*
   * R497: 行を触った記録。かたまり・コピーは全体の置き換えなので消す。
   * 行だけ触った保存は、触った行だけ保存済みキーへ適用する
   * （触っていない行の部分設定を落とさないため）。
   */
  const [touchedRowIds, setTouchedRowIds] = useState<string[]>([])
  const [wholesale, setWholesale] = useState(false)
  /*
   * R497b: 行を触る前の部分行だけが「一部」のまま。行を選び直したら
   * その行は選んだ内容に置き換わるので、一部の表示は消す。
   * かたまり・コピーは全体の置き換えなので、選んだら一部表示は消す。
   */
  const isPartialUntouched = (itemId: string): boolean =>
    partialRowIds.has(itemId) && !touchedRowIds.includes(itemId) && !wholesale
  const partialUntouchedRows = wholesale ? [] : partialRows.filter((row) => !touchedRowIds.includes(row.itemId))
  const partialLabelOf = (itemId: string): string => {
    const row = partialRows.find((candidate) => candidate.itemId === itemId)
    if (!row) return ''
    const labels = row.allowedKeys.map((key) => permissionLabel(key) || key)
    return labels.join('・')
  }
  const levels: ScopeLevels = customLevels ?? savedBase ?? BUNDLE_PRESETS[bundle].levels
  const dirty = wholesale || touchedRowIds.length > 0
  /*
   * R497: 個別設定の初期表示では、どの かたまりも選んでいない
   * （保存済みは下の表に出す）。かたまり・コピーを選び直したら選んだものを出す。
   */
  const selectedBundle: Exclude<AccessRoleBundle, 'custom'> | null =
    !isCustom || wholesale ? bundle : null
  const setLevel = (itemId: string, level: FeatureAccessLevel) => {
    setCustomLevels({ ...levels, [itemId]: level })
    setTouchedRowIds((current) => (current.includes(itemId) ? current : [...current, itemId]))
  }
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveConfirmOpen, setSaveConfirmOpen] = useState(false)
  const [saveConfirmError, setSaveConfirmError] = useState('')
  const savingRef = useRef(false)
  /*
   * R498: この下書きの保存の要求キー。保存ボタンを押した一連の操作で使い回し、
   * 応答を見失った再試行は同じキーで送る（サーバーは2回目を副作用なしで返す）。
   * 成功したら捨て、下書きを変えたら作り直す（内容違いの使い回しは422になる）。
   */
  const saveKeyRef = useRef<string | null>(null)
  useEffect(() => { saveKeyRef.current = null }, [bundle, customLevels, wholesale, touchedRowIds])
  const [copyOpen, setCopyOpen] = useState(false)
  const [copySourceId, setCopySourceId] = useState('')
  const [copyNotice, setCopyNotice] = useState('')
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  /*
   * IDEA-30: 管理者の権限確認は書込み不能の確認として扱う。
   * 管理者は役割そのもので全機能を通るため、この画面で項目を触っても
   * 実権限は変わらず「個別設定」の見た目だけが残る。役割を変えるときは
   * 一覧の「変更する」（確認＋再認証つき）から行う。
   */
  const targetIsAdministrator = user.roleBundle === 'administrator'
  const writable = canSave && !targetIsAdministrator
  const leaveGuard = useUnsavedGuard({ dirty: writable && dirty, busy: saving, onDiscard: onClose })
  const closeLinkedView = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    onClose()
  }
  /*
   * 「見せる範囲を保存」は更新口へつなぐ。閉じるだけにしない。
   * 受付に更新口の書き分けは無いので運用へ寄る(保存後に読み直すと
   * 「運用」と出る)。結び付いていない人・管理者以外は理由を出す。
   */
  const requestSave = () => {
    if (targetIsAdministrator) return setSaveError('管理者の権限はこの画面では変えられません。役割を変えるときは一覧の「変更する」から行います。')
    if (!memberId) return setSaveError('スタッフ情報と結び付いていないため保存できません。名前とメールを確認してください。')
    if (!canSave) return setSaveError('権限のかたまりは管理者だけが変えられます。')
    // R497: 何も変えていない保存は更新要求を送らない。権限も
    // セッションも版も変わらないので、確認窓を出さず閉じるだけにする。
    if (!dirty) {
      setSaveError('')
      onClose()
      return
    }
    setSaveError('')
    setSaveConfirmError('')
    setSaveConfirmOpen(true)
  }
  const save = async (stepUpToken?: string) => {
    if (!memberId || !canSave || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaveError('')
    setSaveConfirmError('')
    try {
      // N-424: bundle 名をそのまま送る。role へ潰すと「受付」と「運用」が区別できない。
      // 項目を1つでも触っていたら3択表ごと送り、API側が個別設定として保存する。
      saveKeyRef.current ??= crypto.randomUUID()
      /*
       * R497: 個別設定の人が行だけ触った保存は、触った行だけ保存済みキーへ
       * 適用して送る。触っていない行の部分設定（3択に写せない細かい差）は
       * そのまま残す。かたまり・コピー・プリセットの人の行編集は、土台が
       * プリセットで欠けがないため従来どおり3択表ごと送る。
       */
      const surgical = isCustom && hasSaved && touchedRowIds.length > 0 && !wholesale
      let permissionKeys: string[] | undefined
      let permissionViewKeys: string[] | undefined
      let emailMask: 'full' | 'masked' | 'none' | undefined
      if (surgical) {
        let nextEdit = [...savedEditKeys]
        let nextView = [...savedViewKeys]
        for (const itemId of touchedRowIds) {
          const applied = applyScopeRowChange(nextEdit, nextView, itemId, levels[itemId] ?? 'none')
          nextEdit = applied.edit
          nextView = applied.view
        }
        permissionKeys = nextEdit
        permissionViewKeys = nextView
        emailMask = scopePiiToEmailMask(levels.pii)
      } else {
        const piiLevel = customLevels?.pii
        emailMask = piiLevel === 'edit' ? 'full' : piiLevel === 'view' ? 'masked' : piiLevel === 'none' ? 'none' : undefined
      }
      const result = await api.staff.update(memberId, {
        roleBundle: bundle,
        permissionScope: surgical ? undefined : (customLevels ?? undefined),
        permissionKeys,
        permissionViewKeys,
        emailMask,
        idempotencyKey: saveKeyRef.current,
        expectedPolicyVersion: user.policyVersion,
      }, stepUpToken)
      if (!result.success) throw new Error(result.error)
      saveKeyRef.current = null
      setSaveConfirmOpen(false)
      await onSaved()
      onClose()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (!stepUpToken && isStepUpRequired(caught)) {
        setStepUp({ purpose: 'staff.permissions.change', action: '権限を変更する', retry: save });

        return
      }
      // R499: 他者が先に変えていたら上書きせず、一覧の最新へ戻す。
      if (caught instanceof ApiError && caught.status === 409) {
        saveKeyRef.current = null
        setSaveConfirmOpen(false)
        await onConflict()
        onClose()
        return
      }
      // R497-SAVE-WORDING: 見せる範囲の保存だけは既存 helper で言い分ける。
      // 生の API error:<status> を出さない。他の messageOf 呼びは変えない。
      const message = withPermissionFailure(caught, describeSaveFailure(caught), 'store')
      if (!fieldFailure) setSaveError(message)
      { if (!fieldFailure)
      setSaveConfirmError(message) }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  /*
   * かたまりごとの人数は固定文をやめ、実データ（roleCounts）から出す（LAY-09）。
   */
  const bundles = [
    ['administrator', '管理者', 'すべての設定と操作'],
    ['operations', 'スタッフ', '配信と日々の運用'],
    ['reception', '受付', '受信箱と予約を担当'],
    ['view_only', '閲覧のみ', '変更せず確認だけ'],
  ] as const
  const copyBundle = (sourceId: string) => {
    const source = copyCandidates.find((candidate) => candidate.id === sourceId)
    if (!source) return
    setCopySourceId(sourceId)
    // R67: コピー元のかたまりをそのまま使う。直前の個別編集が残っていると
    // 表示と保存がずれるので、上書きは捨てる。
    setCustomLevels(null)
    setBundle(source.roleBundle)
    setTouchedRowIds([])
    setWholesale(true)
    setSaveError('')
    setCopyNotice(`${source.name}の「${ACCESS_ROLE_LABEL[source.roleBundle]}」を下書きに反映しました。保存するまでは変更されません。`)
  }
  /*
   * LAY-09: 右欄の説明は選択中の権限（下書き）から組み立てる。
   * 「4項目」のような固定文は、実際の設定とずれるので置かない。
   * 個別設定の人の保存済み内訳はAPIが返さないため、差分は「未確認」と出す。
   */
  const featureItems = SCOPE_ITEMS.filter((item) => item.kind === 'feature')
  /*
   * R497b: 一部だけ許可の行は「出る・出さない」のどちらにも数えない。
   * そのまま数えると、出さない側に寄って保存内容と違う見え方になる。
   * 内訳は下の「一部だけ許可」の行で別に示す。
   */
  const visibleItems = featureItems.filter((item) => (levels[item.id] ?? 'none') !== 'none' && !isPartialUntouched(item.id))
  const hiddenItems = featureItems.filter((item) => (levels[item.id] ?? 'none') === 'none' && !isPartialUntouched(item.id))
  const piiLevel = levels.pii ?? 'none'
  const piiNote = piiLevel === 'edit'
    ? '個人情報（電話番号・住所・メール）もそのまま見えます'
    : piiLevel === 'view'
      ? '電話番号・住所・メールは伏せて表示します'
      : '電話番号・住所・メールは見せません'
  /*
   * R497: 差分の土台は保存済みそのもの。個別設定の人も保存済みキーから
   * 写せるようになったので、内訳の差分が出せる。保存済みが取れない
   * （結び付いていない個別設定）ときだけ未確認になる。
   */
  const compareBase: ScopeLevels | null =
    savedBase ?? (user.roleBundle === 'custom' ? null : BUNDLE_PRESETS[user.roleBundle].levels)
  const changedItems = compareBase
    ? SCOPE_ITEMS.filter((item) => (levels[item.id] ?? 'none') !== (compareBase[item.id] ?? 'none'))
    : null
  /*
   * R497: 表にない保存済みキー（`/automations` など）。保存しても落とさない
   * ことを右欄で約束する。表示名が無いキーはそのまま出す。
   */
  const extraKeys = [...new Set([...savedEditKeys, ...savedViewKeys])].filter((key) => !SCOPE_COVERED_KEYS.has(key))
  const extraLabels = extraKeys.map((key) => permissionLabel(key) || key)
  return <SaveErrorScope errors={saveErrors}><div data-design-node="EOTS4" className="flex flex-col gap-4 pb-28">
    <UnsavedLeaveDialog open={leaveGuard.leaveTarget !== null} onConfirm={leaveGuard.confirmLeave} onCancel={leaveGuard.cancelLeave} busy={saving} />
    {/* カード同士の縦の間隔はこの親の gap-4（16px）だけで作る。子ごとの mb/mt は付けない。 */}
    <div className="flex items-center justify-between"><nav className="text-xs text-ink-faint"><Button variant="text" textTone="ink" size="inline" onClick={() => leaveGuard.guarded(onClose)}>ログインユーザー</Button>　›　<span className="font-semibold text-action">{user.name}</span>　›　見せる範囲</nav>{writable ? <Button variant="secondary" disabled={copyCandidates.length === 0} onClick={() => setCopyOpen((current) => !current)}>ほかの人と同じにする</Button> : null}</div>
    {copyOpen && <section className="rounded-card border border-hairline bg-canvas p-4" aria-label="ほかの人の権限をコピー"><p className="mb-2 text-xs text-ink-secondary">同じ組織の人を選ぶと、その人の権限のかたまりを下書きへ反映します。コピーするとすべての行がコピー元の内容に置き換わり、一部だけ許可の細かい設定は残りません。</p><SaveErrorField names={["copySourceId","copy_source_id"]}><EntitySelect aria-label="コピー元のログインユーザー" value={copySourceId} onChange={copyBundle} size="full" options={[{ value: '', label: 'コピー元を選ぶ', disabled: true }, ...copyCandidates.map((candidate) => ({ ...entityOptionMetadata(candidate), value: candidate.id, label: `${candidate.name}（${ACCESS_ROLE_LABEL[candidate.roleBundle]}）` }))]} /></SaveErrorField>{copyNotice && <p className="mt-2 text-xs font-medium text-success" role="status">{copyNotice}</p>}</section>}
    {/*
      LAY-07: 狭い幅は1列で「いまの権限→変更項目→影響の確認」の順にする。
      説明欄（390px）と横に並べるのは、設定欄に十分な幅が残る1024px以上だけ。
      それ未満では説明欄は設定の下へ回り込む。
    */}
    <div className={`grid grid-cols-1 items-start gap-4 ${styles.scopeGrid}`}>
      <div className="flex flex-col gap-4">
        <section className="rounded-card border content-card bg-canvas p-4"><h2 className="text-base font-bold text-ink">いまの権限</h2><p className="mt-1 text-xs text-ink-secondary">{user.name}さんはいま「{ACCESS_ROLE_LABEL[user.roleBundle]}」です。{isCustom ? (savedBase ? (partialUntouchedRows.length > 0 ? '下の表には保存されている内容を出しています。一部だけ許可の行は3つの選択肢に当てはまらないため、行の下に内訳を出しています。' : '下の表には保存されている内容をそのまま出しています。') : '項目ごとの内訳は取得できていません（未確認）。') : ''}{targetIsAdministrator ? '' : '保存すると、対象者はもう一度ログインが必要です。'}</p>{/* IDEA-30: 閲覧・編集・実行とあわせて対象アカウントの権限もこの画面で確認できるようにする。 */}<p className="mt-2 text-xs text-ink-secondary">対象のLINEアカウント：{accessScopeLabel(user, accountNames)}{user.accountScope.type === 'accounts' && user.accountScope.includesDescendants ? '（配下のアカウントも含みます）' : ''}</p>{targetIsAdministrator ? <p className="mt-2 text-xs font-semibold text-ink-secondary">管理者はすべての機能を使えます。この画面では権限の確認だけでき、ここからは変更できません。役割を変えるときは一覧の「変更する」から行います。</p> : null}</section>
        <section className="rounded-card border content-card bg-canvas p-4"><h2 className="text-base font-bold text-ink">かたまりから選ぶ</h2><p className="mt-1 text-xs text-ink-faint">よく使う組み合わせを用意しています。選んでから、下で細かく直せます。かたまりを選ぶとすべての行がその内容に置き換わり、一部だけ許可の細かい設定は残りません。</p><div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">{bundles.map(([value, label, note]) => <button key={value} type="button" disabled={!writable} onClick={() => {
            // R67: かたまりを選んだら個別の上書きは捨てる。残したままにすると
            // 表示は新しいかたまりなのに保存は古い個別設定になる。
            // R497: 選んでいる かたまりの選び直しは何も変えない。
            // 個別設定の人が かたまりを選ぶのは、個別設定から変える操作になる。
            if (value === bundle && customLevels === null && !isCustom) return
            setCustomLevels(null)
            setBundle(value)
            setTouchedRowIds([])
            setWholesale(true)
          }} className={`rounded-control border p-3 text-left ${selectedBundle === value ? 'border-accent bg-accent-soft' : 'border-divider-soft bg-canvas'} ${writable ? '' : 'cursor-not-allowed opacity-60'}`}><span className="flex items-center justify-between"><span className="text-sm font-semibold text-ink">{label}</span><span className="text-xs text-ink-faint">{roleCounts[value]} 人</span></span><span className={`mt-2 block text-xs ${selectedBundle === value ? 'font-semibold text-success' : 'text-ink-faint'}`}>{note}</span></button>)}</div></section>
        {/*
          LAY-07: 機能ごとにカードへ分け、その中に3択を置く。
          以前の3列140px固定の表形式は狭い幅で潰れていた。
          各選択肢は触れる高さ（min-h-11）を確保する。
        */}
        <section className="overflow-hidden rounded-card border content-card bg-canvas"><div className="px-4 py-4"><h2 className="text-base font-bold text-ink">項目ごとに決める</h2><p className="mt-1 text-xs text-ink-faint">「変えられる」「見えるだけ」「出さない」の3つから選びます。「変えられる」は閲覧・編集に加えて配信や返信などの実行も許し、「見えるだけ」は読み取り専用、「出さない」はメニューにも出しません。ただし「個人情報」は機能ではなくメールなどの見せ方を選ぶので、「そのまま見せる」「伏せて見せる」「見せない」の3つになります。行を選び直すとその行だけ置き換わり、触っていない行の一部だけ許可はそのまま残ります。</p></div><div className="divide-y divide-hairline border-t border-hairline">{SCOPE_ROWS.map(([label, note, full, partial, none], index) => { const item = SCOPE_ITEMS[index]; const partialHere = isPartialUntouched(item.id); const level = partialHere ? undefined : (levels[item.id] ?? 'none'); const optionLabels = item.kind === 'email_mask' ? SCOPE_MASK_LEVEL_LABELS : SCOPE_LEVEL_LABELS; return <div key={label} className="px-4 py-3"><div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><div className="min-w-0"><p className="text-xs font-bold text-ink">{label}{partialHere ? '（一部だけ許可）' : ''}</p><p className="mt-0.5 text-xs text-ink-faint">{note}</p></div>{item.hint ? <p className="text-xs font-semibold text-warning">{item.hint}</p> : null}</div><SegmentedControl aria-label={`${label}の見せ方`} disabled={!writable} value={level ?? 'custom'} onChange={next=>setLevel(item.id,next as FeatureAccessLevel)} options={([full,partial,none] as const).map((text,option)=>({value:option===0?'edit':option===1?'view':'none',label:<><span>{optionLabels[option]}</span><span>（{text}）</span></>,ariaLabel:`${label}：${optionLabels[option]}（${text}）`}))} />{partialHere ? <p className="mt-2 text-xs font-medium text-ink-secondary">一部だけ許可されています（3つの選択肢では表せません）。許可中のもの：{partialLabelOf(item.id)}。このまま保存すれば残ります。この行を選び直すと、その行は選んだ内容に置き換わります。</p> : null}</div> })}</div></section>
      </div>
      <aside className="flex flex-col gap-4"><section className="rounded-card border content-card bg-canvas p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-bold text-ink">この決め方で、この人にはこう見えます</h2>{dirty ? <span className="rounded-pill bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent-deep">変更後の予定</span> : null}</div><div className="mt-3 space-y-3 text-xs text-ink-secondary"><p><b className="text-ink">◉　メニューに出るのは{visibleItems.length}項目</b><br />　　{visibleItems.length > 0 ? visibleItems.map((item) => item.label).join('・') : '出る項目はありません'}</p><p><b className="text-ink">◉　出さないのは{hiddenItems.length}項目</b><br />　　{hiddenItems.length > 0 ? `${hiddenItems.map((item) => item.label).join('・')}。URLを直に打っても「見る権限がありません」と出ます` : '出さない項目はありません'}</p><p><b className="text-ink">◉　{piiNote}</b></p>{changedItems === null ? <p><b className="text-ink">◉　いまの設定は個別に決められているため、ここから変わる項目の内訳は未確認です</b></p> : changedItems.length > 0 ? <p><b className="text-ink">◉　いまの設定から変わるのは{changedItems.length}項目</b><br />　　{changedItems.map((item) => item.label).join('・')}</p> : <p><b className="text-ink">◉　いまの設定と同じ内容です</b></p>}{partialUntouchedRows.length > 0 ? <p><b className="text-ink">◉　一部だけ許可が{formatNumber(partialUntouchedRows.length)} 行あります</b><br />　　{partialUntouchedRows.map((row) => `${SCOPE_ITEMS.find((item) => item.id === row.itemId)?.label ?? row.itemId}（許可中のもの：${row.allowedKeys.map((key) => permissionLabel(key) || key).join('・')}）`).join('、')}。行を触らず保存すれば残ります。かたまり・コピーを選ぶと置き換わります</p> : null}{extraLabels.length > 0 ? <p><b className="text-ink">◉　この表にない権限{formatNumber(extraLabels.length)} 件（{extraLabels.join('・')}）は保存してもそのまま残します</b></p> : null}</div></section><section className="rounded-card border content-card bg-canvas p-4"><h2 className="text-sm font-bold text-ink">つながる先</h2>{/* 移動前の確認で止められたときは、権限の下書きを閉じない。 */}<div className="mt-3 space-y-3 text-xs"><Link href="/settings" onClick={closeLinkedView} className="block font-bold text-action hover:underline">→ 機能設定</Link><Link href="/staff?tab=audit" onClick={closeLinkedView} className="block font-bold text-action hover:underline">→ 入った記録</Link><Link href="/emergency" onClick={closeLinkedView} className="block font-bold text-action hover:underline">→ 運用状態</Link><Link href="/booking/menus" onClick={closeLinkedView} className="block font-bold text-action hover:underline">→ 予約設定</Link></div></section><Notice tone="warn" heading={<> <h2>気をつけること</h2> </>}><p className="mt-2 text-xs font-bold">配信を出さないと、受信箱からの返信もできません</p><p className="mt-2 text-xs">保存すると、対象者はもう一度ログインする必要があります。</p></Notice></aside>
    </div>
    {/*
      LAY-08: バーはビュー幅に追従する。メニューが無い幅では全幅、
      PC（1280px以上）は実在するメニュー256pxぶんだけ左を空ける。
      狭い幅では説明は本文（いまの権限カード）へ移し、下部は操作だけに絞る。
      高さは固定せず、長いエラー文は折り返してボタンを隠さない。
    */}
    {saveError && !saveConfirmOpen ? <Notice tone="danger">{saveError}</Notice> : null}
    {writable && (dirty || saving) ? <PageFooter actions={<><Button disabled={saving} onClick={() => { setCustomLevels(null); setTouchedRowIds([]); setWholesale(false); setBundle(user.roleBundle === 'custom' ? 'reception' : user.roleBundle); setSaveError('') }}>キャンセル</Button><Button variant="primary" disabled={saving} onClick={requestSave} busy={saving}>見せる範囲を保存する</Button></>} /> : null}

    <ConfirmDialog
      open={saveConfirmOpen}
      title={`${user.name}さんの見せる範囲を保存しますか？`}
      description="保存すると、対象者のすべてのログインが終了します。新しい権限で使うには、対象者がもう一度ログインする必要があります。"
      confirmLabel="保存する"
      busy={saving}
      error={saveConfirmError}
      onConfirm={() => save()}
      onCancel={() => { if (saving) return; setSaveConfirmOpen(false); setSaveConfirmError('') }}
    />
    {stepUp && <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} />}
  </div></SaveErrorScope>
}

function EditModal({ member, administrator, currentUserId, activeAdministratorCount, selectedAccountId, onClose, onSaved, surface }: { selectedAccountId: string | null; surface?: 'page' | 'dialog'; member: StaffMember; administrator: boolean; currentUserId: string | null; activeAdministratorCount: number; onClose: () => void; onSaved: () => Promise<void> }) {
  const saveErrors = useSaveFormErrors()

  const [name, setName] = useState(member.name), [email, setEmail] = useState(member.email ?? '')
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string }>({})
  const nameRef = useRef<HTMLInputElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const validateFields = () => {
    const errors: { name?: string; email?: string } = {}
    if (administrator && !name.trim()) errors.name = '名前を入力してください'
    if (!email.trim()) errors.email = 'メールアドレスを入力してください'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) errors.email = '正しいメールアドレスを入力してください'
    setFieldErrors(errors)
    if (!errors.name && !errors.email) return true
    setError('')
    const field = errors.name ? nameRef.current : emailRef.current
    field?.focus()
    field?.scrollIntoView({ block: 'center' })
    return false
  }
  const [role, setRole] = useState<'admin' | 'staff' | 'viewer'>(member.role === 'owner' ? 'admin' : member.role)
  const [permissions, setPermissions] = useState(member.permissionKeys)
  const [notifications, setNotifications] = useState<Record<string, Channel>>(() => Object.fromEntries(NOTIFICATIONS.map(([key]) => [key, member.notificationPreferences[key] ?? { email: true, line: true }])))
  const [saving, setSaving] = useState(false), [statusSaving, setStatusSaving] = useState(false), [error, setError] = useState('')
  const [loginCount, setLoginCount] = useState<number | null>(null), [loginHistoryLoading, setLoginHistoryLoading] = useState(administrator), [loginHistoryFailed, setLoginHistoryFailed] = useState(false)
  /*
   * **ブラウザの `confirm` を使わない。**
   *
   * 見た目がブラウザ任せで設計の確認窓（`J6x4Q` / `H2S1T4`）と違ううえ、
   * 画像比較にも写らない。連携を外すと何が届かなくなるのかを本文で読ませたい
   * ので、共通の `ConfirmDialog` へ移した。
   */
  const [unlinkTarget, setUnlinkTarget] = useState<{ id: string; name: string; version: number | undefined; epoch: number } | null>(null), [unlinking, setUnlinking] = useState(false), [unlinkError, setUnlinkError] = useState('')
  const unlinkScope = useRef({ selectedAccountId, memberId: member.id, version: member.policyVersion, linked: member.lineLinked, administrator, epoch: 0 })
  if (unlinkScope.current.selectedAccountId !== selectedAccountId || unlinkScope.current.memberId !== member.id || unlinkScope.current.version !== member.policyVersion || unlinkScope.current.linked !== member.lineLinked || unlinkScope.current.administrator !== administrator) unlinkScope.current = { selectedAccountId, memberId: member.id, version: member.policyVersion, linked: member.lineLinked, administrator, epoch: unlinkScope.current.epoch + 1 }
  const unlinkTargetRef = useRef(unlinkTarget)
  unlinkTargetRef.current = unlinkTarget
  useEffect(() => () => { unlinkScope.current.epoch++ }, [])
  /* 権限・利用状態・LINE連携の変更は 428 で止まる。止まったら本人確認の窓を立てて、grant を付けて同じ操作をやり直す。 */
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  /* N-433: 本人のメール変更は確認メールを経て確定する。保存直後に旧アドレスのまま閉じると「変わった」ように見えるので、確認待ちを画面に残す。 */
  const [emailNotice, setEmailNotice] = useState('')
  /*
   * R498: 同じ描画中の二度押しは掛け金で止める（state は次の描画まで古いまま
   * なので disabled だけでは2回目を止められない）。要求キーは保存の一連で
   * 使い回し、中身を変えたら作り直す。
   */
  const savingRef = useRef(false)
  const saveKeyRef = useRef<string | null>(null)
  useEffect(() => { saveKeyRef.current = null }, [name, email, role, permissions, notifications])
  const policy = staffActionPolicy({ member, currentUserId, administrator, activeAdministratorCount })
  useEffect(() => {
    if (!administrator) return
    let active = true
    void api.staff.loginSummary(member.id).then((result) => { if (active && result.success) setLoginCount(result.data.loginCount) }).catch(() => { if (active) setLoginHistoryFailed(true) }).finally(() => { if (active) setLoginHistoryLoading(false) })
    return () => { active = false }
  }, [administrator, member.id])
  const initialNotifications = Object.fromEntries(NOTIFICATIONS.map(([key]) => [key, member.notificationPreferences[key] ?? { email: true, line: true }]))
  const dirty = (administrator && (name.trim() !== member.name || role !== (member.role === 'owner' ? 'admin' : member.role) || JSON.stringify(normalizeStaffPermissionKeys(permissions)) !== JSON.stringify(normalizeStaffPermissionKeys(member.permissionKeys))))
    || email.trim() !== (member.email ?? '') || JSON.stringify(notifications) !== JSON.stringify(initialNotifications)
  const toggleNotification = (key: string, channel: keyof Channel) => setNotifications((current) => ({ ...current, [key]: { ...current[key], [channel]: !current[key][channel] } }))
  const save = async (stepUpToken?: string) => { if (!dirty) return; if (!validateFields()) return; if (savingRef.current) return; savingRef.current = true; saveKeyRef.current ??= crypto.randomUUID(); setSaving(true); setError(''); try { const res = await api.staff.update(member.id, { name: administrator ? name.trim() : undefined, email: email.trim(), role: administrator ? role : undefined, permissionKeys: administrator && role === 'staff' ? normalizeStaffPermissionKeys(permissions) : undefined, notificationPreferences: notifications, idempotencyKey: saveKeyRef.current, expectedPolicyVersion: member.policyVersion }, stepUpToken); if (!res.success) throw new Error(res.error); await onSaved(); if (res.data.emailChangePending && res.data.pendingEmail) { saveKeyRef.current = null; setEmailNotice(`${res.data.pendingEmail} へ確認メールを送りました。届いたメールのリンクを開くと変更が完了します。`); return } saveKeyRef.current = null; notifyToast('ログインユーザーの変更を保存しました。'); onClose() } catch (caught) {
    const fieldFailure = saveErrors.capture(caught);
 if (!stepUpToken && isStepUpRequired(caught)) { setStepUp({ purpose: 'staff.permissions.change', action: '権限を変更する', retry: save }); return } if (caught instanceof ApiError && caught.status === 409) { saveKeyRef.current = null; await onSaved(); { if (!fieldFailure) setError('ほかの管理者が先に権限を変更しました。一覧を読み直したので、開き直して最新の内容を確認してください。'); } return } { if (!fieldFailure) setError(messageOf(caught)) } } finally { savingRef.current = false; setSaving(false) } }
  /**
   * LINE連携を外す。
   *
   * 処理中は受け付けない（二度押しで2回叩くと、2回目の返事で失敗に見える）。
   * 失敗は握りつぶさず、窓の中に運用者の言葉で出す。生のAPIエラーだと
   * 次に何をすればよいか読み取れない。
   */
  const unlinkLine = async (confirmation: NonNullable<typeof unlinkTarget>, stepUpToken?: string): Promise<void> => {
    if (unlinking || unlinkTargetRef.current !== confirmation || confirmation.epoch !== unlinkScope.current.epoch) return
    if (confirmation.version === undefined) { setUnlinkError('対象の版を確認できません。読み直してから、もう一度お試しください。'); return }
    setUnlinking(true); setUnlinkError('')
    try {
      const res = await api.staff.update(confirmation.id, { lineLinked: false, expectedPolicyVersion: confirmation.version }, stepUpToken)
      if (confirmation.epoch !== unlinkScope.current.epoch || unlinkTargetRef.current !== confirmation) return
      if (!res.success) throw new Error(res.error)
      setUnlinkTarget(null); await onSaved(); onClose()
    } catch (caught) {
      if (confirmation.epoch !== unlinkScope.current.epoch || unlinkTargetRef.current !== confirmation) return
      const fieldFailure = saveErrors.capture(caught)
      if (!stepUpToken && isStepUpRequired(caught)) { setStepUp({ purpose: 'staff.permissions.change', action: '権限を変更する', retry: (token) => unlinkLine(confirmation, token) }); return }
      if (!fieldFailure) setUnlinkError('LINE連携を解除できませんでした。状態を読み直してから、もう一度お試しください。')
    } finally { setUnlinking(false) }
  }
  // R500: 無効化・再有効化の後は行が絞り込みから出し入れされるので、行き先を知らせる。
  const toggleActive = async (stepUpToken?: string) => { if (policy.statusBlockedReason) return; setStatusSaving(true); setError(''); try { await api.staff.update(member.id, { isActive: !member.isActive }, stepUpToken); await onSaved(); notifyToast(member.isActive ? '無効にしました。「利用状態」で「無効のみ」を選ぶと、この人を一覧に戻せます。' : '有効にしました。対象者はもう一度ログインが必要です。'); onClose() } catch (caught) {
    const fieldFailure = saveErrors.capture(caught);
 if (!stepUpToken && isStepUpRequired(caught)) { setStepUp({ purpose: 'staff.permissions.change', action: '権限を変更する', retry: toggleActive }); return } { if (!fieldFailure)

 setError(messageOf(caught)) } } finally { setStatusSaving(false) } }
  return <SaveErrorScope errors={saveErrors}><EditorSurface surface={surface} open title="ログインユーザーを編集する" onCancel={onClose} footer={dirty || saving ? <><Button variant="secondary" disabled={saving} onClick={() => { setName(member.name); setEmail(member.email ?? ''); setRole(member.role === 'owner' ? 'admin' : member.role); setPermissions(member.permissionKeys); setNotifications(initialNotifications); setFieldErrors({}); setError('') }}>キャンセル</Button><Button variant="primary" onClick={() => void save()} busy={saving} disabled={saving}>保存する</Button></> : false}><div data-design-node="EOTS4"><div className="flex items-start justify-between"><div><p className="mt-1 text-xs text-ink-secondary">役割・表示機能・担当範囲を確認し、このユーザーに必要な範囲だけを設定します。</p></div></div>
    <div className="mt-5 rounded-control bg-canvas-sunken p-3"><p className="font-semibold text-ink">{member.name}</p><p className="text-xs text-ink-secondary">{ROLE_LABEL[member.role]}</p></div>{error && <Notice tone="danger">{error}</Notice>}{emailNotice && <Notice tone="success" role="status">{emailNotice}</Notice>}
    {policy.showAccountActions && <section className={`mt-5 rounded-card border p-4 ${member.isActive ? 'border-accent bg-accent-soft' : 'border-warning bg-warning-bg'}`} aria-label="ユーザーの利用状態"><div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-sm font-semibold text-ink">ログイン状態：{member.isActive ? '有効' : '無効'}</p><p className="mt-1 text-xs leading-5 text-ink-secondary">{member.isActive ? '無効にすると、このユーザーはログインできなくなります。' : '有効にすると、このユーザーは再びログインできます。'}</p><div className="mt-2"><LoginHistoryNote count={loginCount} loading={loginHistoryLoading} failed={loginHistoryFailed} /></div></div><Button variant="primary" className={(`min-w-48 rounded-control px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40 ${member.isActive ? 'border border-warning bg-canvas text-warning hover:bg-warning-bg' : 'bg-accent-deep text-on-accent hover:brightness-90'}`) + ' h-auto whitespace-normal'} type="button" onClick={() => toggleActive()} disabled={statusSaving || Boolean(policy.statusBlockedReason)} busy={Boolean(statusSaving)} busyLabel="変更中…">{member.isActive ? 'このユーザーを無効にする' : 'このユーザーを有効にする'}</Button></div>{policy.statusBlockedReason && <p className="mt-3 rounded-control bg-canvas p-3 text-xs font-semibold text-warning">{policy.statusBlockedReason}</p>}</section>}
    <div className="mt-5 grid gap-4 sm:grid-cols-2">{administrator && <Field label="名前" required htmlFor="staff-edit-name" error={fieldErrors.name}><SaveErrorField names={["name"]}><TextField ref={nameRef} id="staff-edit-name" value={name} onChange={(e) => { setName(e.target.value); setFieldErrors((current) => ({ ...current, name: undefined })) }} /></SaveErrorField></Field>}<Field label="メールアドレス" required htmlFor="staff-edit-email" error={fieldErrors.email}><SaveErrorField names={["email"]}><TextField ref={emailRef} id="staff-edit-email" type="email" value={email} onChange={(e) => { setEmail(e.target.value); setFieldErrors((current) => ({ ...current, email: undefined })) }} /></SaveErrorField></Field></div>
    {administrator && <div className="mt-5"><p className="text-sm font-semibold text-ink">役割</p><div className="mt-2 grid grid-cols-3 gap-2">{(['admin', 'staff', 'viewer'] as const).map((value) => <Button variant="secondary" className={(`cursor-pointer rounded-control border px-3 py-3 text-sm ${role === value ? 'border-accent bg-accent-soft font-medium text-accent-deep' : 'border-hairline text-ink-secondary'}`) + ' h-auto whitespace-normal'} key={value} onClick={() => setRole(value)}>{ROLE_LABEL[value]}</Button>)}</div></div>}
    {administrator && role === 'staff' && <div className="mt-5"><p className="text-sm font-semibold text-ink">スタッフに表示する機能</p><div className="mt-2 grid gap-2 sm:grid-cols-3">{PERMISSIONS.map(([key, label]) => <SaveErrorField names={["key","permissions"]} key={key}><ToggleField key={key} checked={permissions.includes(key)} onChange={() => setPermissions((current) => toggleStaffPermissionKey(current, key))}>{label}</ToggleField></SaveErrorField>)}</div><p className="mt-3 text-sm font-medium text-ink">成果の操作権限</p><p className="mt-1 text-xs text-ink-faint">選ぶと「成果とアフィリエイト」の表示も組で付きます。表示を外すと操作権限も外れます。</p><div className="mt-2 grid gap-2 sm:grid-cols-3"><SaveErrorField names={["CONVERSION_APPROVAL_EDIT_KEY","permissions","_c_o_n_v_e_r_s_i_o_n__a_p_p_r_o_v_a_l__e_d_i_t__k_e_y"]}><ToggleField checked={permissions.includes(CONVERSION_APPROVAL_EDIT_KEY)} onChange={() => setPermissions((current) => toggleStaffPermissionKey(current, CONVERSION_APPROVAL_EDIT_KEY))} aria-label="成果を承認・却下する">{PERMISSION_LABELS[CONVERSION_APPROVAL_EDIT_KEY]}</ToggleField></SaveErrorField></div></div>}
    <div className="mt-5"><p className="text-sm font-semibold text-ink">LINE連携</p><div className={`mt-2 flex items-center justify-between rounded-control border p-3 ${member.lineLinked ? 'border-accent bg-accent-soft' : 'border-hairline'}`}><div><p className={`text-sm font-semibold ${member.lineLinked ? 'text-success' : 'text-ink-secondary'}`}>{member.lineLinked ? '連携済み' : '未連携'}</p><p className="text-xs text-ink-faint">{member.lineLinked ? `LINE：${member.name}` : '招待メールからLINE認証を行います'}</p></div>{member.lineLinked && <Button variant="secondary" className="px-3 py-1.5 text-xs h-auto whitespace-normal" onClick={() => { setUnlinkError(''); setUnlinkTarget({ id: member.id, name: member.name, version: member.policyVersion, epoch: unlinkScope.current.epoch }) }}>連携解除</Button>}</div></div>
    <div className="mt-5"><p className="text-sm font-semibold text-ink">通知設定</p><div className="mt-2 divide-y divide-hairline overflow-hidden rounded-card border border-hairline">{NOTIFICATIONS.map(([key, label, note]) => <div key={key} className={`${styles.notifyRow} items-center gap-4 p-3`}><div><p className="text-sm text-ink">{label}</p><p className="text-xs text-ink-faint">{note}</p></div><div className="flex items-center gap-2 text-xs">メール<NotificationSwitch checked={notifications[key].email} onChange={() => toggleNotification(key, 'email')} label={`${label}メール`} /></div><div className="flex items-center gap-2 text-xs">LINE<NotificationSwitch checked={notifications[key].line} onChange={() => toggleNotification(key, 'line')} label={`${label}LINE`} /></div></div>)}</div></div>
    {/* 連携はあとから張り直せる。赤は本当に戻せない操作に取っておく。 */}
    <ConfirmDialog
      open={unlinkTarget !== null && unlinkTarget.epoch === unlinkScope.current.epoch}
      title={`${unlinkTarget?.name ?? ''} のLINE連携を解除しますか？`}
      description="このユーザーへのLINE通知が止まります。ログインや権限はそのままで、招待メールからLINE認証をやり直せば、また繋がります。"
      confirmLabel="解除する"
      busy={unlinking}
      error={unlinkError}
      onConfirm={() => unlinkTarget ? unlinkLine(unlinkTarget) : undefined}
      onCancel={() => { if (unlinking) return; setUnlinkTarget(null); setUnlinkError('') }}
    >
      <OperationTargetSummary accounts={[{ id: '', name: '不明' }]} externalTarget={{ label: 'ユーザー', name: unlinkTarget?.name }} />
      <p className="text-ink-secondary text-sm">通知設定でLINEを選んでいるお知らせは、解除したあと届かなくなります。メールを選んでいるぶんはそのまま届きます。</p>
    </ConfirmDialog>
    {stepUp && <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} />}
  </div></EditorSurface></SaveErrorScope>
}

function TwoFactorModal({ member, onClose }: { member: StaffMember; onClose: () => void }) {
  const saveErrors = useSaveFormErrors()
  const [uri, setUri] = useState(''), [manualKey, setManualKey] = useState(''), [qr, setQr] = useState(''), [code, setCode] = useState(''), [error, setError] = useState(''), [saving, setSaving] = useState(false)
  useEffect(() => { void (async () => { try { const res = await api.staff.beginTwoFactorSetup(member.id); if (res.success) { setUri(res.data.provisioningUri); setManualKey(res.data.manualKey) } } catch (caught) {
    const fieldFailure = saveErrors.capture(caught)
 { if (!fieldFailure)

 setError(messageOf(caught)) } } })() }, [member.id, saveErrors])
  useEffect(() => { if (uri) void qrToDataURL(uri, { width: 240, margin: 1, color: qrColors() }).then(setQr) }, [uri])
  const save = async (entered?: string) => { const value = entered ?? code; if (saving) return; if (!/^\d{6}$/.test(value)) return setError('6桁の認証コードを入力してください'); setSaving(true); setError(''); try { const res = await api.staff.confirmTwoFactorSetup(member.id, value); if (!res.success) throw new Error(res.error); await logoutAndGoToLogin('/login') } catch (caught) {
    const fieldFailure = saveErrors.capture(caught)
 { if (!fieldFailure)

 setError(otpFailureMessage(messageOf(caught))) } } finally { setSaving(false) } }
  return <SaveErrorScope errors={saveErrors}><Dialog open title="二段階認証を設定" onCancel={onClose} footer={<DialogActions><Button variant="primary" onClick={() => save()} disabled={saving || !uri} busy={saving}>確認して登録する</Button></DialogActions>}>
    {error ? <Notice tone="danger" message={error} /> : null}
    <TotpQr qr={qr} manualKey={manualKey} />
    <Field label="認証アプリに表示された6桁コード"><SaveErrorField names={["code"]}><OtpInput value={code} onChange={setCode} onComplete={entered => void save(entered)} label="認証アプリに表示された6桁コード" invalid={Boolean(error)} busy={saving} /></SaveErrorField></Field>
  </Dialog></SaveErrorScope>
}

/*
 * 板  右の欄「役割でできること」。運用の目安の書き付け。
 */
/** 役割の札（色：オーナー墨・管理者緑・運用青・受付琥珀・見るだけ灰）。 */
type RoleKey = 'owner' | AccessRoleBundle
const V8_ROLE_LABEL: Record<RoleKey, string> = {
  owner: 'オーナー', administrator: '管理者', operations: '運用', reception: '受付', view_only: '見るだけ', custom: '個別設定',
}
function RoleChip({ role }: { role: RoleKey }) {
  return <StatusBadge tone={role === 'administrator' ? 'success' : role === 'operations' ? 'info' : role === 'reception' ? 'warning' : 'neutral'} dot={false} data-role={role}>{V8_ROLE_LABEL[role]}</StatusBadge>
}

const STAFF_TAB_KEYS = [
  { key: 'members', label: 'ユーザー' }, { key: 'invited', label: '招待中' },
  { key: 'audit', label: 'ログイン履歴' }, { key: 'roles', label: '役割と権限' },
] as const

/** 最終ログイン日を日本時間の日付だけで表示する。 */
function lastLoginDay(value: string | null | undefined): string {
  if (!value) return '—'
  return polishFormatDate(value, { style: 'list-day', fallback: '—' })
}

/** 二段階認証の札。オン／確認が必要（作る・送る役割で未設定）／無効（見るだけで未設定・止めた人）。 */
function twoFactorState(user: AccessUserItem): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  if (user.status === 'suspended') return { label: '利用停止中', tone: 'neutral' }
  if (user.mfaEnabled) return { label: '二段階認証 オン', tone: 'success' }
  if (user.roleBundle === 'view_only') return { label: '無効', tone: 'neutral' }
  return { label: '確認が必要', tone: 'warning' }
}

function StaffPageHost({ editId }: { editId?: string | null }) {
  const saveErrors = useSaveFormErrors()

  const router = useRouter()

  const tab = useMergedTab(STAFF_TAB_KEYS, 'tab', 'members')
  const { selectedAccountId } = useAccount()
  const [members, setMembers] = useState<StaffMember[]>([])
  const [membersAccountId, setMembersAccountId] = useState<string | null>(null)
  const [accessUsers, setAccessUsers] = useState<AccessUserItem[]>([])
  const [usersTotal, setUsersTotal] = useState(0)
  const [accessSummary, setAccessSummary] = useState<AccessUserSummary>(EMPTY_ACCESS_SUMMARY)
  const [accessRoles, setAccessRoles] = useState<AccessRoleItem[]>([])
  const [accountNames, setAccountNames] = useState<Record<string, string>>({})
  const me = useStaffIdentity()
  const [audits, setAudits] = useState<AuditEventItem[]>([])
  const [query, setQuery] = useListUrlValue('q', '')
  const [statusFilter, setStatusFilter] = useListUrlValue<'active' | 'suspended' | 'all'>('statusFilter', 'active')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // ★管理画面 `x63W5x`：集計が取れていない間、KPI に 0 を出さない。「—」と出す。
  const [summaryReady, setSummaryReady] = useState(false)
  const membersLoadVersion = useRef(0)
  const [editing, setEditing] = useState<StaffMember | null>(null), [settingTwoFactor, setSettingTwoFactor] = useState<StaffMember | null>(null), [permissionTarget, setPermissionTarget] = useState<AccessUserItem | null>(null)
  const [userPage, setUserPage] = useListUrlValue('userPage', 1)
  const USER_PAGE_SIZE = 6
  /* ブラウザの `confirm` をやめて、共通の確認窓へ移した（理由は EditModal と同じ）。 */
  const [disablingTarget, setDisablingTarget] = useState<StaffMember | null>(null), [disablingTwoFactor, setDisablingTwoFactor] = useState(false), [disableError, setDisableError] = useState('')
  const [removingTarget, setRemovingTarget] = useState<StaffMember | null>(null), [removing, setRemoving] = useState(false), [removeError, setRemoveError] = useState('')
  const [resendingId, setResendingId] = useState<string | null>(null), [resendError, setResendError] = useState('')
  /* 権限停止・二段階認証の解除が 428 で止まったときの本人確認窓。 */
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)

  /* 送信中の掛け金。state は次の描画まで古いままなので、素早い二度押しの2回目を止められない。 */
  const resendingRef = useRef(false)
  const removingRef = useRef(false)
  // 閲覧専用（代理ログインの見るだけ等）のオーナー・管理者は、変える操作を出さず閲覧のみの形にする。
  const staffRole = useStaffRole()
  const administrator = canManageRole(staffRole)
  usePageTitle(permissionTarget ? `${permissionTarget.name}さんに見せる範囲` : 'ユーザー管理')
  const load = useCallback(async () => {
    const version = ++membersLoadVersion.current
    setLoading(true)
    setError('')
    setSummaryReady(false)
    try {
      const scope = selectedAccountId ?? undefined
      if (!scope) throw new Error('アカウントを選択してください')
      const [staffResult, meResult, accountsResult, usersResult, rolesResult] = await Promise.all([
        api.staff.list(scope),
        loadStaffIdentity(),
        api.lineAccounts.list(),
        api.access.users({ lineAccountId: scope, limit: 200 }),
        api.access.roles(scope),
      ])
      if (version !== membersLoadVersion.current) return
      if (!staffResult.success || !meResult.success || !accountsResult.success || !usersResult.success || !rolesResult.success) {
        throw new Error('必要な情報を読み込めませんでした')
      }
      setMembers(staffResult.data)
      setMembersAccountId(scope)
      setAccountNames(Object.fromEntries(accountsResult.data.map((account) => [account.id, account.name])))
      setAccessUsers(usersResult.data.items)
      setUsersTotal(usersResult.data.pagination?.total ?? usersResult.data.items.length)
      setAccessSummary(usersResult.data.summary)
      setAccessRoles(rolesResult.data.items)
      setSummaryReady(true)
    } catch (saveFailure) {
      if (version !== membersLoadVersion.current) return
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)

      setError('ログインユーザーを読み込めませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      if (version === membersLoadVersion.current) setLoading(false)
    }
  }, [selectedAccountId, saveErrors])
  useEffect(() => { void load() }, [load])
  /*
   * WEB203：ログインユーザーは200人ずつ読む。全員より少ないときは、続きを読み込んで
   * 検索・絞り込み・ページ送りが全員に効くようにする（打ち切りの注意だけで終わらせない）。
   */
  const usersAccountRef = useRef(selectedAccountId)
  usersAccountRef.current = selectedAccountId
  const [moreUsersBusy, setMoreUsersBusy] = useState(false)
  const [moreUsersError, setMoreUsersError] = useState('')
  const loadMoreUsers = async () => {
    if (moreUsersBusy) return
    const scope = selectedAccountId ?? undefined
    const offset = accessUsers.length
    setMoreUsersBusy(true)
    setMoreUsersError('')
    try {
      const result = await api.access.users({ lineAccountId: scope, limit: 200, offset })
      if ((usersAccountRef.current ?? undefined) !== scope) return
      if (!result.success) throw new Error(result.error)
      setAccessUsers((current) => [...current, ...result.data.items.filter((item) => !current.some((known) => known.id === item.id))])
      setUsersTotal(result.data.pagination?.total ?? usersTotal)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setMoreUsersError('続きを読み込めませんでした。もう一度お試しください。') }
    } finally {
      setMoreUsersBusy(false)
    }
  }
  /*
   * 入った記録は「入った記録」タブでだけ読む。最初に全部のタブぶんを
   * 先読みすると、表の中身(LoginAudit)が別に読み直す二重取りになる。
   */
  useEffect(() => {
    if (tab !== 'audit') return
    let alive = true
    setAudits([])
    void api.audit.events({ lineAccountId: selectedAccountId ?? undefined, limit: 200 })
      .then((result) => { if (alive && result.success) setAudits(result.data.items) })
      .catch(() => {})
    return () => { alive = false }
  }, [tab, selectedAccountId])
  const memberById = useMemo(() => {
    const map = new Map(members.map((member) => [member.id, member]))
    for (const user of accessUsers) {
      const member = matchStaffMember(members, user)
      if (member) map.set(user.id, member)
    }
    return map
  }, [accessUsers, members])
  const openPermissions = (user: AccessUserItem) => { setPermissionTarget(user) }
  const finishPermissionSave = async () => {
    await load()
    notifySaved('見せる範囲を保存しました。対象者のすべてのログインを終了したため、新しい権限で使うにはもう一度ログインが必要です。')
  }
  // R499: 他者が先に変えていたら上書きせず、一覧の最新へ戻して知らせる。
  const handlePermissionConflict = async () => {
    await load()
    notifyToast('ほかの管理者が先に権限を変更しました。一覧の最新状態を確認してください。')
  }
  const invitedUsers = accessUsers.filter((user) => user.status === 'invited' || user.status === 'expired')
  // R500: いまいる人タブでは有効・無効を利用状態で絞り込む。招待中タブは従来どおり。
  const tabUsers = tab === 'invited'
    ? invitedUsers
    : accessUsers
      .filter((user) => user.status === 'active' || user.status === 'suspended')
      .filter((user) => (statusFilter === 'all' ? true : user.status === statusFilter))
  /*
   * #620: 名前・メールを1本の文字列へ繋げて照合すると、「花子 x-sato」のような
   * フィールド跨ぎの語でも行が返ってしまう。検索欄の案内どおり、表示中の
   * 各項目（名前・メール・職位）へ個別に照合する。前後の空白は無視する。
   */
  const normalizedQuery = query.trim().toLocaleLowerCase('ja-JP')
  const filteredUsers = tabUsers.filter((user) => {
    const matchesQuery = !normalizedQuery
      || [user.name, user.email, user.jobTitle].some((value) =>
        value?.toLocaleLowerCase('ja-JP').includes(normalizedQuery))
    return matchesQuery
  }).sort((a, b) => (b.lastLoginAt ?? '').localeCompare(a.lastLoginAt ?? ''))
  const pageCount = Math.max(1, Math.ceil(filteredUsers.length / USER_PAGE_SIZE))
  const shown = filteredUsers.slice((userPage - 1) * USER_PAGE_SIZE, userPage * USER_PAGE_SIZE)
  useEffect(() => { setUserPage(1) }, [query, statusFilter, tab])
  const activeAdministratorCount = members.filter(isActiveAdministrator).length
  const missing = Math.max(accessSummary.active - accessSummary.mfaEnabled, 0)
  const canEdit = (member: StaffMember) => Boolean(member.canManageInAccount !== false && (administrator || (staffRole === 'staff' && me?.id === member.id)))
  const openTwoFactor = (member: StaffMember) => { if (member.twoFactorEnabled) { setDisableError(''); setDisablingTarget(member) } else setSettingTwoFactor(member) }
  /**
   * 二段階認証を外す。
   *
   * 処理中は受け付けない。失敗は握りつぶさず、窓の中に運用者の言葉で出す。
   */
  const runDisableTwoFactor = async (stepUpToken?: string) => { if (!disablingTarget || disablingTwoFactor) return; setDisablingTwoFactor(true); setDisableError(''); try { const res = await api.staff.disableTwoFactor(disablingTarget.id, stepUpToken); if (!res.success) throw new Error(res.error); setDisablingTarget(null); await load() } catch (caught) {
    const fieldFailure = saveErrors.capture(caught);
 if (!stepUpToken && isStepUpRequired(caught)) { setStepUp({ purpose: 'staff.two_factor.remove', action: '二段階認証を解除する', retry: runDisableTwoFactor }); return } { if (!fieldFailure) setDisableError('二段階認証を解除できませんでした。状態を読み直してから、もう一度お試しください。') } } finally { setDisablingTwoFactor(false) } }
  /**
   * ログインユーザーを外す。
   *
   * 確認前は停止口を呼ばず、同じ描画中の二度押しも ref で止める。
   * 失敗時はサーバーが返した理由を確認窓に残し、運用者が判断できるようにする。
   */
  const runRemove = async (stepUpToken?: string) => {
    if (!removingTarget || removingRef.current) return
    removingRef.current = true
    setRemoving(true)
    setRemoveError('')
    try {
      const result = await api.staff.delete(removingTarget.id, stepUpToken)
      if (!result.success) throw new Error(result.error)
      setRemovingTarget(null)
      await load()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (!stepUpToken && isStepUpRequired(caught)) { setStepUp({ purpose: 'staff.permissions.change', action: 'スタッフを削除する', retry: runRemove }); return }
      { if (!fieldFailure)
      setRemoveError(messageOf(caught)) }
    } finally {
      removingRef.current = false
      setRemoving(false)
    }
  }
  /**
   * 招待を送り直す(N-425)。
   *
   * 処理中は受け付けない。2回叩くと2本目のトークンで1本目が上書きされ、
   * 先に届いたメールのリンクがその場で死ぬ。見た目を `disabled` にするだけでは
   * 同じ描画の中へ2回届く二度押しを止められないので、掛け金(ref)で締める。
   * 結果と新しい期限・次の対応は表の上の帯に出す。失敗は握りつぶさず理由を出す。
   */
  const runResend = async (member: StaffMember) => {
    if (resendingRef.current) return
    resendingRef.current = true
    setResendingId(member.id)
    setResendError('')
    try {
      const result = await fetchApi<{ success: boolean; data: StaffMemberWithInvite }>(`/api/staff/${member.id}/resend-invitation`, { method: 'POST' })
      const expiry = formatInviteExpiry(result.data.inviteExpiresAt)
      notifyToast(`招待メールを送り直しました。新しい期限は${expiry}です。相手にメールを確認してもらってください。期限内に受諾がなければ、もう一度送り直せます。`)
      await load()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setResendError(`${messageOf(caught)}。状態を読み直してから、もう一度お試しください。`) }
    } finally {
      resendingRef.current = false
      setResendingId(null)
    }
  }
  /*
   * ★V8：行の「…」から止める（絵 「この所属ユーザーを停止しますか？」）・再開する。
   * 今までは「変更する」の窓の中の利用状態の切り替えだけだった。口は同じ（isActive の更新）。
   * 権限・利用状態の変更は 428 で止まるので、本人確認の窓を立てて同じ操作をやり直す。
   */
  const [suspendTarget, setSuspendTarget] = useState<StaffMember | null>(null), [suspending, setSuspending] = useState(false), [suspendError, setSuspendError] = useState('')
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const runSetActive = async (member: StaffMember, active: boolean, stepUpToken?: string): Promise<void> => {
    if (suspending) return
    setSuspending(true)
    setSuspendError('')
    try {
      await api.staff.update(member.id, { isActive: active }, stepUpToken)
      setSuspendTarget(null)
      await load()
      notifyToast(active ? '再開しました。対象者はもう一度ログインが必要です。' : '止めました。「止めた」の絞り込みを押すと、この人を一覧に戻せます。')
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (!stepUpToken && isStepUpRequired(caught)) {
        setStepUp({ purpose: 'staff.permissions.change', action: active ? 'ログインユーザーを再開する' : 'ログインユーザーを止める', retry: (token?: string) => runSetActive(member, active, token) })
        return
      }
      const message = '利用状態を変更できませんでした。状態を読み直してから、もう一度お試しください。'
      if (active) notifyToast(message)
      else { if (!fieldFailure) setSuspendError(message) }
    } finally {
      setSuspending(false)
    }
  }
   const tabAction = administrator && tab === 'audit'
     ? <Button onClick={() => downloadAuditCsv(audits)} disabled={audits.length === 0}>CSVで書き出す</Button>
    : null
  if (permissionTarget) {
    const copyCandidates = accessUsers.filter((candidate): candidate is CopyableAccessUser => (
      candidate.id !== permissionTarget.id && candidate.roleBundle !== 'custom'
    ))
    const permissionMember = memberById.get(permissionTarget.id)
    return <SaveErrorScope errors={saveErrors}><PermissionScopeView user={permissionTarget} memberId={permissionMember?.id ?? null} canSave={Boolean(administrator && !permissionMember?.isAccountCreator && permissionMember?.canManageInAccount !== false)} copyCandidates={copyCandidates} roleCounts={accessSummary.roleCounts} accountNames={accountNames} savedEditKeys={permissionMember?.permissionKeys ?? []} savedViewKeys={permissionMember?.permissionViewKeys ?? []} savedEmailMask={permissionMember?.emailMask ?? null} onClose={() => setPermissionTarget(null)} onSaved={finishPermissionSave} onConflict={handlePermissionConflict} /></SaveErrorScope>
  }
  const viewer = me !== null && !administrator
  const activeCount = accessUsers.filter((user) => user.status === 'active').length
  const suspendedCount = accessUsers.filter((user) => user.status === 'suspended').length
  const roleOf = (user: AccessUserItem): RoleKey => {
    const member = memberById.get(user.id)
    if (!selectedAccountId && (member?.role === 'owner' || (me?.role === 'owner' && me.id === user.id))) return 'owner'
    return user.roleBundle
  }
  const rowMenuItems = (user: AccessUserItem): ActionMenuItem[] => {
    const member = memberById.get(user.id)
    const editable = member ? canEdit(member) && !member.isAccountCreator : false
    const isSelf = Boolean(member && me?.id === member.id)
    const resendable = tab === 'invited' && administrator && member !== undefined && member.inviteStatus !== 'active'
    const close = () => setOpenMenuId(null)
    const items: ActionMenuItem[] = []
    if (editable && member) items.push({ id: 'edit', label: '役割を変える', qaOpen: 'EOTS4-edit', onSelect: () => { close(); router.push(`/staff/edit?id=${encodeURIComponent(member.id)}`) } })
    items.push({ id: 'scope', label: administrator ? '見える画面' : '見える画面を見る', onSelect: () => { close(); openPermissions(user) } })
    if (isSelf && member && editable) items.push({ id: 'two-factor', label: member.twoFactorEnabled ? '二段階認証を解除する' : '二段階認証を設定する', onSelect: () => { close(); openTwoFactor(member) } })
    if (resendable && member) items.push({ id: 'resend', label: 'もう一度送る', disabled: resendingId !== null, disabledReason: resendingId === member.id ? '送信中…' : undefined, onSelect: () => { close(); void runResend(member) } })
    if (administrator && member && !isSelf && !member.isAccountCreator && member.canManageInAccount !== false) {
      const policy = staffActionPolicy({ member, currentUserId: me?.id ?? null, administrator: true, activeAdministratorCount })
      items.push(member.isActive
        ? { id: 'suspend', label: '止める', dividerBefore: true, disabled: Boolean(policy.statusBlockedReason), disabledReason: policy.statusBlockedReason ?? undefined, onSelect: () => { close(); setSuspendError(''); setSuspendTarget(member) } }
        : { id: 'resume', label: '再開する', dividerBefore: true, disabled: suspending, onSelect: () => { close(); void runSetActive(member, true) } })
      items.push({ id: 'remove', label: '削除', tone: 'danger', onSelect: () => { close(); setRemoveError(''); setRemovingTarget(member) } })
    }
    return items
  }
  const sectionTitle = tab === 'invited' ? '招待中' : tab === 'roles' ? '役割と権限' : 'ユーザー'
  const listCard = (
    <section className={styles.card} aria-label={sectionTitle} id="staff-list" data-list-folders={false}>
      <div className={styles.cardHead}>
        <div className={styles.cardHeadText}>
          <h2 className={styles.cardTitle}>{sectionTitle}</h2>
          <div className={styles.cardSubRow}>
            <span className={styles.cardSub}>{summaryReady ? `${formatNumber(filteredUsers.length)}人` : emptyValue('unknown')}</span>
          </div>
        </div>
      </div>
      <GridTable className={`${styles.table} ${viewer ? styles.readOnlyTable : ''}`} framed={false} label={`${sectionTitle}の一覧`} design={{ columns: 'var(--sett-staff-columns)', gap: 'var(--tpl-sa-staff-col-gap)', rowPadding: 'var(--tpl-sa-staff-row-pad)', rowGap: '0', rowHeight: 'var(--tpl-sa-staff-row-h)', headHeight: 'var(--tpl-sa-staff-head-h)', fontSize: 'var(--text-caption)', lineHeight: 'var(--tpl-sa-staff-sub-lh)' }}>
        <GridHeadRow>
          <GridCell className={styles.colPerson} role="columnheader">ユーザー情報</GridCell>
          <GridCell className={styles.colRole} role="columnheader">権限</GridCell>
          <GridCell className={styles.colLast} role="columnheader">最終ログイン</GridCell>
          <GridCell className={styles.colMenu} role="columnheader"><span className={styles.srOnly}>操作</span></GridCell>
        </GridHeadRow>
        {loading ? <p className={styles.stateRow} role="status">ログインユーザーを読み込んでいます…</p>
          : error ? <ListState kind="error" title="ログインユーザーを読み込めませんでした。登録した内容は消えていません。" description="" action={<><Button onClick={() => load()} busyLabel="処理中…">もう一度読み込む</Button></>} />
          : shown.length === 0 ? <p className={styles.stateRow}>{tab === 'invited' && invitedUsers.length === 0 && !normalizedQuery ? (usersTotal > accessUsers.length ? '読み込んだユーザーに招待中の人はいません。続きを読み込んで確認してください。' : '招待中のユーザーはいません。') : '条件に合うログインユーザーはいません。条件を変えてお試しください。'}</p>
          : shown.map((user) => {
            const member = memberById.get(user.id)
            const items = rowMenuItems(user)
            return (
              <GridRow key={user.id}>
                {/* 絵 nku0f：顔・名前・メール。担当のLINEアカウントは列にせず、名前に重ねた説明と「見える画面」で見る。 */}
                <GridNameCell className={styles.colPerson} folder={false} name={<><span className={styles.avatar} aria-hidden="true">{[...avatarInitials(user.name)][0] ?? ''}</span><span className={styles.personText}><button type="button" aria-label={`${user.name}の中身を見る`} data-qa-open="EOTS4" onClick={() => openPermissions(user)} className={styles.personName} title={member ? `${user.name}（担当：${accessScopeLabel(user, accountNames)}）` : `${user.name}（要確認：ログイン情報との結び付けが未確認です）`}>{user.name}{me?.id === user.id ? '（自分）' : ''}</button>{user.email ? <span className={styles.personSub} title={user.email}>{user.email}</span> : null}</span></>} />
                <GridCell className={styles.colRole} role="cell" title={tab === 'invited' && member && member.inviteStatus !== 'active' ? `招待の期限：${formatInviteExpiry((member as StaffMemberWithInvite).inviteExpiresAt)}` : twoFactorState(user).label}>{user.status === 'suspended' ? <StatusBadge tone="neutral" dot={false}>止めた</StatusBadge> : <RoleChip role={roleOf(user)} />}</GridCell>
                <GridCell className={styles.colLast} role="cell" title={user.lastLoginAt ? formatStaffDate(user.lastLoginAt) : undefined}>{lastLoginDay(user.lastLoginAt)}</GridCell>
                <GridCell className={`${styles.colMenu} ${styles.menuBox}`} role="cell">
                  <RowMenu size="row" label={`${user.name}の操作`} items={items} open={openMenuId === user.id} onOpenChange={(next) => setOpenMenuId(next ? user.id : null)} />
                </GridCell>
              </GridRow>
            )
          })}
      </GridTable>
    </section>
  )
  if (editId !== undefined) {
    const member = members.find((member) => member.id === editId)
    if (loading) return <ListState kind="loading" />
    if (!member || !canEdit(member)) return <ListState kind="error" title="このユーザーを編集できません" description="権限とユーザーを確認してください。" />
    return <EditModal surface="page" selectedAccountId={selectedAccountId} member={member} administrator={Boolean(administrator)} currentUserId={me?.id ?? null} activeAdministratorCount={activeAdministratorCount} onClose={() => router.push('/staff')} onSaved={load} />
  }
  return (
    <SaveErrorScope errors={saveErrors}><PageFrame kind="settings" boardId={administrator ? 'nku0f' : 'A35Gh'}>
      <PageHeading
        title="ユーザー管理"
        help="管理画面に入る人と、その人ができることを決めます（管理者の設定はここ）"
        tabs={<Tabs size="compact" label="ユーザー管理の切り替え" items={STAFF_TAB_KEYS.map((item) => ({ label: item.label, href: `/staff?tab=${item.key}`, current: tab === item.key }))} />}
      />
      {viewer ? (
        <div className={styles.viewerBandRow}>
          <ReadOnlyNotice ></ReadOnlyNotice>
        </div>
      ) : null}
      <div className={styles.body}>
        <SettingsInnerNav inline />
        <div className={styles.main}>
          {tab === 'audit' ? (
            <>
              {tabAction ? <div className={styles.toolbar}><span className={styles.spacer} />{tabAction}</div> : null}
              <div data-design-node="jwVlo"><LoginAudit /></div>
            </>
          ) : (
            <>
              <ListToolbar
                search={{ width: 220, label: '名前・メールで探す', placeholder: '名前・メールで探す', value: query, onChange: setQuery }}
                filters={tab === 'members' ? (
                  <SegmentedControl<'active' | 'suspended' | 'all'>
                    aria-label="利用状態で絞り込む"
                    fit="content"
                    value={statusFilter}
                    onChange={setStatusFilter}
                    options={[
                      { value: 'active', label: '有効', count: summaryReady ? activeCount : undefined },
                      { value: 'suspended', label: '止めた', count: summaryReady ? suspendedCount : undefined },
                      { value: 'all', label: 'すべて' },
                    ]}
                  />
                ) : null}
                trailing={administrator ? (
                  <Button href="/staff/new" variant="primary"><UserPlus size={16} aria-hidden="true" />招待する</Button>
                ) : (
                  /* 閲覧のみには押せないボタンを置かない。場所だけ空ける（下の物を詰めない）。 */
                  <span className={styles.inviteSpace} aria-hidden="true" />
                )}
              />
              {resendError ? <Notice tone="danger" message={resendError} /> : null}
              {tab === 'roles' ? (
                <div className={styles.roleCards}>
                  {accessRoles.map((role) => (
                    <div key={role.id} className={styles.roleCard}>
                      <p className={styles.roleCardHead}><span>{role.name}</span><span className={styles.roleCount}>{`${formatNumber(role.assignedUserCount)} 人`}</span></p>
                      <p className={styles.roleCardBody}>{role.description}</p>
                      <p className={styles.roleCardFoot}>{role.requiresMfa ? '二段階認証が必要' : role.featureAccess === 'view' ? '閲覧のみ' : role.featureAccess === 'custom' ? '機能ごとに設定' : '編集できる'}</p>
                    </div>
                  ))}
                </div>
              ) : null}
              {listCard}
              {tab === 'members' && missing > 0 ? <p className={styles.cardWarn}>{`二段階認証が未設定の人が ${missing}人 います。高い権限の人から設定してください。`}</p> : null}
              {!loading && !error ? (
                <div className={styles.listFoot}>
                  <p>{`ユーザー ${formatNumber(filteredUsers.length)} 人中 ${formatNumber(shown.length)} 人を表示${usersTotal > accessUsers.length ? `（全${formatNumber(usersTotal)} 人中${formatNumber(accessUsers.length)} 人まで読み込み）` : ''}`}</p>
                  {usersTotal > accessUsers.length ? (
                    <Button variant="secondary" size="compact" onClick={() => void loadMoreUsers()} disabled={moreUsersBusy} busy={moreUsersBusy}>続きを読み込む</Button>
                  ) : null}
                  {moreUsersError ? <Notice tone="danger" >{moreUsersError}</Notice> : null}
                  <Pagination page={userPage} pageCount={pageCount} onPageChange={setUserPage} correctOutOfRange={!loading && !error} />
                </div>
              ) : null}
              {tab === 'members' ? <Disclosure appearance="inset" size="compact" title="ログイン中の端末を確認"><SessionsCard /></Disclosure> : null}
              {administrator && tab === 'roles' ? <MfaPolicy compact key={selectedAccountId ?? 'unselected'} accountMembers={summaryReady && !loading && membersAccountId === selectedAccountId ? members : null} /> : null}
            </>
          )}
        </div>
        {tab === 'members' ? (
          <aside className={styles.aside} aria-label="補足">
            <SelfSecurity />
          </aside>
        ) : null}
      </div>
      {editing && <EditModal selectedAccountId={selectedAccountId} member={editing} administrator={Boolean(administrator)} currentUserId={me?.id ?? null} activeAdministratorCount={activeAdministratorCount} onClose={() => setEditing(null)} onSaved={load} />}
      {settingTwoFactor && <TwoFactorModal member={settingTwoFactor} onClose={() => setSettingTwoFactor(null)} />}
      <Dialog
        open={suspendTarget !== null}
        designWidth={480}
        designTop={305}
        title="この所属ユーザーを停止しますか？"
        description={suspendTarget ? `${suspendTarget.name}（${ROLE_LABEL[suspendTarget.role] ?? suspendTarget.role}・${suspendTarget.assignedLineAccountId ? (accountNames[suspendTarget.assignedLineAccountId] ?? '担当アカウント') : 'すべてのLINEアカウント'}）` : ''}
        tone="destructive"
        confirmation
        confirmLabel="停止する"
        busy={suspending}
        error={suspendError || undefined}
        onConfirm={() => { if (suspendTarget) void runSetActive(suspendTarget, false) }}
        onCancel={() => { if (suspending) return; setSuspendTarget(null); setSuspendError('') }}
      >
        <p className={styles.suspendNote}>名簿には残り、再開できます。ログインの権限は変わりません。</p>
      </Dialog>
      {/* 設定し直せる操作なので赤にしない。赤は本当に戻せない操作のために空けておく。 */}
      <ConfirmDialog
        open={disablingTarget !== null}
        title={disablingTarget ? `${disablingTarget.name} の二段階認証を解除しますか？` : ''}
        description="このユーザーはLINEログインだけでログインできるようになります。登録済みの認証アプリは使えなくなります。あとから「二段階認証を設定する」で、設定し直せます。"
        confirmLabel="解除する"
        busy={disablingTwoFactor}
        error={disableError}
        onConfirm={() => runDisableTwoFactor()}
        onCancel={() => { if (disablingTwoFactor) return; setDisablingTarget(null); setDisableError('') }}
      >
        <p className={styles.dialogNote}>解除しても、権限・担当範囲・ログインの記録は変わりません。</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={removingTarget !== null}
        title={removingTarget ? `${removingTarget.name} をログインユーザーから外しますか？` : ''}
        description="このユーザーは管理画面へログインできなくなります。内容を確認してから実行してください。"
        confirmLabel="外す"
        busy={removing}
        error={removeError}
        onConfirm={() => runRemove()}
        onCancel={() => { if (removing) return; setRemovingTarget(null); setRemoveError('') }}
      >
        <p className={styles.dialogNote}>これまでの設定と操作記録は残ります。</p>
      </ConfirmDialog>
      {stepUp && <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} />}
    </PageFrame></SaveErrorScope>
  )
}

export default function StaffV8() {
  return <Suspense fallback={<div className="text-sm text-ink-faint">読み込み中…</div>}><StaffPageHost /></Suspense>
}

export function StaffEditV8() { return <StaffPageHost editId={useSearchParams().get('id') ?? ''} /> }
