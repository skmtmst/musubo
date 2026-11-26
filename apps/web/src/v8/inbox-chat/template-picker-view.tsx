'use client'

/*
 * テンプレートの本文を2行まで読み、中身を見る時だけ窓の右に見本を開く。
 * 左はフォルダ、一覧の下には続けて送る操作と入力欄へ入れる操作を置く。
 * スイッチを入れると番号つきで選べ、帯に送る順が出て「n通を続けて送る」になる（2つの形）。
 *
 * データ（読み込み・絞り込み・続き・差し込みの解決）は components/chats/template-picker の今の処理を使い、
 * ここは見た目だけを受け持つ。
 */
import { useInsertTokenNames } from '@/lib/use-insert-token-names'
import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { CornerDownLeft, FolderOpen, Search, Send } from 'lucide-react'
import { EntityPickerDialog } from '@/components/shared/entity-picker'
import Button from '@/components/shared/button'
import IconButton from '@/components/shared/icon-button'
import { Tabs } from '@/components/shared/tabs'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview'
import FolderPanel, { type FolderPanelRow } from '@/components/shared/folder-panel'
import Toggle from '@/components/shared/toggle'
import SearchField from '@/components/shared/search-field'
import styles from '@/components/shared/entity-picker.module.css'
import { InsertText } from '@/components/shared/insert-text-field'
import { insertDisplayText, insertTokenTraits } from '@/components/shared/insert-tokens'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import { formatNumber } from '@/lib/format'
import { CHAT_INSERT_TOKENS, PREVIEW_FAILED_TEXT, unresolvedNoticeText } from './chat-inserts'

export type TemplatePickerSideKey = 'frequent' | 'all' | 'none' | `folder:${string}`

/**
 * 選んだテンプレートを、今の相手で確かめた結果（送信と同じ解決器の render-preview）。
 * `names` には口が実際に解決できなかった差し込みだけが入る（予約がある相手には予約の値が入る）。
 * まとめて送るときは `templates` に該当するテンプレートの名前を入れる。
 */
export type TemplatePickCheck =
  | { status: 'unresolved'; names: string[]; templates: string[] }
  | { status: 'failed' }

export type TemplatePickerViewProps = {
  accountId?: string | null
  onClose: () => void
  channel: 'line' | 'email'
  canPick: boolean
  lockedReason?: string
  search: string
  onSearch: (next: string) => void
  searchInputRef: RefObject<HTMLInputElement | null>
  side: {
    active: TemplatePickerSideKey
    allCount: number | null
    noneCount: number | null
    folders: Array<{ id: string; name: string; color: string | null; count: number | null; depth?: number }>
    status: 'loading' | 'ready' | 'error'
  }
  onPickSide: (key: TemplatePickerSideKey) => void
  status: 'idle' | 'loading' | 'ready' | 'error'
  emptyText: string
  frequentNote: boolean
  templates: Array<{ id: string; name: string; content: string }>
  selectedId: string | null
  previewId: string | null
  onPreview: (id: string) => void
  onClosePreview: () => void
  onSelect: (id: string) => void
  /** 渡されたときだけ「2通以上を続けて送る」が出る */
  canPack: boolean
  packMode: boolean
  onPackMode: (next: boolean) => void
  packItems: Array<{ id: string; name: string }>
  remaining: number
  loadingMore: boolean
  onLoadMore: () => void
  /** 今の相手で確かめた本文（テンプレートの id → 解決後の本文）。確かめたものだけ入る。 */
  resolvedPreviews: Readonly<Record<string, string>>
  check: TemplatePickCheck | null
  onConfirm: () => void
  confirmDisabled: boolean
}

const PACK_MAX = 5

