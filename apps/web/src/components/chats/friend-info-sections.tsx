'use client'
import { asArray } from './friend-detail-shape'
import { PrepayBadgeV8 } from '@/v8/booking/index'
import Button from '@/components/shared/button'
import { EntityPickerField, type EntityPickerFolder } from '@/components/shared/entity-picker'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import InlineEdit from '@/components/shared/inline-edit'
import Select from '@/components/shared/select'
import { DelayedSkeleton, Skeleton } from '@/components/shared/skeleton'
import StatusPill, { SUPPORT_STATUS_TONES, StatusDot } from '@/components/shared/status-pill'
import TagOverflow from '@/components/shared/tag-overflow'
import TagPill from '@/components/shared/tag-pill'
import { TextArea } from '@/components/shared/text-field'
import { formAnswerText } from '@/lib/form-answer'
import { formatNumber } from '@/lib/format'
import v8 from '@/v8/inbox-chat/customer-panel.module.css'
import type { Tag } from '@line-crm/shared'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { Children, cloneElement, isValidElement } from 'react'
import { DETAIL_SECTIONS, DetailSectionKey, ExpandableText, FriendFieldsState, PurchaseState, RichMenuState, UpcomingState, formatAddedDate, formatDate, renderValue, statusLabels, upcomingBookingHref, upcomingDeliveryHref } from './friend-info-model'
import { STATUS_OPTIONS } from './friend-info-status'
import { type ChatStatusInfo, type FriendDetail } from './friend-info-types'
import { TextField as SharedTextField, TextArea as SharedTextArea } from '@/components/shared/text-field'

type Options = {
  sectionStyle: (key: DetailSectionKey) => { order: number; }
  canEditChat: boolean
  statusButtonRef: RefObject<HTMLDivElement | null>
  effectiveStatus: "in_progress" | "resolved" | "unread" | "on_hold" | null | undefined
  saveChatStatus: (next: NonNullable<ChatStatusInfo["status"]>) => void
  chatStatus: ChatStatusInfo | undefined
  operators: { id: string; name: string; }[] | undefined
  effectiveOperatorId: string | null | undefined
  saveAssignee: (nextOperatorId: string | null) => void
  operatorName: string | null | undefined
  memoSaving: boolean
  memoAreaRef: RefObject<HTMLTextAreaElement | null>
  chatId: string | null | undefined
  effectiveNotes: string | null | undefined
  queueMemoSave: (text: string) => void
  upcoming: UpcomingState
  setUpcomingRetry: Dispatch<SetStateAction<number>>
  friendId: string | null
  canEditFriend: boolean
  tagPickerOpen: boolean
  setTagPickerOpen: Dispatch<SetStateAction<boolean>>
  effectiveTags: { id: string; name: string; color: string; }[] | undefined
  setTagToRemove: Dispatch<SetStateAction<{ id: string; name: string; friendId: string; } | null>>
  tagOptions: Tag[]
  tagFolders: EntityPickerFolder[]
  loadTagFolders: () => void
  createTagForPicker: (name: string) => Promise<{ id: string; name: string; color: string; folderId: string | null; frequent: boolean; } | null>
  tagSaving: boolean
  applyTagSelection: (ids: string[]) => Promise<void>
  tagSearchRef: RefObject<HTMLInputElement | null>
  tagQuery: string
  setTagQuery: Dispatch<SetStateAction<string>>
  setTagActive: Dispatch<SetStateAction<number>>
  tagActive: number
  addTagById: (tagId: string, known?: { name: string; color: string; }) => void
  createAndAddTag: (query: string) => Promise<void>
  richMenu: RichMenuState
  setRichMenuRetry: Dispatch<SetStateAction<number>>
  accountId: string | null | undefined
  canClearPrepay: boolean
  friendFields: FriendFieldsState
  setFieldsRetry: Dispatch<SetStateAction<number>>
  metadataLabel: (key: string) => string | null
  targetKey: string
  saveMetadata: (entry: { key: string }, next: string) => Promise<void>
  purchase: PurchaseState
  setPurchaseRetry: Dispatch<SetStateAction<number>>
}

