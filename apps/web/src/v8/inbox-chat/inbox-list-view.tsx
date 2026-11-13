'use client'
import { RefreshCover } from '@/components/shared/refresh-cover'
import { formatNumber } from '@/lib/format'
import ChatListWindow, { type ChatListWindowItem } from '@/components/chats/chat-list-window';
import InboxFilterPanel from '@/components/chats/inbox-filter-panel';
import SavedViewDialog, { type SavedViewDraft, type SavedViewSaveResult } from '@/components/chats/saved-view-dialog';
import Avatar from '@/components/shared/avatar';
import Button from '@/components/shared/button';
import IconButton from '@/components/shared/icon-button';
import SegmentedControl from '@/components/shared/segmented';
import { InboxFloatingPanel } from '@/components/shared/inbox-content';
import { InboxHistoryButton, InboxListAttention, InboxListHeader, InboxListHeadline, InboxListRow, InboxListSearch } from '@/components/shared/inbox-list';
import { InboxListEmpty, InboxListFailure } from '@/components/shared/inbox-list-states';
import { RowMenu } from '@/components/shared/row-actions';
import SearchField from '@/components/shared/search-field';
import { DelayedSkeleton, SkeletonRow } from '@/components/shared/skeleton';
import { InboxListPane } from '@/components/templates/inbox-page';
import { PageTitle } from '@/components/templates/page-frame';
import { api, type ChatListItem } from '@/lib/api';
import { SEARCH_QUERY_MAX_LENGTH, clampSearchQuery } from '@/lib/search-query';
import { formatListRecent, formatListRecentTitle } from '@/lib/format';
import InboxRulesPopover from '@/v8/inbox-chat/rules-popover';
import { ArrowUpDown, Bookmark, ListFilter } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import ActionMenu from '@/components/shared/action-menu';
import { ChannelBadge, EmailInboxItem, INBOX_SORT_OPTIONS, InboxSavedView, InboxSort, StatusFilter, buildInboxUrl, formatWaitingDuration, sameYmd } from './inbox-model';
import { chatListPreview } from './list-preview';
import styles from './list-parts.module.css';
import { savedViewSummary } from './saved-view-summary';
import { normalizeSavedViewConditions } from './saved-view-types';
import { SlaBadge, assigneeLabel, type ChatSlaFields } from './sla';

type Props = {
  unreadOnly: boolean
  selectedChatId: string | null
  selectedThreadId: string | null
  setFilterOpen: Dispatch<SetStateAction<boolean>>
  filterOpen: boolean
  setSavedViewsOpen: Dispatch<SetStateAction<boolean>>
  setSavedViewError: Dispatch<SetStateAction<string>>
  savedViewsOpen: boolean
  savedViews: InboxSavedView[]
  applySavedView: (view: InboxSavedView) => void
  operatorNames: Map<string, string>
  setSavedViewMenuId: Dispatch<SetStateAction<string | null>>
  savedViewMenuId: string | null
  selectedAccountId: string | null
  loadSavedViews: () => Promise<void>
  setSavedViewSuccess: Dispatch<SetStateAction<boolean>>
  setSaveDialogOpen: Dispatch<SetStateAction<boolean>>
  savedViewError: string
  setSlaReload: Dispatch<SetStateAction<number>>
  slaEnabled: boolean
  overdueTotal: number | null
  quickFilter: "all" | "reply" | "overdue"
  setQuickFilter: Dispatch<SetStateAction<"all" | "reply" | "overdue">>
  dropSavedViewParam: () => void
  quickCountsNow: { all: number; reply: number; overdue: number; } | null
  saveDialogOpen: boolean
  statusFilter: StatusFilter
  assigneeFilter: string
  operators: { id: string; name: string; }[]
  savingView: boolean
  setSavedViewName: Dispatch<SetStateAction<string>>
  createSavedView: (draft?: SavedViewDraft) => Promise<SavedViewSaveResult>
  showTemplatePicker: boolean
  setStatusFilter: Dispatch<SetStateAction<StatusFilter>>
  setAssigneeFilter: Dispatch<SetStateAction<string>>
  setUnreadOnly: Dispatch<SetStateAction<boolean>>
  channel: "email" | "all" | "line"
  emailInboxEnabled: boolean
  router: ReturnType<typeof useRouter>
  nameQuery: string
  setNameQuery: Dispatch<SetStateAction<string>>
  assigneeUnreadStatus: "error" | "ready" | "loading"
  assigneeUnread: { operatorId: string | null; operatorName: string | null; unread: number; }[] | null
  listScrollRef: RefObject<HTMLDivElement | null>
  emailError: string
  loadEmails: (offset?: number, append?: boolean) => Promise<void>
  chatListFailed: boolean
  loadChats: () => Promise<void>
  emailItems: EmailInboxItem[]
  chats: ChatListItem[]
  handleSelectChat: (chatId: string) => void
  handleSelectEmail: (threadId: string) => void
  inboxListLoading: boolean
  inboxListRefreshing: boolean
  hasMoreChats: boolean
  hasMoreEmails: boolean
  inboxListFailed: boolean
  hasInboxFilters: boolean
  clearInboxFilters: () => void
  loadingMore: boolean
  loadMoreChats: () => Promise<void>
  loadingMoreEmails: boolean
  sortOrder: InboxSort
  setSortOrder: (next: InboxSort) => void
}

