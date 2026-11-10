'use client'

import Button from '@/components/shared/button'
import Card,{ CardContent } from '@/components/shared/card'
import Checkbox from '@/components/shared/checkbox'
import { FolderDot,type FolderDotFolder } from '@/components/shared/folder-dot'
import MediaThumbnail from '@/components/shared/media-thumbnail'
import { RowMenu } from '@/components/shared/row-actions'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import TruncatedText from '@/components/shared/truncated-text'
import type { MediaItem } from '@line-crm/shared'
import { formatMediaDetails,isKnownUnused,MediaView } from './list-model'
import styles from './list.module.css'
import { formatMediaSize } from './media-usage-display'
import { TextField as SharedTextField } from '@/components/shared/text-field'
import { Archive, ArchiveRestore, Download, Eye, FolderInput, List, Pencil, RefreshCw, Trash2 } from 'lucide-react'

export type MediaCardV8Props = {
  item: MediaItem
  view: MediaView
  displaySrc: string
  kindLabel: string
  /** 名前の前の丸に出すフォルダ（左のフォルダの列と同じもの）。未分類は null。 */
  folder: FolderDotFolder | null
  canManageMedia: boolean
  managementPermissionReason: string
  selected: boolean
  downloading: boolean
  menuOpen: boolean
  renaming: { id: string; value: string; revision?: number } | null
  renamingBusy: boolean
  renameConflict: boolean
  renameError: string
  onToggleSelect: () => void
  onPreview: () => void
  onToggleMenu: () => void
  onCloseMenu: () => void
  onDetail: () => void
  onDownload: () => void
  onRenameStart: () => void
  onRenameCancel: () => void
  onRenameChange: (value: string) => void
  onRenameConfirm: () => void
  onRenameReload: () => void
  onMoveStart: () => void
  onArchiveStart: () => void
  onDeleteStart: () => void
  onReplaceStart: () => void
}

/*
 * ★V8 の札1枚。載せる中身は 管理画面 の札と同じ（縮小画像・種別の札・退避の札・
 * ファイル名・形式と容量・使用先・名前の直し）。
 * 操作は「…」の中へ集める。使うものは消せない約束も 管理画面 と同じ。
 * 退避済みは編集・削除の押し口を出さず、戻す口だけを残す。
 * 読み取り専用の人にも「…」でプレビューとダウンロードを渡す。
 */
