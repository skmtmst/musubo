'use client'

import { useRef, useState } from 'react'
import MenuPortal from '@/components/shared/menu-portal'
import Notice from '@/components/shared/notice'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextField as SharedTextField } from '@/components/shared/text-field'

/**
 * 受信箱のプルダウン。
 *
 * **共通の `Select` は使えない。** 設計（Pencil `lJ1CF` 担当者プルダウン
 * 開状態、`k6lHgo` ヘッダー対応状況プルダウン開状態）は、共通部品
 * （`Gfsb4`）と作りが違う。
 *
 * - 担当者 … 選択肢の上に**名前で絞る入力欄**がある。担当が増えるほど
 *   縦に伸びるので、探す手段が要る
 * - 対応状況 … 1件ずつに**色の丸と色付きの札**が付く。未対応が赤、
 *   対応中が黄、対応済みが緑。文字だけだと、一覧の札と目で結びつかない
 *
 * 素の `<select>` にしていたころは、開いた中身がブラウザ任せで
 * **画像に写らなかった**。設計の 2-8 / 2-9 / 2-10 は「開いた状態」なので、
 * 素のセレクトのままでは永久に見比べられない。
 */

/**
 * 外側を押したら閉じる・Esc で閉じる・置き場所（カード・表・帯）の中でも
 * 切れない。開くボタンの器を基準に、最上層（portal）へ出す。
 */