export default function TemplatePickerView(props: TemplatePickerViewProps) {
  const { side, packMode, packItems } = props
  const tokenNames = useInsertTokenNames(props.channel === 'line' ? props.accountId ?? null : null)
  /* 一覧の印は本文と名前の表だけで決まる。描き直しのたびに全部の本文を読み直さない。 */
  const namesKey = JSON.stringify([tokenNames.vars ?? null, tokenNames.varsComplete ?? false, tokenNames.unavailableVars ? [...tokenNames.unavailableVars] : null])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 名前の表は中身（namesKey）で比べる
  const traits = useMemo(() => new Map(props.templates.map(template => [template.id, insertTokenTraits(template.content, tokenNames)])), [props.templates, namesKey])
  const resolvedFor = (id: string) => (Object.hasOwn(props.resolvedPreviews, id) ? props.resolvedPreviews[id] : undefined)
  /*
   * 一覧の抜粋は元の本文から項目名の札（予約の日時・コース名など）で見せる。
   * 相手に合わせた値（入った値・「入りません」）は右の中身だけに出す（送る前の表示は返信欄の下）。
   */
  const insertsOf = (content: string, resolvedValue?: string) => <InsertText tokenNames={tokenNames} extraTokens={CHAT_INSERT_TOKENS} markUnknown value={content} resolvedValue={resolvedValue} />
  const noticeText = !props.check ? '' : props.check.status === 'failed'
    ? PREVIEW_FAILED_TEXT.insert
    : unresolvedNoticeText(props.check.names, tokenNames, packMode ? 'pack' : 'insert', props.check.templates)
  const previewTriggers = useRef(new Map<string, HTMLButtonElement>())
  const returnFocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (props.previewId === null && returnFocus.current) {
      previewTriggers.current.get(returnFocus.current)?.focus()
      returnFocus.current = null
    }
  }, [props.previewId])
  const preview = props.status === 'ready' ? props.templates.find(template => template.id === props.previewId) : null
  const folderRows: FolderPanelRow[] = [
    { id: 'frequent', kind: 'folder', label: 'よく使う', icon: <FolderOpen size={16} aria-hidden="true" />, count: null },
    { id: 'all', kind: 'all', label: 'すべて', count: side.allCount },
    ...(side.status === 'error' ? [] : side.folders.map((folder): FolderPanelRow => ({
      id: `folder:${folder.id}`, kind: 'folder', label: folder.name, color: folder.color, count: folder.count,
    }))),
    { id: 'none', kind: 'unfiled', label: '未分類', count: side.noneCount },
  ]

  return (
    <EntityPickerDialog
      onCancel={props.onClose}
      title="テンプレートを選ぶ"
      wide={props.channel === 'line'}
      navigation={props.channel === 'line' ? <Tabs size="compact" label="テンプレートの種類" items={[
        { label: 'メッセージ', current: true, count: side.allCount ?? undefined },
        ...['カルーセル', 'リッチメッセージ', 'リッチビデオ', '質問', 'クーポン', 'リサーチ'].map(label => ({ label, disabled: true, disabledReason: '受信箱からはまだ送れません' })),
      ]} /> : undefined}
      preview={props.channel === 'line' && preview ? {
        title: preview.name,
        onClose: () => { returnFocus.current = preview.id; props.onClosePreview() },
        // 差し込みは札・入った値・「入りません」で見せる（見本の値で埋めたり、生の記号を出したりしない）。
        content: <LinePreview fit title={null}><LinePreviewMessage accountName="" avatar={null} time="">{insertsOf(preview.content, resolvedFor(preview.id))}</LinePreviewMessage></LinePreview>,
      } : undefined}
      notice={noticeText && props.channel === 'line' ? <Notice tone={props.check?.status === 'failed' ? 'info' : 'warn'} message={noticeText} /> : undefined}
      band={packMode && packItems.length > 0 ? (
            <div className={styles.tpBand}>
              <span className={styles.tpBandLabel}>続けて送る順：</span>
              <span className={styles.tpBandOrder} title={packItems.map((item) => item.name).join(' → ')}>
                {packItems.map((item, index) => `${'①②③④⑤'[index] ?? `${index + 1}.`} ${item.name}`).join(' → ')}
              </span>
              <span className={styles.tpBandCount}>{packItems.length} / {PACK_MAX}通</span>
            </div>
      ) : undefined}
      footer={<>
            <div className={styles.tpFootLead}>
              {props.canPack ? (
                <>
                  <Toggle checked={packMode} label="2通以上を続けて送る" onChange={props.onPackMode} />
                  <span className={styles.tpFootText}>
                    <span className={styles.tpFootTitle}>2通以上を続けて送る</span>
                    <span className={styles.tpFootSub}>最大5通・選んだ順に送る</span>
                  </span>
                </>
              ) : null}
            </div>
            <div className={styles.tpFootActions}>
              <Button onClick={props.onClose}>キャンセル</Button>
              <Button variant="primary" onClick={props.onConfirm} lockedReason={props.lockedReason} disabled={!props.canPick || props.confirmDisabled}>
                {packMode
                  ? <><Send aria-hidden="true" size={16} />{formatNumber(packItems.length)}通を続けて送る</>
                  : <><CornerDownLeft aria-hidden="true" size={16} />入力欄に入れる</>}
              </Button>
            </div>
      </>}
    >
          <div className={styles.tpBody}>
            <div className={styles.tpSide}>
              <FolderPanel readOnly rows={folderRows} activeId={side.active} onSelect={(key) => props.onPickSide(key as TemplatePickerSideKey)} />
              {side.status === 'error' ? <p className={styles.tpSideNote}>フォルダを読み込めませんでした</p> : null}
            </div>
            <div className={styles.tpList}>
              <SearchField
                ref={props.searchInputRef}
                value={props.search}
                onChange={props.onSearch}
                onClear={() => props.onSearch('')}
                placeholder="テンプレート名・本文で探す"
                aria-label="テンプレート名・本文で探す"
                className={styles.tpSearchField}
              />
              {props.frequentNote ? (
                <p className={styles.tpNote}>まだ送信・使用の実績がないため、実績順ではなく登録順で表示しています。</p>
              ) : null}
              {props.status === 'loading' || props.status === 'idle' ? (
                <p className={styles.tpNote}>テンプレートを読み込んでいます。</p>
              ) : props.status === 'error' ? (
                <p className={styles.tpError}>テンプレートを読み込めませんでした。もう一度開き直してください。</p>
              ) : props.templates.length === 0 ? (
                <p className={styles.tpNote}>{props.emptyText}</p>
              ) : (
                <ul className={styles.tpCards}>
                  {props.templates.map((template) => {
                    const packIndex = packItems.findIndex((item) => item.id === template.id)
                    const chosen = packMode ? packIndex >= 0 : props.selectedId === template.id
                    return (
                      <li key={template.id} className={styles.tpCardRow}>
                        <button
                          type="button"
                          className={styles.tpCard}
                          aria-pressed={chosen}
                          onClick={() => props.onSelect(template.id)}
                        >
                          {packMode ? (
                            packIndex >= 0
                              ? <span className={styles.tpNum} aria-label={`${packIndex + 1}番目`}>{packIndex + 1}</span>
                              : <span className={styles.tpBox} aria-hidden="true" />
                          ) : null}
                          <span className={styles.tpCardText}>
                            <span className={styles.tpCardHead}>
                              <span className={styles.tpCardName} title={template.name}>{template.name}</span>
                              {props.channel === 'line' ? <TemplateTraitBadges traits={traits.get(template.id)} /> : null}
                            </span>
                            <span className={styles.tpCardBody} data-lines={props.channel === 'line' ? '2' : undefined} title={props.channel === 'line' ? insertDisplayText(template.content, { names: tokenNames, extra: CHAT_INSERT_TOKENS, markUnknown: true }) : template.content}>{props.channel === 'line' ? insertsOf(template.content) : template.content}</span>
                          </span>
                        </button>
                        {props.channel === 'line' ? <IconButton ref={node => { if (node) previewTriggers.current.set(template.id, node); else previewTriggers.current.delete(template.id) }} aria-label={`${template.name}の中身を見る`} title="中身を見る" onClick={() => props.onPreview(template.id)}><Search size={16} aria-hidden="true" /></IconButton> : null}
                      </li>
                    )
                  })}
                </ul>
              )}
              {props.remaining > 0 ? (
                <Button variant="secondary" size="compact" onClick={props.onLoadMore} disabled={props.loadingMore} busy={props.loadingMore} busyLabel="読み込み中…">
                  {`さらに表示（残り${formatNumber(props.remaining)} 件）`}
                </Button>
              ) : null}
            </div>
          </div>
    </EntityPickerDialog>
  )
}

/**
 * 一覧の名前に添える印（入り切らなければ名前の下の行）。予約の差し込みは相手の予約しだいなので「予約の知らせ用」（注意の色にしない）、
 * 誰に送っても入らないと分かる差し込みは「ここでは入らない差し込みあり」に分ける。
 */
function TemplateTraitBadges({ traits }: { traits?: ReturnType<typeof insertTokenTraits> }) {
  if (!traits || (!traits.reservation && !traits.unfillable.length)) return null
  return (
    <span className={styles.tpCardBadges}>
      {/* どの差し込みが・なぜ入らないかは、抜粋の札の説明と選んだ時の知らせで言う。 */}
      {traits.reservation ? <StatusBadge tone="info" size="compact" dot={false}>予約の知らせ用</StatusBadge> : null}
      {traits.unfillable.length ? <StatusBadge tone="warning" size="compact" dot={false}>ここでは入らない差し込みあり</StatusBadge> : null}
    </span>
  )
}