export function MediaCardV8({
  item,
  view,
  displaySrc,
  kindLabel,
  folder,
  canManageMedia,
  managementPermissionReason,
  selected,
  downloading,
  menuOpen,
  renaming,
  renamingBusy,
  renameConflict,
  renameError,
  onToggleSelect,
  onPreview,
  onToggleMenu,
  onCloseMenu,
  onDetail,
  onDownload,
  onRenameStart,
  onRenameCancel,
  onRenameChange,
  onRenameConfirm,
  onRenameReload,
  onMoveStart,
  onArchiveStart,
  onDeleteStart,
  onReplaceStart,
}: MediaCardV8Props) {
  const selectTitle = item.archivedAt
    ? '退避済みは削除できません。一覧へ戻してから削除してください'
    : item.usageCount == null
      ? '使用先を確認できないため選べません'
      : item.usageCount > 0
        ? '使用先から外すまで削除できません'
        : undefined
  const mediaMenu = (
    <span className={styles.menuWrap} title={canManageMedia ? undefined : managementPermissionReason}>
      <RowMenu
        appearance="plain"
        label={`${item.filename}のその他操作`}
        menuLabel={`${item.filename}の操作`}
        open={menuOpen}
        onOpenChange={(next) => (next ? onToggleMenu() : onCloseMenu())}
        triggerProps={{ 'data-qa-open': 'YfTfJ' }}
        items={[
          {
            id: 'preview',
            label: 'プレビュー',
            icon: <Eye size={16} aria-hidden="true" />,
            onSelect: onPreview,
          },
          ...(canManageMedia
            ? [{ id: 'detail', label: '使用箇所を見る', icon: <List size={16} aria-hidden="true" />, onSelect: onDetail }]
            : []),
          ...(canManageMedia && !item.archivedAt
            ? [{ id: 'rename', label: '名前を変える', icon: <Pencil size={16} aria-hidden="true" />, onSelect: onRenameStart }]
            : []),
          ...(canManageMedia && !item.archivedAt
            ? [{ id: 'move', label: 'フォルダへ移す', icon: <FolderInput size={16} aria-hidden="true" />, onSelect: onMoveStart }]
            : []),
          {
            id: 'download',
            label: 'ダウンロード',
            icon: <Download size={16} aria-hidden="true" />,
            disabled: downloading,
            disabledReason: downloading ? 'ファイルを取り出しています' : undefined,
            onSelect: onDownload,
          },
          ...(canManageMedia
            ? [{ id: 'archive', label: item.archivedAt ? '一覧へ戻す' : 'アーカイブ', icon: item.archivedAt ? <ArchiveRestore size={16} aria-hidden="true" /> : <Archive size={16} aria-hidden="true" />, onSelect: onArchiveStart }]
            : []),
          // 削除確認の窓の撮影は「…」→この項目の2手で開ける。
          ...(canManageMedia && !item.archivedAt
            ? [{ id: 'delete', label: '削除する', icon: <Trash2 size={16} aria-hidden="true" />, tone: 'danger' as const, dividerBefore: true, qaOpen: 'YfTfJ', onSelect: onDeleteStart }]
            : []),
          ...(canManageMedia && !item.archivedAt
            ? [{ id: 'replace', label: '別のメディアに差し替える', icon: <RefreshCw size={16} aria-hidden="true" />, onSelect: onReplaceStart }]
            : []),
        ]}
      />
    </span>
  )
  return (
    <Card padding="rows" layout={view === 'grid' ? 'media' : 'horizontal'} overflow="hidden">
      <button
        onClick={onPreview}
        title="プレビューを見る"
        aria-label={`${item.filename}のプレビューを見る`}
        className={view === 'grid' ? styles.thumbButton : `${styles.thumbButton} ${styles.thumbNarrow}`}
      >
        <MediaThumbnail kind={item.kind} src={displaySrc} alt={item.filename} />
      </button>

      <CardContent className={view === 'grid' ? styles.cardBody : styles.rowBody}>
        {renaming ? (
          <div className={styles.renameBox}>
            <SaveErrorField names={["value","renaming.value"]}><SharedTextField
              type="text"
              autoFocus
              value={renaming.value}
              onChange={(e) => onRenameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
                if (e.key === 'Enter') onRenameConfirm()
                if (e.key === 'Escape') onRenameCancel()
              }}
              aria-label="ファイル名"
              className={styles.renameInput}
            /></SaveErrorField>
            {renameError && (
              <p className={styles.renameError} role="alert">{renameError}</p>
            )}
            {renameConflict ? <Button variant="secondary" onClick={onRenameReload} disabled={renamingBusy}>最新を読み直す</Button> : null}
            {mediaMenu}
            <div className={styles.renameActions}>
              <Button variant="secondary" onClick={onRenameCancel} disabled={renamingBusy}>
                キャンセル
              </Button>
              <Button variant="primary" onClick={onRenameConfirm} disabled={renamingBusy || renameConflict} busy={renamingBusy} busyLabel="保存中…">
                保存する
              </Button>
            </div>
          </div>
        ) : (
          <>
            <span className={styles.nameRow}>
              {canManageMedia ? (
                <SaveErrorField names={["selected"]}><Checkbox
                  checked={selected}
                  disabled={!isKnownUnused(item) || !!item.archivedAt}
                  onCheckedChange={onToggleSelect}
                  aria-label={`${item.filename}を選ぶ`}
                  title={selectTitle}
                /></SaveErrorField>
              ) : null}
              {item.archivedAt ? (
                <span
                  className={styles.archivedBadge}
                  title={item.archiveReason ? `退避の理由：${item.archiveReason}` : '退避済み'}
                >
                  退避済み
                </span>
              ) : null}
              <span className={styles.nameDot}>
                <FolderDot folder={folder} />
              </span>
              <span className={styles.fileName} >
                <TruncatedText value={String(item.filename ?? '')} />
              </span>
              {mediaMenu}
            </span>
            <p className={styles.meta} title={formatMediaDetails(item)}>
              {`${kindLabel}・${formatMediaSize(item.sizeBytes)}`}
            </p>
            <p className={item.usageCount === undefined || item.usageCount === 0 ? `${styles.usage} ${styles.usageIdle}` : `${styles.usage} ${styles.usageUsed}`}>
              {item.usageCount === undefined
                ? '使用先：確かめられません'
                : item.usageCount === 0
                  ? '使用先：どこでも使っていない'
                  : `使用先：${item.usageCount} か所`}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
