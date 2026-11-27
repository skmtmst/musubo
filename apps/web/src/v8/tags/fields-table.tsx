'use client'

import { RowNameLink } from '@/components/shared/table';
import { GripVertical } from 'lucide-react';
import { FolderDotName } from '@/components/shared/folder-dot';
import ListState from '@/components/shared/list-state';
import { RowMenu } from '@/components/shared/row-actions';
import ContextMenu from '@/components/shared/context-menu';
import Button from '@/components/shared/button';
import { ListPager } from '@/components/templates/list-page';
import Pagination from '@/components/shared/pagination';
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table';
import { DelayedSkeleton } from '@/components/shared/skeleton';
import ReorderHandle from '@/components/shared/reorder-handle';
import { destinationLabel, knownUsageCount } from '@/components/friend-fields/field-list';
import styles from './list.module.css';
import TruncatedText from '@/components/shared/truncated-text';
import { emptyValue } from '@/components/shared/empty-value';
import type { useFieldsTab } from './use-fields-tab'
import { fieldTypeWord } from './fields-list-model'

export default function FieldsTable({ canEdit, host, items, loaded, status, error, setQuery, type, setType, setFolderFilter, pageSize, page, setPage, dragId, setDragId, leavingId, openMenuId, setOpenMenuId, openFieldDetail, load, visible, pages, currentPage, liveOrder, bodyRef, move, keyboardMove, rowMenuItems, fieldContextItems, folderDotOf, filterActive, createButton }: ReturnType<typeof useFieldsTab>) {
  const ready = loaded && (status === 'ready' || status === 'loading')
  return status === 'forbidden' ? (
    <ListState kind="forbidden" title="友だち情報欄を見る権限がありません" />
  ) : status === 'error' ? (
    <ListState kind="error" title="友だち情報欄を読み込めませんでした" description={error || undefined} onRetry={() => void load()} />
  ) : ready && items.length === 0 ? (
    <ListState kind="empty" title="まだ項目はありません" description="友だちに入力してもらう項目（誕生日・住まいなど）を作れます。" action={createButton(false)} />
  ) : ready && visible.length === 0 ? (
    <ListState kind="empty" emptyPreset="filtered" title="条件に合うものはありません" action={filterActive ? <Button type="button" onClick={() => { setQuery(''); setType('all'); setFolderFilter('') }}>条件を外す</Button> : undefined} />
  ) : (
    <DelayedSkeleton loading={!ready} skeleton={<div className={styles.skeleton} aria-busy="true" />}>
      <DataTable className={styles.table}>
        <thead>
          <TableHeadRow>
            <Th className={styles.markColGrip}><span className="sr-only">並び替え</span></Th>
            <Th className={styles.searchColName}>項目名</Th>
            <Th className={styles.fieldColType}>種類</Th>
            <Th className={styles.fieldColType}>入っている人</Th>
            <Th className={styles.fieldColType}>回答フォーム</Th>
            <Th className={styles.fieldColPlace}>出す場所</Th>
            <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
          </TableHeadRow>
        </thead>
        <tbody ref={bodyRef}>
          {liveOrder.shown.map((field) => {
            const usage = knownUsageCount(field)
            const key = `{{field.${field.fieldKey}}}`
            return (
              <Tr
                interactive
                key={field.id}
                data-reorder-id={field.id}
                onDragEnter={canEdit && dragId && !field.isInherited ? () => liveOrder.enter(field.id) : undefined}
                onDragOver={canEdit && dragId && !field.isInherited ? (event) => event.preventDefault() : undefined}
                onDrop={canEdit && dragId && !field.isInherited ? () => void move(liveOrder.dropTarget(field.id)) : undefined}
                className={`${styles.row} ${styles.fieldRow}`}
                leaving={leavingId === field.id}
                tabIndex={0}
                detailKey="field" onOpen={() => openFieldDetail(field.id)}
                 data-row-id={field.id}
              >
                <Td className={styles.markColGrip}>
                  {canEdit ? (
                    <span
                      className={styles.gripBox}
                      draggable={!field.isInherited}
                      title={field.isInherited ? '共通項目は移行後に並び替えできます' : undefined}
                      onDragStart={() => { if (!canEdit || field.isInherited) return; setDragId(field.id) }}
                      onDragEnd={() => setDragId(null)}
                    >
                      <ReorderHandle
                        label={field.name}
                        disabledReason={field.isInherited === true ? '共通項目は移行後に並び替えできます' : null}
                        onMove={(direction) => { if (!canEdit || field.isInherited) return; void keyboardMove(field.id, direction) }}
                      >
                        <GripVertical className={styles.gripIcon} aria-hidden="true" />
                      </ReorderHandle>
                    </span>
                  ) : <span className={styles.gripSpace} aria-hidden="true" />}
                </Td>
                <Td className={styles.searchColName}>
                  <ContextMenu label={`項目「${field.name}」の操作`} items={fieldContextItems(field)}>
                    <div className={styles.nameRow}>
                      <FolderDotName folder={folderDotOf(field.folderId)}>
                        {canEdit && !host ? (
                          <RowNameLink href={`/tags/fields/edit?id=${encodeURIComponent(field.id)}`} className={styles.name}  onClick={(event) => event.stopPropagation()}><TruncatedText value={String(field.name ?? '')} /></RowNameLink>
                        ) : host && canEdit ? <RowNameLink href="#" className={styles.name}  onClick={(event) => { event.preventDefault(); event.stopPropagation(); host.onEdit(field.id) }}><TruncatedText value={String(field.name ?? '')} /></RowNameLink> : <span className={styles.name} ><TruncatedText value={String(field.name ?? '')} /></span>}
                      </FolderDotName>
                    </div>

                  </ContextMenu>
                </Td>
                <Td className={styles.fieldColType}><span className={styles.cellText}>{fieldTypeWord(field.type)}</span></Td>
                <Td className={styles.fieldColType}><span className={styles.cellText}>{usage === null ? emptyValue('unknown') : `${usage}人`}</span></Td>
                <Td className={styles.fieldColType}>
                  <span className={styles.cellText} title={field.formUsageCount === undefined ? '回答フォームの使用数は未集計' : undefined}>
                    {field.formUsageCount === undefined || field.formUsageCount === 0 ? emptyValue('unknown') : `${field.formUsageCount}つ`}
                  </span>
                </Td>
                <Td className={styles.fieldColPlace}><span className={styles.cellText} title={host ? undefined : destinationLabel(field)}>{host ? emptyValue('unknown') : destinationLabel(field)}</span></Td>
                {/* 統括の［配る］は行の「…」の中（B-253：行の右端は「…」1つ）。 */}
                <Td className={styles.colMenu}>
                  <span className={styles.menuAnchor}>
                    {(!host || canEdit) ? <RowMenu
                      size="row"
                      label={`項目「${field.name}」の操作`}
                      items={rowMenuItems(field)}
                      open={openMenuId === field.id}
                      onOpenChange={(next) => setOpenMenuId(next ? field.id : null)}
                    /> : null}
                  </span>
                </Td>
              </Tr>
            )
          })}
        </tbody>
      </DataTable>

      <ListPager>
        <Pagination page={currentPage} pageCount={pages} onPageChange={setPage} ariaLabel="友だち情報欄のページ送り"
          range={{ total: visible.length, first: (currentPage - 1) * pageSize + 1, last: Math.min(currentPage * pageSize, visible.length) }} />
      </ListPager>

    </DelayedSkeleton>
  )
}