export default function InboxList({ unreadOnly, selectedChatId, selectedThreadId, setFilterOpen, filterOpen, setSavedViewsOpen, setSavedViewError, savedViewsOpen, savedViews, applySavedView, operatorNames, setSavedViewMenuId, savedViewMenuId, selectedAccountId, loadSavedViews, setSavedViewSuccess, setSaveDialogOpen, savedViewError, setSlaReload, slaEnabled, overdueTotal, quickFilter, setQuickFilter, dropSavedViewParam, quickCountsNow, saveDialogOpen, statusFilter, assigneeFilter, operators, savingView, setSavedViewName, createSavedView, showTemplatePicker, setStatusFilter, setAssigneeFilter, setUnreadOnly, channel, emailInboxEnabled, router, nameQuery, setNameQuery, assigneeUnreadStatus, assigneeUnread, listScrollRef, emailError, loadEmails, chatListFailed, loadChats, emailItems, chats, handleSelectChat, handleSelectEmail, inboxListLoading, inboxListRefreshing, hasMoreChats, hasMoreEmails, inboxListFailed, hasInboxFilters, clearInboxFilters, loadingMore, loadMoreChats, loadingMoreEmails, sortOrder, setSortOrder }: Props) {
  // 緑の点は目で見る印。読み上げには名前で絞り込み中を伝える。
  const savedSearchLabel = hasInboxFilters ? '保存した検索（絞り込み中）' : '保存した検索'
  // 並びは題の横の印から選ぶ。選んだ並びは吹き出しとメニューの ✓ で分かるようにする。
  const [sortMenuOpen, setSortMenuOpen] = useState(false)
  const sortButtonRef = useRef<HTMLButtonElement>(null)
  const savedSearchRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!savedViewsOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || savedViewMenuId) return
      setSavedViewsOpen(false)
      savedSearchRef.current?.querySelector<HTMLButtonElement>('button[aria-expanded]')?.focus()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (savedViewMenuId && event.target instanceof Element && event.target.closest('[data-menu-portal]')) return
      if (event.target instanceof Node && !savedSearchRef.current?.contains(event.target)) {
        setSavedViewsOpen(false)
        setSavedViewMenuId(null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [savedViewsOpen, savedViewMenuId, setSavedViewsOpen, setSavedViewMenuId])
  const sortLabel = INBOX_SORT_OPTIONS.find((option) => option.value === sortOrder)?.label ?? INBOX_SORT_OPTIONS[0].label
  return (<InboxListPane selected={Boolean(selectedChatId || selectedThreadId)}>
    {/* タブ (すべて / 未読 / 対応中 / 対応済み) は意図的に削除。直近メッセージが見やすい LINE 風一覧を優先。 */}

    <InboxListHeader
      data-design="Filters"
      data-inbox-v4="quick-filters"
      aria-label="受信箱のクイック絞り込み"
    >
      <InboxListHeadline><PageTitle>受信箱</PageTitle>
        {/*
          設計 `xGLVe` は「絞り込み」と「保存した検索」を右に並べ、押すと
          右から420pxのパネルが出る（`bXyEA`）。

          以前は `<details>` の小さな箱（208px）で、中身は対応状況だけだった。
          設計は 対応状況・担当者・受信経路・期限・メッセージ種別・未読だけ の
          6項目。**箱が小さいと、置ける条件の数が先に決まってしまう。**
        */}
        <IconButton variant="plain" aria-label="絞り込み" title="絞り込み" onClick={() => setFilterOpen(true)} aria-expanded={filterOpen}>
          <ListFilter aria-hidden size={16} />
        </IconButton>
        {/*
          INBOX-11: メニューは「保存した検索」ボタンではなく、画面幅いっぱいの
          この行（section.relative）を基準に右端を合わせる。ボタン基準の
          right-0 だと、狭い画面でボタンが左に折り返されたときパネルの
          左側が画面外へ出た。幅も画面の左右16px以内に収める。
        */}
        <div ref={savedSearchRef}>
          {/* m22c: 左の札と同じ高さ32にそろえる（行の上端を1つに保つ）。v8 では札が 36 なので同じく 36。 */}
          <IconButton
            variant="plain"
            className={styles.toolDotWrap} aria-label={savedSearchLabel} title={savedSearchLabel}
            onClick={() => {
              setSavedViewsOpen((open) => !open)
              setSavedViewError('')
            }}
            aria-expanded={savedViewsOpen}
          >
            <Bookmark aria-hidden size={16} />
            {hasInboxFilters ? <span aria-hidden="true" className={styles.toolDot} /> : null}
          </IconButton>
          <InboxFloatingPanel open={savedViewsOpen} placement="below">
              <p className="text-ink text-sm font-bold">保存した検索</p>
              <div className="mt-3 space-y-1">
                {savedViews.length === 0 ? (
                  <p className="bg-canvas-sunken text-ink-faint rounded-control px-3 py-3 text-xs">
                    まだ保存した検索はありません。
                  </p>
                ) : savedViews.map((view) => (
                  <div key={view.id} className="hover:bg-canvas-sunken flex items-center gap-2 rounded-control px-2 py-1.5">
                    <button
                      type="button"
                      onClick={() => applySavedView(view)}
                      className="text-ink min-w-0 flex-1 truncate text-left text-xs font-semibold"
                      title={view.name}
                    >
                      {view.name}{view.isShared ? '（共有）' : ''}
                      {/*
                        **名前の下に、何で絞ったかを出す。**
                        設計 `ASsb3` は「対応マーク：未対応／期限：超過」のように書く。
                        名前だけだと、`未対応・期限超過` と `見本担当の未対応` の
                        どちらを押せばいいのかが、名前の付け方頼みになる。
                      */}
                      <span className="text-ink-faint mt-0.5 block truncate text-micro font-medium">
                        {savedViewSummary(normalizeSavedViewConditions(view.conditions), operatorNames)}
                      </span>
                    </button>
                    <span className="text-ink-secondary shrink-0 text-xs tabular-nums">
                      {typeof view.matchCount === 'number' ? `${formatNumber(view.matchCount)}件` : '—件'}
                    </span>
                    <div className="relative shrink-0">
                      <RowMenu
                        label={`${view.name}の操作`}
                        triggerProps={{ 'data-qa-open': view.id === savedViews[0]?.id ? 'ASsb3-menu' : undefined }}
                        onOpenChange={(open) => setSavedViewMenuId(open ? view.id : null)}
                        open={savedViewMenuId === view.id}
                        items={[
                          {
                            id: `${view.id}-delete`,
                            label: '保存した検索を削除',
                            tone: 'danger',
                            onSelect: () => {
                              void (async () => {
                                if (!selectedAccountId) return
                                await api.chats.savedViews.delete(view.id, selectedAccountId)
                                setSavedViewMenuId(null)
                                await loadSavedViews()
                              })()
                            },
                          },
                        ]}
                      />
                    </div>
                  </div>
                ))}
              </div>
              {savedViews.some((view) => typeof view.matchCount !== 'number') ? (
                <p className="text-ink-faint mt-2 text-xs leading-relaxed">
                  該当件数は、保存した条件ごとの集計が接続されると表示されます。「—件」は0件ではありません。
                </p>
              ) : null}
              {/*
                前はここに名前の入力欄と保存ボタンが直接並んでいた。
                **何を保存しようとしているのかが書いていない**ので、絞り込みを
                変えたつもりで前の条件を保存してしまう。設計（`Ln4zS`）は
                名前と「保存する条件」を並べて見せてから保存させる。
              */}
              <div className="border-hairline mt-3 border-t pt-3">
                <Button variant="primary" type="button" onClick={() => {
                  setSavedViewSuccess(false)
                  setSaveDialogOpen(true)
                }}>
                  今の条件を保存する
                </Button>
                {savedViewError && <p className="mt-1.5 text-xs text-danger">{savedViewError}</p>}
              </div>
            </InboxFloatingPanel>
        </div>
        {/* m22c: 左の札と同じ高さ32にそろえる（行の上端を1つに保つ）。v8 では札が 36 なので同じく 36。 */}
        {(
          /*
           * ★V8：絵（XqSvX）の「対応ルール」は settings-2 の印。押してもページを移らず、
           * その場で小窓を開く（オーナー指摘：別のページへ飛ぶのはおかしい）。
           */
          <InboxRulesPopover accountId={selectedAccountId ?? null} onRoutingSaved={() => setSlaReload((n) => n + 1)} />
        )}
        {!slaEnabled ? (
          <>
            <IconButton variant="plain" ref={sortButtonRef} aria-label="並び順" title={`並び順：${sortLabel}`} aria-haspopup="menu" aria-expanded={sortMenuOpen} onClick={() => setSortMenuOpen((open) => !open)}>
              <ArrowUpDown aria-hidden size={16} />
            </IconButton>
            <ActionMenu
              open={sortMenuOpen}
              anchorRef={sortButtonRef}
              ariaLabel="並び順"
              onClose={() => setSortMenuOpen(false)}
              items={INBOX_SORT_OPTIONS.map((option) => ({
                id: option.value,
                label: option.value === sortOrder ? `✓ ${option.label}` : option.label,
                'aria-label': option.value === sortOrder ? `${option.label}（選択中）` : option.label,
                icon: null,
                onSelect: () => { setSortMenuOpen(false); setSortOrder(option.value) },
              }))}
            />
          </>
        ) : null}
      </InboxListHeadline>
      <SegmentedControl<'all' | 'reply' | 'overdue'>
        aria-label="受信箱のクイック絞り込み"
        equalWidth={false}
        value={quickFilter}
        onChange={(next) => { setQuickFilter(next); dropSavedViewParam() }}
        options={[
          { key: 'all' as const, label: 'すべて' },
          { key: 'reply' as const, label: '要返信' },
          slaEnabled
            ? { key: 'overdue' as const, label: '期限超過' }
            : { key: 'overdue' as const, label: '1時間以上待ち' },
        ].map((filter) => ({
          value: filter.key,
          label: filter.label,
          count: slaEnabled && filter.key === 'overdue'
            ? overdueTotal ?? undefined
            : quickCountsNow?.[filter.key],
        }))}
      />
      <SavedViewDialog
        open={saveDialogOpen}
        emailInboxEnabled={emailInboxEnabled}
        initialValue={{
          status: statusFilter,
          quickFilter,
          channel,
          assignee: assigneeFilter,
          unreadOnly,
          favorite: true,
        }}
        operators={operators}
        existingNames={savedViews.map((view) => view.name)}
        saving={savingView}
        onSave={async (draft) => {
          setSavedViewName(draft.name)
          return createSavedView(draft)
        }}
        onClose={() => setSaveDialogOpen(false)}
      />
      {filterOpen || showTemplatePicker ? (
        <style>{`
            [aria-label="テンプレートを選択"] {
              background-color: var(--color-scrim) !important;
            }
            div:has(> section[aria-label="絞り込み"]) > div[aria-hidden="true"] {
              background-color: transparent !important;
            }
          `}</style>
      ) : null}
      <InboxFilterPanel
        open={filterOpen}
        emailInboxEnabled={emailInboxEnabled}
        value={{ status: statusFilter === 'all' ? 'all' : statusFilter, assignee: assigneeFilter, channel, unreadOnly }}
        operators={operators}
        assigneeUnread={assigneeUnread}
        assigneeUnreadStatus={assigneeUnreadStatus}
        onChange={(next) => {
          setStatusFilter(next.status as StatusFilter)
          setAssigneeFilter(next.assignee)
          setUnreadOnly(next.unreadOnly)
          if (next.channel !== channel) {
            // 手動の条件変更なので savedView は残さない(N-021)。
            router.push(buildInboxUrl(next.channel, null))
          } else {
            dropSavedViewParam()
          }
        }}
        onReset={() => {
          setStatusFilter('all')
          setAssigneeFilter('all')
          setUnreadOnly(false)
          router.push('/chats')
        }}
        onClose={() => setFilterOpen(false)}
      />
    </InboxListHeader>
    {/* 設計 `ListPane` の「名前で検索」。一覧が長くなると状態の絞り込みだけでは足りない。 */}
    <InboxListSearch>
      {(
        /* ★V8：共通の検索欄（自作の入力欄をやめる）。 */
        <SearchField
          value={nameQuery}
          onChange={(value) => { setNameQuery(clampSearchQuery(value)); dropSavedViewParam() }}
          onClear={() => { setNameQuery(''); dropSavedViewParam() }}
          maxLength={SEARCH_QUERY_MAX_LENGTH}
          placeholder="名前・メールアドレス・内容で探す"
          aria-label="名前・メールアドレス・内容で検索"
        />
      )}
      {/*
        絞り込みは2段（クイック・名前で検索）だけ上に置く。担当者・受信経路・
        対応状況は「絞り込み」のパネルにまとめる（設計 bXyEA）。
      */}
    </InboxListSearch>

    {/*
      並びの選択は題の横の印（↑↓）から選ぶ。選んだ並びは URL の ?sort= に残る。
      期限を使うときは選べない固定の並びなので、1段の表示だけ残す。
    */}
    {slaEnabled ? (
      <p data-inbox-sort="fixed" className={`border-b border-hairline px-3 pb-3 text-micro text-ink-secondary ${styles.sortLine}`}>並び順：期限が近い順（過ぎた物が先）</p>
    ) : null}
    {/* Chat List（2026-10-07 速さ：行は ChatListWindow で窓分けして描く） */}
    <div ref={listScrollRef} data-inbox-list-scroller="" className="flex-1 overflow-y-auto" style={{ overflowAnchor: 'none' }}>
      <>
        {/*
                  メール一覧の失敗行。LINEだけ見ているときは出さない。
                  以前は失敗が無言で「メール0件」に見え、未対応の見落としになった。
                  ふだん（成功時）は何も出ないので、一覧の見た目は変わらない。
                */}
        {/*
                  メール・LINE の一覧の失敗は知らせ1つにまとめる。押すと失敗した物を全部読み直す。
                  失敗を「0件」に見せない（未対応の見落としになる）。
                */}
        <InboxListFailure
          failed={[
            ...(channel !== 'email' && chatListFailed ? ['line' as const] : []),
            ...(channel !== 'line' && emailError ? ['email' as const] : []),
          ]}
          shown={channel === 'line' ? ['line'] : channel === 'email' ? ['email'] : ['line', 'email']}
          onRetry={() => {
            if (channel !== 'email' && chatListFailed) void loadChats()
            if (channel !== 'line' && emailError) void loadEmails()
          }}
        />
        {/*
                  メールの問い合わせを同じ一覧の先頭に混ぜる。
                  設計 `V2 2-1 受信箱` の一覧は「✉ 定期便の解約について」のように
                  メールも同じ並びに入っている。出どころで場所を分けると、
                  返信を待っている人を2か所で探すことになる。

                  押したときの行き先だけは分ける。LINEはこの画面のトーク、
                  メールはメールの往復で、中央に出すものの作りが違う。
                */}
        {/*
                  LINE とメールを1本に混ぜる。どちらも口側で「未読が先・
                  新しい順」に並んでいるので、画面では並べ替えない。
                  受け取った順のまま、先頭同士を比べて混ぜるだけで全体が
                  保たれる。ページ送りで足された分も、各出どころの続き
                  として正しい場所に入る。

                  行の中身の作りは出どころで違う（メールは件名、LINE は
                  最後のメッセージと未対応の印）ので、描き方はそれぞれ
                  残したまま、混ぜ方だけそろえる。
                */}
        {(() => {
          const mailRows = (channel === 'line' ? [] : emailItems)
            .filter((item) =>
              nameQuery.trim() === ''
                ? true
                : [item.customerName, item.customerIdentifier, item.subject, item.preview]
                  .filter(Boolean)
                  .some((value) => String(value).toLowerCase().includes(nameQuery.trim().toLowerCase())),
            )
            .filter((item) => statusFilter === 'all' || item.status === statusFilter)
            .map((item) => ({
              at: item.lastMessageAt ?? item.lastIncomingAt,
              unread: item.isUnread,
              key: `email:${item.id}`,
              // 描くのは見えている行だけ（窓分け）。中身はその時に作る。
              render: () => (
                // 区切り線は外の箱が持つ。押し場所に border-hairline を書くと
                // 直書きボタンの借金に数えられる (design-debt)。
                <div key={item.id} className="border-b border-hairline">
                  <InboxListRow selected={selectedThreadId === item.threadId}
                    onClick={() => handleSelectEmail(item.threadId)}
                  >
                    <div className={`flex items-start gap-3 ${styles.rowInner}`}>
                      <div className="relative shrink-0">
                        {/* メールの行も名前の頭文字（以前は全員「M」で、誰の会話か目で追えなかった）。 */}
                        <Avatar name={item.customerName} size={34} />
                        {item.isUnread && (
                          <span className={`border-canvas bg-danger absolute -top-0.5 -right-0.5 h-3 w-3 rounded-pill border-2 ${styles.unreadDot}`} aria-label="未読" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          {/* 板 `M0393`：未対応は顔の赤い点＋名前の太字。行の地は塗らない。 */}
                          <p className={`text-ink truncate text-sm ${item.isUnread ? 'font-semibold' : 'font-medium'}`}>{item.customerName}</p>
                          {(
                            <span className={styles.rowTime} data-unread={item.isUnread || undefined} title={formatListRecentTitle(item.lastIncomingAt) || undefined}>{formatListRecent(item.lastIncomingAt)}</span>
                          )}
                        </div>
                        <div className={`mt-1 flex items-start justify-between gap-2 ${styles.rowLine}`}>
                          <p className={`text-ink-faint line-clamp-2 min-w-0 flex-1 text-xs leading-4 ${styles.rowPreview}`}>
                            {item.subject || item.preview}
                          </p>
                        </div>
                        <div className={`mt-1 flex items-center gap-2 ${styles.rowLine} ${styles.rowMeta}`}>
                          <ChannelBadge channel="email" />
                          <span className={`text-ink-faint inline-flex min-w-0 items-center gap-1 text-xs ${styles.rowAssignee}`}>
                            <span className={`bg-action-soft text-action flex h-4 w-4 shrink-0 items-center justify-center rounded-pill font-bold ${styles.rowAssigneeMark}`}>
                              {(item.assignedStaffName ?? '未').charAt(0)}
                            </span>
                            <span className="truncate">{`担当：${item.assignedStaffName ?? '未割り当て'}`}</span>
                          </span>
                        </div>
                      </div>
                    </div>
                  </InboxListRow>
                </div>
              ),
            }))
          const lineRows = (channel === 'email' ? [] : chats)
            .map((chat) => ({
              at: chat.lastMessageAt ?? '',
              unread: chat.isUnread,
              key: chat.id,
              // 描くのは見えている行だけ（窓分け）。中身はその時に作る。
              render: () => {
                const isSelected = selectedChatId === chat.id
                const operatorName = operators.find((operator) => operator.id === chat.operatorId)?.name ?? chat.operatorName ?? (chat.operatorId ? '担当者不明' : null)
                // 「真の自発（要対応）」= chat.status='unread'。webhook 側で auto_reply に
                // マッチしなかった incoming のみ unread に設定される。auto_reply trigger
                // (キーワード "コスト比較" 等) は matched 扱いで unread 化しない。
                // 太字と印の表示はこの status を使う。direction だけだと button 押下も
                // 強調してしまって S/N 比が悪化する。
                const needsAttention = chat.status === 'unread'
                /*
                  設計 `xGLVe` は、今日届いてまだ返していない行だけ待ち時間を
                  出す。古い行まで「◯◯時間待ち」にすると桁が伸びて読めない。
                */
                const waitingLabel = needsAttention
                  && chat.lastMessageAt
                  && sameYmd(chat.lastMessageAt, new Date().toISOString())
                  ? formatWaitingDuration(chat.lastMessageAt, Date.now())
                  : null
                // 最新メッセージの本文 preview。flex/image は文字列で見せても意味が薄いので type 表記に置換。
                const preview = chatListPreview(chat)
                // 区切り線は外の箱が持つ。押し場所に border-hairline を書くと
                // 直書きボタンの借金に数えられる (design-debt)。
                const node = (
                  <div key={chat.id} className="border-b border-hairline">
                    <InboxListRow selected={isSelected}
                      onClick={() => handleSelectChat(chat.id)}
                      /* 名前は相手の名前だけ、未読と本文は説明に回す（読み上げで名前から入れる）。 */
                      aria-labelledby={(`chat-row-name-${chat.id}`)}
                      aria-describedby={[chat.isUnread ? `chat-row-unread-${chat.id}` : null, chat.isAttention ? `chat-row-attention-${chat.id}` : null, `chat-row-preview-${chat.id}`].filter(Boolean).join(' ')}
                    >
                      <div className={`flex items-start gap-3 ${styles.rowInner}`}>
                        <div className="relative shrink-0">
                          {/* ★V7 友だちの顔：画像が読めない時も色つきの頭文字。 */}
                          <Avatar name={chat.friendName} src={chat.friendPictureUrl} size={34} />
                          {chat.isUnread && (
                            <span id={`chat-row-unread-${chat.id}`} className={`border-canvas bg-danger absolute -top-0.5 -right-0.5 h-3 w-3 rounded-pill border-2 ${styles.unreadDot}`} aria-label="未読" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 min-w-0 flex-1">
                              {/* 板 `M0393`：未対応は名前の太字。行の地は塗らない。 */}
                              <p id={`chat-row-name-${chat.id}`} className={`text-sm text-ink truncate ${chat.isUnread ? 'font-semibold' : 'font-medium'}`}>{chat.friendName}</p>
                            </div>
                            <InboxListAttention on={chat.isAttention} id={`chat-row-attention-${chat.id}`} />
                            {(
                              /* 右上は「17:51」「昨日」「木曜日」「10/18」。未読は濃い字・太字。待ち時間の札は置かず、全文と一緒に title へ。 */
                              <span className={styles.rowTime} data-unread={chat.isUnread || undefined} title={[formatListRecentTitle(chat.lastMessageAt), waitingLabel].filter(Boolean).join('・') || undefined}>{formatListRecent(chat.lastMessageAt)}</span>
                            )}
                          </div>
                          {/* 板 `M0393`：行ごとの状態の札は置かない（赤い点＋太字と上の切り替えで足りる）。 */}
                          <div className={`mt-1 flex items-start justify-between gap-2 ${styles.rowLine}`}>
                            <p
                              id={`chat-row-preview-${chat.id}`}
                              className={`line-clamp-2 min-w-0 flex-1 text-xs leading-4 ${styles.rowPreview} ${needsAttention ? 'text-ink font-medium' : 'text-ink-faint'
                                }`}
                              title={preview}
                            >
                              {chat.lastMessageDirection === 'outgoing' && (
                                <span className="text-ink-faint mr-1">返信：</span>
                              )}
                              {preview || <span className="text-ink-faint italic">（まだメッセージなし）</span>}
                            </p>
                          </div>
                          <div className={`mt-1 flex items-center gap-2 ${styles.rowLine} ${styles.rowMeta}`}>
                            <ChannelBadge channel="line" />
                            <span className={`text-ink-faint inline-flex min-w-0 items-center gap-1 text-xs ${styles.rowAssignee}`}>
                              <span className={`bg-action-soft text-action flex h-4 w-4 shrink-0 items-center justify-center rounded-pill font-bold ${styles.rowAssigneeMark}`}>
                                {(operatorName ?? '未').charAt(0)}
                              </span>
                              <span className="truncate">{`担当：${assigneeLabel(operatorName, chat as ChatSlaFields)}`}</span>
                            </span>
                            <span className="ml-auto shrink-0"><SlaBadge fields={chat as ChatSlaFields} now={Date.now()} /></span>
                          </div>
                        </div>
                      </div>
                    </InboxListRow>
                  </div>
                )
                return node
              },
            }))
          // 既定は両方とも口側で「未読が先・新しい順」。未読の有無が違う
          // 行同士は時刻に関わらず未読が先、同じ中では新しい順。
          // 新しい順のときは未読を見ず時刻だけで混ぜる。メールの口には並びの指定が無いので、
          // 読み込んだ範囲の中で新しい順に並べ直してから混ぜる。
          const latest = sortOrder === 'latest'
          const precedes = (
            a: { at: string; unread: boolean },
            b: { at: string; unread: boolean },
          ): number =>
            (latest ? 0 : Number(b.unread) - Number(a.unread))
            || String(b.at).localeCompare(String(a.at))
          if (latest) mailRows.sort((a, b) => String(b.at).localeCompare(String(a.at)))
          const rows: ChatListWindowItem[] = []
          if (slaEnabled) {
            // 期限が近い順（過ぎた物が先）。期限の無い行・メールは後ろへ。「期限超過」は期限を過ぎた行だけ。
            const dueOf = (chat: ChatSlaFields) => (chat.slaDueAt ? Date.parse(chat.slaDueAt) : Infinity)
            const linePicked = (quickFilter === 'overdue' ? chats.filter((chat) => (chat as ChatSlaFields).slaState === 'overdue') : chats)
            const keyed = new Set(linePicked.map((chat) => chat.id))
            const lineByDue = lineRows.filter((row) => keyed.has(row.key)).sort((a, b) => dueOf(chats.find((chat) => chat.id === a.key) as ChatSlaFields) - dueOf(chats.find((chat) => chat.id === b.key) as ChatSlaFields))
            rows.push(...lineByDue, ...(quickFilter === 'overdue' ? [] : mailRows))
          } else {
            let i = 0
            let j = 0
            while (i < mailRows.length && j < lineRows.length) {
              if (precedes(mailRows[i], lineRows[j]) <= 0) rows.push(mailRows[i++])
              else rows.push(lineRows[j++])
            }
            while (i < mailRows.length) rows.push(mailRows[i++])
            while (j < lineRows.length) rows.push(lineRows[j++])
          }
          if (inboxListLoading) {
            return (
              /*
               * 会話の行の形の骨組み（動きの点検 15 番）。0.3 秒以内に届けば出さない。
               * 読み上げには「読み込んでいます」を残す。
               */
              <div role="status" aria-busy="true" data-inbox-list-state="loading">
                <span className="sr-only">会話を読み込んでいます…</span>
                <DelayedSkeleton
                  loading
                  skeleton={
                    <div aria-hidden="true">
                      {[0, 1, 2, 3, 4, 5].map((row) => <SkeletonRow key={row} />)}
                    </div>
                  }
                />
              </div>
            )
          }
          if (rows.length > 0) {
            return <RefreshCover refreshing={inboxListRefreshing}><ChatListWindow items={rows} scrollerRef={listScrollRef} hasMore={hasMoreChats || hasMoreEmails} /></RefreshCover>
          }
          // 障害を0件と誤認させない。具体的な理由は各チャネルのエラー表示に任せる。
          if (inboxListFailed) return null
          return <InboxListEmpty filtered={hasInboxFilters} onClear={clearInboxFilters} />
        })()}

        {hasMoreChats && (
          <InboxHistoryButton context="list" busy={loadingMore}
            onClick={() => { void loadMoreChats() }}
          >
            さらに読み込む
          </InboxHistoryButton>
        )}
        {/*
                  メールの続き。メールは上限200件で切れていた分を offset で遡る。
                  LINEの「さらに読み込む」とは別物なので文言を分ける。
                */}
        {hasMoreEmails && (
          <InboxHistoryButton context="list" busy={loadingMoreEmails}
            onClick={() => { void loadEmails(emailItems.length, true) }}
          >
            メールの続きを読み込む
          </InboxHistoryButton>
        )}
      </>
    </div>
  </InboxListPane>)
}