export function createFriendInfoSections({ sectionStyle, canEditChat, statusButtonRef, effectiveStatus, saveChatStatus, chatStatus, operators, effectiveOperatorId, saveAssignee, operatorName, memoSaving, memoAreaRef, chatId, effectiveNotes, queueMemoSave, upcoming, setUpcomingRetry, friendId, canEditFriend, tagPickerOpen, setTagPickerOpen, effectiveTags, setTagToRemove, tagOptions, tagFolders, loadTagFolders, createTagForPicker, tagSaving, applyTagSelection, tagSearchRef, tagQuery, setTagQuery, setTagActive, tagActive, addTagById, createAndAddTag, richMenu, setRichMenuRetry, accountId, canClearPrepay, friendFields, setFieldsRetry, metadataLabel, targetKey, saveMetadata, purchase, setPurchaseRetry }: Options) {

  /*
   * 顧客情報の節（基本情報・マイル・次の対応・タグ・★つき・リッチメニュー・友だち情報・フォーム回答）。
   * 互換経路は今までどおり右の欄に線で並べ、★V8 は角丸の枠（顧客情報）の中に並べる。中身は同じ。
   */
  const renderSupport = (friend: FriendDetail) => (
    <div data-customer-section="support" style={sectionStyle('support')} className={`space-y-3 px-5 py-4`}>
      <h4 className="text-ink mb-2 text-xs font-bold">次の対応</h4>
      {/* ①対応状況（3つのボタン・1タップ）。押した瞬間に変えて裏で保存。 */}
      <div>
        <span className="text-micro text-ink-faint">対応状況</span>
        {canEditChat ? (
          /* ★V8 ：共通の選ぶ欄（会話の頭と同じ色の点）。選んだ瞬間に変えて裏で保存・知らせに元に戻す。保留も選べる。 */
          <div ref={statusButtonRef} className={v8.editField}>
            <Select
              size="full"
              aria-label="対応状況を変える"
              treatment="pill"
              icon={<StatusDot tone={SUPPORT_STATUS_TONES[effectiveStatus ?? 'unread']} />}
              options={STATUS_OPTIONS.map((option) => ({ ...option, tone: SUPPORT_STATUS_TONES[option.value], leading: <StatusDot tone={SUPPORT_STATUS_TONES[option.value]} /> }))}
              value={effectiveStatus ?? 'unread'}
              onChange={(next) => saveChatStatus(next as NonNullable<ChatStatusInfo['status']>)}
            />
          </div>
        ) : canEditChat ? (
          <div ref={statusButtonRef} role="group" aria-label="対応状況を変える" className="mt-1.5 grid grid-cols-3 gap-1.5">
            {([
              { key: 'unread', label: '未対応' },
              { key: 'in_progress', label: '対応中' },
              { key: 'resolved', label: '対応済み' },
            ] as const).map((item) => {
              const active = effectiveStatus === item.key
              return (
                <Button variant="secondary"
                  key={item.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => saveChatStatus(item.key)}
                  style={{ minHeight: 0, height: 'auto', padding: 8, fontSize: 12, lineHeight: '16px', fontWeight: 600, borderColor: active ? 'var(--color-accent-deep)' : 'var(--color-hairline)', background: active ? 'var(--color-accent-soft)' : 'var(--color-canvas)', color: active ? 'var(--color-accent-deep)' : 'var(--color-ink-secondary)' }}
                >
                  {item.label}
                </Button>
              )
            })}
          </div>
        ) : chatStatus?.status && statusLabels[chatStatus.status] ? (
          <div className="mt-1.5">
            {<StatusPill tone={SUPPORT_STATUS_TONES[chatStatus.status]}>{statusLabels[chatStatus.status].label}</StatusPill>}
          </div>
        ) : (
          <p className="text-xs text-ink-faint mt-1.5">未設定</p>
        )}
      </div>
      {/* ②担当（選ぶ）。 */}
      <div>
        <label htmlFor="inbox-panel-assignee" className="text-micro text-ink-faint">担当者</label>
        {canEditChat && operators ? (
          /* ★V8 ：共通の選ぶ欄（選んだ行は ✓ だけ）。 */
          <div className={v8.editField}>
            <EntitySelect
              id="inbox-panel-assignee"
              size="full"
              aria-label="担当者を変える"
              value={effectiveOperatorId ?? ''}
              onChange={(value) => saveAssignee(value || null)}
              options={[{ value: '', label: '未割り当て' }, ...operators.map((op) => ({ ...entityOptionMetadata(op), value: op.id, label: op.name }))]}
            />
          </div>
        ) : (
          <p className="text-xs text-ink-secondary mt-1.5">{operatorName || <span className="text-ink-faint">未割り当て</span>}</p>
        )}
      </div>
      {/* ④メモ（書くのをやめて1秒で自動保存）。 */}
      <div data-customer-memo>
        <label htmlFor="inbox-panel-memo" className="text-micro text-ink-faint">メモ{memoSaving ? '・保存中…' : ''}</label>
        {canEditChat ? (
          /* ★V8 ：共通の複数行の入力欄。書くのをやめて1秒で保存し、知らせに元に戻す。 */
          <div className={v8.editField}>
            <TextArea
              id="inbox-panel-memo"
              ref={memoAreaRef}
              key={chatId ?? ''}
              defaultValue={effectiveNotes ?? ''}
              onChange={(event) => queueMemoSave(event.target.value)}
              placeholder="この人へのメモを書く"
            />
          </div>
        ) : canEditChat ? (
          <SharedTextArea
            id="inbox-panel-memo"
            ref={memoAreaRef}
            defaultValue={effectiveNotes ?? ''}
            onChange={(event) => queueMemoSave(event.target.value)}
            rows={3}
            placeholder="この人へのメモを書く"
            className="border-hairline rounded-control text-ink mt-1.5 w-full resize-y border bg-canvas px-2 py-2 text-xs outline-none"
          />
        ) : (
          <p className="text-xs text-ink-secondary whitespace-pre-wrap break-words mt-1.5">
            {effectiveNotes || <span className="text-ink-faint">まだありません</span>}
          </p>
        )}
      </div>
      {/*
                IDEA-02: 次回予約と次の確定した自動配信。
                「読み込めませんでした」(未取得) と「予定なし」は別の状態。
                値がある行は詳細画面へのリンクにする。
                色と文字サイズは生のTailwindではなくトークンで書く
                （raw-colors / design-debt の基準を増やさない）。
              */}
      <div data-customer-upcoming className="space-y-1.5 border-t border-hairline pt-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-ink-faint text-micro shrink-0">次回予約</span>
          {upcoming.kind === 'loading' ? (
            <span className="text-ink-faint text-caption">読み込み中…</span>
          ) : upcoming.kind === 'error' || upcoming.data.nextBookingError ? (
            <span className="text-danger text-micro">読み込めませんでした</span>
          ) : upcoming.data.nextBooking ? (
            <a
              href={upcomingBookingHref(upcoming.data.nextBooking, friend.id)}
              title={`${upcoming.data.nextBooking.title} ${formatDate(upcoming.data.nextBooking.startsAt)}`}
              className="text-action text-caption min-w-0 truncate hover:underline"
            >
              {formatDate(upcoming.data.nextBooking.startsAt)} {upcoming.data.nextBooking.title}
            </a>
          ) : (
            <span className="text-ink-faint text-caption">予定なし</span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-ink-faint text-micro shrink-0">次の自動配信</span>
          {upcoming.kind === 'loading' ? (
            <span className="text-ink-faint text-caption">読み込み中…</span>
          ) : upcoming.kind === 'error' || upcoming.data.nextAutoDeliveryError ? (
            <span className="text-danger text-micro">読み込めませんでした</span>
          ) : upcoming.data.nextAutoDelivery ? (
            <a
              href={upcomingDeliveryHref(upcoming.data.nextAutoDelivery)}
              title={`${upcoming.data.nextAutoDelivery.name} ${formatDate(upcoming.data.nextAutoDelivery.scheduledAt)}`}
              className="text-action text-caption min-w-0 truncate hover:underline"
            >
              {formatDate(upcoming.data.nextAutoDelivery.scheduledAt)} {upcoming.data.nextAutoDelivery.name}
            </a>
          ) : (
            <span className="text-ink-faint text-caption">予定なし</span>
          )}
        </div>
        {/* 片方だけの失敗でもここからまとめて取り直せる(INBOX-08 と同じ型)。 */}
        {(upcoming.kind === 'error'
          || (upcoming.kind === 'data' && (upcoming.data.nextBookingError || upcoming.data.nextAutoDeliveryError))) && (
            <button
              type="button"
              onClick={() => setUpcomingRetry((key) => key + 1)}
              className="text-action text-micro font-semibold underline underline-offset-2"
            >
              再試行する
            </button>
          )}
      </div>
    </div>
  )

  /* 対応の節の「次回予約」「次の自動配信」の値。未取得と「予定なし」は分ける（IDEA-02）。 */
  const upcomingRowValue = (which: 'booking' | 'delivery'): React.ReactNode => {
    if (upcoming.kind === 'loading') return '読み込み中…'
    const failed = upcoming.kind === 'error' || (which === 'booking' ? upcoming.data.nextBookingError : upcoming.data.nextAutoDeliveryError)
    if (failed) return <span className="text-danger">読み込めませんでした</span>
    if (upcoming.kind !== 'data') return '予定なし'
    if (which === 'booking' && upcoming.data.nextBooking) {
      const next = upcoming.data.nextBooking
      return <a href={upcomingBookingHref(next, friendId ?? '')} title={`${next.title} ${formatDate(next.startsAt)}`} className="text-action block min-w-0 truncate hover:underline">{formatDate(next.startsAt)} {next.title}</a>
    }
    if (which === 'delivery' && upcoming.data.nextAutoDelivery) {
      const next = upcoming.data.nextAutoDelivery
      return <a href={upcomingDeliveryHref(next)} title={`${next.name} ${formatDate(next.scheduledAt)}`} className="text-action block min-w-0 truncate hover:underline">{formatDate(next.scheduledAt)} {next.name}</a>
    }
    return '予定なし'
  }

  const renderTags = (friend: FriendDetail) => (
    <div data-customer-section="tags" style={sectionStyle('tags')} className={`px-5 py-4 ${v8.tagsSection}`}>
      <div className="mb-1.5 flex items-center justify-between">
        <h4 className="text-ink text-xs font-bold">タグ</h4>
        {canEditFriend ? <Button variant="text" size="inline" aria-expanded={tagPickerOpen} aria-controls="inbox-panel-tag-picker" onClick={() => setTagPickerOpen((value) => !value)}>＋ 追加</Button> : <a href={`/friends/detail?id=${friend.id}`} className="text-action text-micro hover:underline">
          すべて見る
        </a>}
      </div>
      <div className="flex flex-wrap gap-1">
        <TagOverflow maxVisible={2}>{(effectiveTags ?? []).map((tag) => (
          <TagPill key={tag.id} name={tag.name} color={tag.color} size="xs"
            onRemove={canEditFriend && friendId ? () => setTagToRemove({ id: tag.id, name: tag.name, friendId }) : undefined} />
        ))}</TagOverflow>
      </div>
      {(effectiveTags ?? []).length === 0 ? (
        <p className="text-micro text-ink-faint italic mt-1.5">タグなし</p>
      ) : null}
      {canEditFriend ? (
        /* ★V8 ：共通の候補つき入力。選ぶと付け、無ければ「＋ 新しく作る」で作って付ける。 */
        <div id="inbox-panel-tag-picker" hidden={!tagPickerOpen} className={v8.editField}>
          {/* GBTyR：タグは選ぶ窓（S2Vgi の形）でまとめて選ぶ。付け外しは1つずつ送る（ほかの人の変更を消さない）。 */}
          <EntityPickerField multiple
            id="inbox-panel-tag"
            label="タグ"
            ariaLabel="タグを探して付ける"
            noun="タグ"
            title="タグを選ぶ"
            unit="件"
            searchPlaceholder="タグの名前で探す"
            items={tagOptions.filter((t) => (t.status ?? 'active') === 'active').map((t) => ({ id: t.id, name: t.name, color: t.color, folderId: t.groupId ?? null, frequent: Boolean(t.isStarred), meta: t.friendCount == null ? undefined : `${formatNumber(t.friendCount)} 人` }))}
            folders={tagFolders}
            onOpen={loadTagFolders}
            headerCreate={{ label: 'タグを作る', placeholder: '新しいタグの名前', onCreate: createTagForPicker }}
            disabled={tagSaving}
            value={(effectiveTags ?? []).map((tag) => tag.id)}
            onChange={(ids) => { void applyTagSelection(ids) }}
          />
        </div>
      ) : canEditFriend ? (
        <div className="mt-2">
          <SharedTextField
            ref={tagSearchRef}
            type="text"
            value={tagQuery}
            onChange={(event) => {
              setTagQuery(event.target.value)
              setTagActive(0)
            }}
            onKeyDown={(event) => {
              const q = tagQuery.trim().toLowerCase()
              const attached = new Set((effectiveTags ?? []).map((t) => t.id))
              const shown = tagOptions.filter((t) => !attached.has(t.id) && (!q || t.name.toLowerCase().includes(q)))
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setTagActive((v) => Math.min(v + 1, Math.max(0, shown.length - 1)))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setTagActive((v) => Math.max(v - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                const picked = shown[tagActive]
                if (picked) {
                  addTagById(picked.id)
                } else if (tagQuery.trim()) {
                  void createAndAddTag(tagQuery)
                }
              }
            }}
            placeholder="＋ 探して付ける・作る"
            aria-label="タグを探して付ける"
            className="border-hairline rounded-control text-ink w-full border bg-canvas px-2 py-2 text-xs outline-none"
          />
          {tagQuery.trim() ? (
            <div role="listbox" aria-label="タグの候補" className="border-hairline rounded-control mt-1.5 max-h-40 overflow-y-auto border bg-canvas">
              {(() => {
                const q = tagQuery.trim().toLowerCase()
                const attached = new Set((effectiveTags ?? []).map((t) => t.id))
                const shown = tagOptions.filter((t) => !attached.has(t.id) && (!q || t.name.toLowerCase().includes(q))).slice(0, 8)
                if (shown.length === 0) {
                  return <p className="text-ink-faint px-2 py-2 text-xs">Enterで「{tagQuery.trim()}」を作る</p>
                }
                return shown.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    role="option"
                    aria-selected={i === tagActive}
                    onClick={() => addTagById(t.id)}
                    className={`flex w-full items-center px-2 py-1.5 text-left text-xs ${i === tagActive ? 'bg-accent-soft text-accent-deep' : 'text-ink'}`}
                  >
                    {t.name}
                  </button>
                ))
              })()}
            </div>
          ) : null}
          {tagSaving ? <p className="text-ink-faint mt-1 text-micro">保存中…</p> : null}
        </div>
      ) : null}
    </div>
  )

  const renderRichMenu = () => (
    <div data-customer-section="richMenu" style={sectionStyle('richMenu')} className={`p-4`}>
      <h4 className="text-micro font-semibold text-ink-faint mb-1.5">リッチメニュー</h4>
      {richMenu.kind === 'loading' ? (
        <p className="text-micro text-ink-faint italic">読み込み中…</p>
      ) : richMenu.kind === 'error' ? (
        /* INBOX-08: 失敗と未設定を分け、その場で再試行できる。 */
        <div className="space-y-1.5">
          <p className="text-micro text-danger">リッチメニューを読み込めませんでした</p>
          <button
            type="button"
            onClick={() => setRichMenuRetry((key) => key + 1)}
            className="text-action text-micro font-semibold underline underline-offset-2"
          >
            再試行する
          </button>
        </div>
      ) : richMenu.id === null ? (
        <p className="text-micro text-ink-faint italic">未設定</p>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-ink-secondary">{richMenu.name ?? '（名前なし）'}</span>
          {richMenu.isDefault && (
            <span className="px-1.5 py-0 rounded-mini text-nano font-medium bg-shell text-ink-faint">
              デフォルト
            </span>
          )}
        </div>
      )}
    </div>
  )

  // 見出し・枠は共通欄が持ち、管理画面 の節の中身と操作を再利用する。
  const stripSectionHeadings = (children: React.ReactNode): React.ReactNode => Children.map(children, child => {
    if (!isValidElement<{ children?: React.ReactNode }>(child)) return child
    if (child.type === 'h4') return null
    return child.props.children ? cloneElement(child, {}, stripSectionHeadings(child.props.children)) : child
  })

  const sectionBody = (node: ReturnType<typeof renderSupport>) =>
    Children.toArray(stripSectionHeadings(node.props.children))

  const renderDetailSections = (friend: FriendDetail) => (
    <>
      {!canEditChat && !canEditFriend ? <p role="note" className="text-micro text-ink-faint">閲覧のみで見ています。変更は管理者に頼んでください。</p> : null}
      {/* 前払いのみの印（友だち詳細と同じ置き場所・顔の下）。前払いの人だけ出る。 */}
      {accountId && friendId ? (
        /* ★V8：前払いでない人は中身が空。空の帯（上下12＋線）を残さない（オーナー指摘）。 */
        <div className="border-hairline border-b px-5 py-3 empty:hidden">
          <PrepayBadgeV8 accountId={accountId} friendId={friendId} canEdit={canClearPrepay} />
        </div>
      ) : null}

      {<div style={sectionStyle('profile')} className={`${v8.profileSection}`}>
        <h4>プロフィール</h4>
        <p>{friend.displayName}・{formatAddedDate(friend.createdAt)}</p>
      </div>}
      {/*
              名前（設計 `友だち詳細` の「名前」）。
              LINEの表示名と、こちらで付けた本名は別物。取り違えると
              別人に送ってしまうので、両方を並べて出す。
            */}
      <div data-customer-section="names" style={sectionStyle('names')} className={`space-y-2 px-5 py-4 ${v8.basicSection}`}>
        <h4 className="text-ink mb-2 text-xs font-bold">基本情報</h4>
        <div className="flex justify-between items-center gap-2">
          <span className="text-micro text-ink-faint shrink-0">本名</span>
          <ExpandableText value={friend.realName} className="text-label text-ink-secondary" />
        </div>
        {((friend.systemDisplayName && friend.systemDisplayName !== friend.displayName)) ? <div className="flex justify-between items-center gap-2">
          <span className="text-micro text-ink-faint shrink-0">システム表示名</span>
          <ExpandableText value={friend.systemDisplayName} className="text-label text-ink-secondary" />
        </div> : null}
        {null}
      </div>

      {/* Status / Operator */}
      {/*
              対応（設計 `友だち詳細` の「対応」）。
              値が無くても節ごと出す。以前は空だと見出しごと消えていて、
              「この画面には対応の情報が無い」ように見えていた。
              設計は「未設定」「未割り当て」と書いて枠を残している。
            */}
      {renderSupport(friend)}

      {/* ③タグ（×で外す・＋で探して付ける・↑↓Enter・新しいタグも作れる）。 */}
      {renderTags(friend)}

      {/*
              ★つき友だち情報（設計 `友だち詳細`）。
              INBOX-05: 「友だち一覧に表示（★）」が付いた項目だけを出す。
              以前は登録順の先頭3件を出していたため、登録順で重要でない
              情報が並び、4件目以降の★項目は届かなかった。
              0件なら付け方への導線を出す。
            */}
      <div data-customer-section="starred" style={sectionStyle('starred')} className={`p-4`}>
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-micro font-semibold text-ink-faint">★つき友だち情報</h4>
          <a href={`/friends/detail?id=${friend.id}`} className="text-action text-micro hover:underline">
            すべて見る
          </a>
        </div>
        {friendFields.kind === 'loading' ? (
          <DelayedSkeleton loading skeleton={<Skeleton className="block h-10 w-full rounded-control" />} />
        ) : friendFields.kind === 'error' ? (
          <div className="space-y-1.5">
            <p className="text-micro text-danger">項目を読み込めませんでした</p>
            <button
              type="button"
              onClick={() => setFieldsRetry((key) => key + 1)}
              className="text-action text-micro font-semibold underline underline-offset-2"
            >
              再試行する
            </button>
          </div>
        ) : (() => {
          const starred = friendFields.items.filter((field) => field.isStarred)
          if (starred.length === 0) {
            return (
              <p className="text-micro text-ink-faint">
                ★を付けた項目はまだありません。友だち詳細の「情報」で項目へ★を付けると、ここへ出ます。
              </p>
            )
          }
          return (
            <dl className="space-y-1.5 text-xs">
              {starred.map((field) => (
                <div key={field.id}>
                  <dt className="text-nano text-ink-faint break-words">{field.name}</dt>
                  <dd className="mt-0.5 text-ink-secondary">
                    <ExpandableText value={field.value ?? null} empty="未登録" className="text-xs text-ink-secondary" />
                  </dd>
                </div>
              ))}
            </dl>
          )
        })()}
      </div>

      {/* Rich Menu */}
      {renderRichMenu()}

      {/* Metadata custom fields */}
      <div data-customer-section="metadata" style={sectionStyle('metadata')} className={`p-4`}>
        <h4 className="text-micro font-semibold text-ink-faint mb-2">友だち情報</h4>
        {/* 設計は追加日と流入元を必ず出す。どちらも既に持っている値。 */}
        <dl className="mb-2 space-y-1 text-xs">
          <div className="flex justify-between gap-2">
            <dt className="text-micro text-ink-faint shrink-0">追加日</dt>
            <dd className="text-ink-secondary">{formatDate(friend.createdAt)}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-micro text-ink-faint shrink-0">流入元</dt>
            {/*
                    INBOX-06: 友だち詳細と同じ firstTrackedLinkName を出す。
                    計測できなかった人・経路が消えた人は null → 「不明」。
                    取得自体の失敗は上のエラー節で再試行できる。
                  */}
            <dd className="min-w-0 text-ink-secondary">
              {friend.firstTrackedLinkName ? (
                <ExpandableText value={friend.firstTrackedLinkName} className="text-xs text-ink-secondary" />
              ) : (
                <span className="text-ink-faint">不明</span>
              )}
            </dd>
          </div>
        </dl>
        {(() => {
          /*
            ⑤友だち情報の欄（押すとその場で書き換え）。
            INBOX-07: `_` 始まりの制御用キーは業務表示から外し、
            項目名は内部キーではなく定義済みの表示名へ写す。
            InlineEdit（ux-core）で Enter 保存・Esc やめる・失敗で戻す。
          */
          const entries = Object.entries(friend.metadata ?? {})
            .map(([key, value]) => ({ key, label: metadataLabel(key), value }))
            .filter((entry): entry is { key: string; label: string; value: unknown } => entry.label !== null)
          if (entries.length === 0) {
            return <p className="text-micro text-ink-faint italic">まだ登録がありません</p>
          }
          return (
            <dl className="space-y-2 text-xs">
              {entries.map((entry) => (
                <div key={entry.key}>
                  <dt className="text-nano text-ink-faint break-words">{entry.label}</dt>
                  <dd className="text-ink-secondary mt-0.5 break-words">
                    {canEditFriend && friendId ? (
                      <InlineEdit
                        key={`${targetKey}:${entry.key}`}
                        value={renderValue(entry.value)}
                        label={entry.label}
                        onSave={(next) => saveMetadata(entry, next)}
                      />
                    ) : (
                      <span className="whitespace-pre-wrap">{renderValue(entry.value)}</span>
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )
        })()}
      </div>

      {/* ⑥購入（EC の直近3件と合計）。数は実データ。無いときは「—」。★V8 は顧客情報の枠の最後に置き、見出しをほかの節とそろえる。 */}
      <div data-customer-section="purchase" className="p-4" style={{ order: DETAIL_SECTIONS.length }}>
        <div className="mb-2 flex items-center justify-between">
          <h4 className={'text-ink text-xs font-bold'}>購入</h4>
          <a href={`/friends/detail?id=${friend.id}`} className="text-action text-micro hover:underline">
            すべて見る
          </a>
        </div>
        {purchase.kind === 'loading' ? (
          <p className="text-micro text-ink-faint italic">読み込み中…</p>
        ) : purchase.kind === 'data' ? (
          <div className="space-y-1.5">
            <p className="text-ink text-sm font-bold tabular-nums">
              合計 {formatNumber(purchase.total)}<span className="text-ink-faint ml-1 text-micro font-semibold">円</span>
            </p>
            <ul className="space-y-1.5">
              {purchase.items.map((item) => (
                <li key={item.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-ink-secondary min-w-0 truncate">{item.title}</span>
                  <span className="text-ink shrink-0 font-semibold tabular-nums">{formatNumber(item.amount ?? 0)}円</span>
                </li>
              ))}
            </ul>
          </div>
        ) : purchase.reason === 'none' ? (
          <p className="text-micro text-ink-faint italic">購入はまだありません</p>
        ) : purchase.reason === 'unavailable' ? (
          <div className="space-y-1.5">
            <p className="text-micro text-danger">購入を読み込めませんでした</p>
            <button
              type="button"
              aria-label="購入をもう一度読み込む"
              onClick={() => setPurchaseRetry((key) => key + 1)}
              className="text-action text-micro font-semibold underline underline-offset-2"
            >
              再試行する
            </button>
          </div>
        ) : (
          <p className="text-micro text-ink-faint italic">—</p>
        )}
      </div>

      {/* Form answers — save_to_metadata の設定に関係なく回答履歴を表示 */}
      <div data-customer-section="forms" style={sectionStyle('forms')} className={`p-4`}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h4 className="text-micro font-semibold text-ink-faint">フォーム回答</h4>
          {/*
                  INBOX-17: 取得するのは最新10件まで。続きがあるか、全部で
                  何件あるかを黙らせない。10件を超える分は友だち詳細へ誘導する。
                */}
          {typeof friend.formSubmissionTotal === 'number' && friend.formSubmissionTotal > 0 && asArray(friend.formSubmissions).length > 0 && (
            <span className="text-nano text-ink-faint">
              {formatNumber(friend.formSubmissionTotal)}件中 1〜{formatNumber(asArray(friend.formSubmissions).length)}件を表示
            </span>
          )}
        </div>
        {!friend.formSubmissions || asArray(friend.formSubmissions).length === 0 ? (
          <p className="text-micro text-ink-faint italic">回答はまだありません</p>
        ) : (
          <div>
            <div className="space-y-3">
              {asArray(friend.formSubmissions).map((submission) => {
                const labels = new Map(asArray(submission.fields).map((field) => [field.name, field.label]))
                const answers = Object.entries(submission.data).filter(([key]) => !key.startsWith('_'))
                return (
                  <div key={submission.id} className="rounded-control border border-divider-soft bg-surface-pearl p-3">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-xs font-medium text-ink-secondary break-words">{submission.formName}</p>
                      <time className="shrink-0 text-nano text-ink-faint">
                        {formatDate(submission.createdAt)}
                      </time>
                    </div>
                    <dl className="mt-2 space-y-2">
                      {answers.map(([key, value]) => (
                        <div key={key}>
                          <dt className="text-nano text-ink-faint">{labels.get(key) ?? key}</dt>
                          <dd className="mt-0.5 whitespace-pre-wrap break-words text-xs text-ink-secondary">
                            {formAnswerText(value) || '-'}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                )
              })}
            </div>
            {/*
                  10件を超える回答はこのパネルでは追い読みしない。
                  友だち詳細の回答一覧へ進む口を出す。
                */}
            {typeof friend.formSubmissionTotal === 'number'
              && asArray(friend.formSubmissions).length < friend.formSubmissionTotal && (
                <a
                  href={`/friends/detail?id=${friend.id}`}
                  className="text-action mt-3 inline-flex text-micro font-semibold hover:underline"
                >
                  残り{friend.formSubmissionTotal - asArray(friend.formSubmissions).length}件は友だち詳細で見る
                </a>
              )}
          </div>
        )}
      </div>

    </>
  )
  return { renderSupport, upcomingRowValue, renderTags, renderRichMenu, stripSectionHeadings, sectionBody, renderDetailSections }
}