function FloatingPanel({
  open,
  getAnchor,
  onClose,
  align,
  matchWidth,
  label,
  panelClassName,
  children,
}: {
  open: boolean
  getAnchor: () => HTMLElement | null
  onClose: () => void
  align: 'start' | 'end'
  matchWidth?: boolean | 'min'
  label: string
  /** 箱の見た目（幅・余白）。位置の指定（absolute・z・mt）は器が決める。 */
  panelClassName: string
  children: React.ReactNode
}) {
  return (
    <MenuPortal open={open} align={align} matchWidth={matchWidth} getAnchor={getAnchor} onClose={onClose}>
      <div
        role="listbox"
        aria-label={label}
        className={panelClassName}
        // 最上層では absolute 指定を無効にする（位置は器が決める）。
        style={{ position: 'static' }}
      >
        {children}
      </div>
    </MenuPortal>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={open ? 'rotate-180' : undefined}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function Check() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

/* 位置（absolute・z・mt）は器（MenuPortal）が決める。ここは箱の見た目だけ。 */
const panelClass = 'border-hairline rounded-control bg-canvas min-w-full overflow-hidden border shadow-float'
const rowClass = 'flex w-full items-center gap-2 px-3 py-2 text-left text-xs'

// ─────────────────────────────────────────────────────────────
// 担当者
// ─────────────────────────────────────────────────────────────

export type OperatorOption = { id: string; name: string; disabled?: boolean }

export function buildOperatorRows(
  operators: OperatorOption[],
  allowAll: boolean,
  currentValue?: string,
): OperatorOption[] {
  const ordered = [...operators].sort((a, b) => a.name.localeCompare(b.name, 'ja'))

  if (allowAll) {
    return [
      { id: 'all', name: 'すべて' },
      { id: 'unassigned', name: '未割り当て' },
      ...ordered,
    ]
  }

  /*
    担当変更では、いまの担当を先頭にしてからほかの担当者を並べる。
    最後に「未割り当て」を置く。設計 `L35UOV` と同じ順で、現在値を
    探し直さずに確認できる。
  */
  if (currentValue && currentValue !== 'unassigned') {
    if (!ordered.some(item => item.id === currentValue)) ordered.unshift({ id: currentValue, name: '担当者不明', disabled: true })
    ordered.sort((a, b) => Number(b.id === currentValue) - Number(a.id === currentValue))
  }
  return [...ordered, { id: 'unassigned', name: '未割り当て' }]
}

function OperatorMark({ option }: { option: OperatorOption }) {
  const mark = option.id === 'unassigned'
    ? '－'
    : Array.from(option.name.trim())[0] ?? '—'

  return (
    <span
      aria-hidden="true"
      className="border-hairline bg-canvas-sunken text-ink-secondary inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill border text-xs font-medium"
    >
      {mark}
    </span>
  )
}

export function OperatorDropdown({
  value,
  operators,
  onChange,
  label = '担当',
  ariaLabel = '担当者を選ぶ',
  allowAll = true,
  compact = false,
  unreadOf,
  unreadUnavailable = false,
}: {
  /** `all` すべて / `unassigned` 未割り当て / それ以外は担当者ID */
  value: string
  operators: OperatorOption[]
  onChange: (next: string) => void
  label?: string
  ariaLabel?: string
  /** 一覧の絞り込みでは true。担当者を変更するときは「すべて」を選べないので false。 */
  allowAll?: boolean
  /** 顧客情報欄を開いた狭い中央列では、名前を省いて操作列を1行に保つ。 */
  compact?: boolean
  /**
   * 行に添える未読数。**渡さなければ数を出さない**（担当を変える口など、
   * 未読数が要らない場面で使うため）。
   * `null` を返したら**未取得**で、`—` を出す。**0とは別。**
   */
  unreadOf?: (value: string) => number | null
  /** 集計に失敗したとき、0件とは違うことと次の行動を本文で伝える。 */
  unreadUnavailable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  const rows = buildOperatorRows(operators, allowAll, value)
  // 名前で絞る。**大文字小文字を区別しない。** 「Kenta」と打っても出る。
  const shown = query.trim()
    ? rows.filter((row) => row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    : rows
  const current = rows.find((row) => row.id === value)

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
        title={`${label}：${current?.name ?? (allowAll ? 'すべて' : '未割り当て')}`}
        className={`border-hairline rounded-control bg-canvas text-ink flex h-10 w-full items-center gap-1.5 whitespace-nowrap border px-2.5 text-xs ${open ? 'border-accent' : ''}`}
      >
        {compact ? (
          <>
            {current && current.id !== 'all' ? <span className="2xl:hidden"><OperatorMark option={current} /></span> : null}
            <span className="font-medium 2xl:hidden">{label}</span>
            <span className="hidden truncate font-medium 2xl:inline">
              {label}：{current?.name ?? (allowAll ? 'すべて' : '未割り当て')}
            </span>
          </>
        ) : (
          <>
            <span className="text-ink-faint">{label}：</span>
            <span className="truncate font-medium">{current?.name ?? (allowAll ? 'すべて' : '未割り当て')}</span>
          </>
        )}
        <span className="text-ink-faint ml-auto"><Chevron open={open} /></span>
      </button>
      {open ? (
        <FloatingPanel
          open={open}
          align="start"
          matchWidth="min"
          getAnchor={() => wrapRef.current}
          onClose={() => setOpen(false)}
          label={ariaLabel ?? '担当'}
          panelClassName={panelClass}
        >
          {/* 担当が増えるほど縦に伸びる。探す手段が無いと使えない。 */}
          <div className="border-hairline border-b p-2">
            <SaveErrorField names={["query"]}><SharedTextField
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="担当者名を検索"
              aria-label="担当者名を検索"
              className="border-hairline rounded-control text-ink placeholder:text-ink-faint w-full border px-2 py-1 text-xs outline-none"
            /></SaveErrorField>
          </div>
          {shown.length === 0 ? (
            <p className="text-ink-faint px-3 py-3 text-xs">見つかりません</p>
          ) : shown.map((row) => {
            const selected = row.id === value
            /*
              **「すべて」には数を付けない**（担当者ではないため）。
              未取得は `—`。0と同じ文字にすると、**誰にも未読が無いのか
              読めていないのかが見分けられなくなる。**
            */
            const unread = unreadOf && row.id !== 'all' ? unreadOf(row.id) : undefined
            return (
              <button
                key={row.id}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={row.disabled}
                onClick={() => { onChange(row.id); setOpen(false); setQuery('') }}
                className={`${rowClass} ${selected ? 'bg-accent-soft text-accent-deep font-medium' : 'text-ink hover:bg-canvas-sunken'}`}
              >
                {row.id === 'all'
                  ? <span aria-hidden="true" className="block h-6 w-6 shrink-0" />
                  : <OperatorMark option={row} />}
                <span className="min-w-0 flex-1 truncate text-left">{row.name}</span>
                {unread === undefined ? null : (
                  <span className={`shrink-0 tabular-nums ${selected ? 'text-accent-deep' : 'text-ink-faint'}`}>
                    {unread === null ? '—' : unread}
                  </span>
                )}
                <span className={`text-accent-deep shrink-0 ${selected ? '' : 'invisible'}`}><Check /></span>
              </button>
            )
          })}
          {unreadUnavailable ? (
            <Notice tone="warn">
              <p className="font-bold">未読の数をいま数えられません</p>
              <p className="mt-1">
                担当者は選べます。数だけが取れていないので「—」にしています。0件とは違います。少し待ってからもう一度開いてください。
              </p>
            </Notice>
          ) : null}
        </FloatingPanel>
      ) : null}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// 対応状況
// ─────────────────────────────────────────────────────────────

export type ChatStatus = 'unread' | 'in_progress' | 'on_hold' | 'resolved'

/**
 * 状態ごとの色。**一覧の札と同じ色を使う。**
 * ここだけ別の色にすると、開いて選んだものと一覧に出るものが結びつかない。
 */
const STATUS_STYLE: Record<ChatStatus, { label: string; dot: string; pill: string }> = {
  unread: { label: '未対応', dot: 'bg-danger', pill: 'bg-danger-bg text-danger' },
  in_progress: { label: '対応中', dot: 'bg-warning', pill: 'bg-warning-bg text-warning' },
  on_hold: { label: '保留', dot: 'bg-info', pill: 'bg-info-bg text-info' },
  resolved: { label: '対応済み', dot: 'bg-accent', pill: 'bg-accent-soft text-accent-deep' },
}

const STATUS_ORDER: ChatStatus[] = ['unread', 'in_progress', 'on_hold', 'resolved']

export function StatusDropdown({
  value,
  onChange,
  ariaLabel = '対応状況を変更する',
}: {
  value: ChatStatus
  onChange: (next: ChatStatus) => void
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const current = STATUS_STYLE[value]

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
        className={`border-hairline rounded-control bg-canvas flex h-10 shrink-0 items-center gap-1.5 whitespace-nowrap border px-2.5 text-xs ${open ? 'border-accent' : ''}`}
      >
        <span className={`h-2 w-2 rounded-pill ${current.dot}`} aria-hidden="true" />
        <span className="font-semibold">{current.label}</span>
        <span className="text-ink-faint"><Chevron open={open} /></span>
      </button>
      {open ? (
        <FloatingPanel
          open={open}
          align="end"
          matchWidth="min"
          getAnchor={() => wrapRef.current}
          onClose={() => setOpen(false)}
          label={ariaLabel}
          panelClassName={`${panelClass} right-0`}
        >
          {STATUS_ORDER.map((status) => {
            const style = STATUS_STYLE[status]
            const selected = status === value
            return (
              <button
                key={status}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => { onChange(status); setOpen(false) }}
                className={`${rowClass} whitespace-nowrap ${selected ? 'bg-canvas-sunken' : 'hover:bg-canvas-sunken'}`}
              >
                <span className={`h-2.5 w-2.5 shrink-0 rounded-pill ${style.dot}`} aria-hidden="true" />
                <span className={`rounded-pill px-2 py-0.5 text-micro font-medium ${style.pill}`}>{style.label}</span>
                <span className={`text-accent-deep ml-auto ${selected ? '' : 'invisible'}`}><Check /></span>
              </button>
            )
          })}
        </FloatingPanel>
      ) : null}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// テンプレートの置き場
// ─────────────────────────────────────────────────────────────

export type FolderOption = { id: string; name: string; count: number }

/**
 * テンプレートの置き場を選ぶ（設計 Pencil `esGzX` すべてのフォルダ・ドロップダウン）。
 *
 * 素の `<select>` にしていたころは、**開いた中身が画像に写らなかった**。
 * 設計の 2-6（全フォルダ展開）と 2-11（予約フォルダ）は「開いた状態」なので、
 * 素のセレクトのままでは見比べられない。
 *
 * 中身は 検索欄 ＋「すべてのフォルダ」＋ 置き場ごとの件数。
 * **件数を出す。** ひな形が20枚あるとき、どこに何枚あるかが分からないと
 * 「予約」を開くべきかどうかが決められない。
 */
export function FolderDropdown({
  value,
  folders,
  totalCount,
  onChange,
  ariaLabel = 'フォルダ',
}: {
  /** 空文字はすべてのフォルダ */
  value: string
  folders: FolderOption[]
  totalCount: number
  onChange: (next: string) => void
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const wrapRef = useRef<HTMLDivElement>(null)

  const shown = query.trim()
    ? folders.filter((folder) => folder.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    : folders
  const current = folders.find((folder) => folder.id === value)

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((now) => !now)}
        className={`border-hairline rounded-control bg-canvas text-ink flex w-full items-center gap-2 border px-3 py-2.5 text-sm font-medium ${open ? 'border-accent' : ''}`}
      >
        <span className="truncate">
          {current ? `${current.name}（${current.count}）` : `すべてのフォルダ（${totalCount}）`}
        </span>
        <span className="text-ink-faint ml-auto"><Chevron open={open} /></span>
      </button>
      {open ? (
        <FloatingPanel
          open={open}
          align="end"
          getAnchor={() => wrapRef.current}
          onClose={() => setOpen(false)}
          label={ariaLabel}
          panelClassName={`${panelClass} right-0 w-70`}
        >
          <div className="border-hairline border-b p-2">
            <SaveErrorField names={["query"]}><SharedTextField
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="フォルダを検索"
              aria-label="フォルダを検索"
              className="border-hairline rounded-control text-ink placeholder:text-ink-faint w-full border px-2 py-1.5 text-xs outline-none"
            /></SaveErrorField>
          </div>
          <button
            type="button"
            role="option"
            aria-selected={value === ''}
            onClick={() => { onChange(''); setOpen(false); setQuery('') }}
            className={`${rowClass} justify-between ${value === '' ? 'bg-accent-soft text-accent-deep font-medium' : 'text-ink hover:bg-canvas-sunken'}`}
          >
            <span className="truncate">すべてのフォルダ</span>
            <span className="tabular-nums">{totalCount}</span>
          </button>
          {shown.map((folder) => {
            const selected = folder.id === value
            return (
              <button
                key={folder.id}
                type="button"
                role="option"
                // 分類のチップにも同じ名前（「予約」など）が出る。
                // どちらを指しているか読み上げでも試験でも分かるようにする。
                aria-label={`フォルダ ${folder.name}`}
                aria-selected={selected}
                onClick={() => { onChange(folder.id); setOpen(false); setQuery('') }}
                className={`${rowClass} justify-between ${selected ? 'bg-accent-soft text-accent-deep font-medium' : 'text-ink hover:bg-canvas-sunken'}`}
              >
                <span className="truncate">{folder.name}</span>
                <span className="text-ink-faint tabular-nums">{folder.count}</span>
              </button>
            )
          })}
          {shown.length === 0 ? <p className="text-ink-faint px-3 py-3 text-xs">見つかりません</p> : null}
        </FloatingPanel>
      ) : null}
    </div>
  )
}
