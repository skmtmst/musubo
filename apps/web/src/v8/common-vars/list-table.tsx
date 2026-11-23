'use client'

import { stateBadge } from './list-model'
import { placeholderText } from './model'

import { type ActionMenuItem } from '@/components/shared/action-menu'
import { isForbidden } from '@/components/shared/api-error-message'
import BulkBar from '@/components/shared/bulk-bar'
import Button from '@/components/shared/button'
import Checkbox,{ UnavailableSelection } from '@/components/shared/checkbox'
import ContextMenu,{ type ContextMenuItem } from '@/components/shared/context-menu'
import EmptyList from '@/components/shared/empty-list'
import { displayValue,emptyValue } from '@/components/shared/empty-value'
import { type FolderDotFolder } from '@/components/shared/folder-dot'
import Link from '@/components/shared/list-navigation'
import ListState from '@/components/shared/list-state'
import { RowMenu } from '@/components/shared/row-actions'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import SharedStatusPill from '@/components/shared/status-pill'
import { DataTable,NameCell,RowNameLink,TableHeadRow,Td,Th,Tr } from '@/components/shared/table'
import TruncatedText from '@/components/shared/truncated-text'
import { formatStamp } from '@/lib/common-vars'
import { formatNumber } from '@/lib/format'
import type { CommonVar } from '@line-crm/shared'
import { Braces } from 'lucide-react'
import type { Dispatch,SetStateAction } from 'react'
import { formatListDate,formatVarValue } from './list-model'
import styles from './list.module.css'

type RenderCommonVarListContext = {
  accountLoading: boolean
  activeId: string | null
  allOnPageSelected: boolean
  canWrite: boolean
  clearVarFilters: () => void
  contextItem: CommonVar | null
  contextMenuItems: ContextMenuItem[]
  current: CommonVar[]
  error: string
  filtered: CommonVar[]
  folderDotOf: (row: { folderId: string | null; }) => FolderDotFolder | null
  items: CommonVar[]
  listFailed: boolean
  listFailure: unknown
  load: () => Promise<void>
  loading: boolean
  narrow: boolean
  openMenuId: string | null
  prepareRemoveSelected: () => Promise<void>
  rowMenuItems: (item: CommonVar) => ActionMenuItem[]
  selected: Set<string>
  selectedAccountId: string | null
  setActiveId: Dispatch<SetStateAction<string | null>>
  setContextId: Dispatch<SetStateAction<string | null>>
  setOpenMenuId: Dispatch<SetStateAction<string | null>>
  setSelected: Dispatch<SetStateAction<Set<string>>>
  someOnPageSelected: boolean
  toggle: (id: string) => void
}

export function renderCommonVarList({ accountLoading, activeId, allOnPageSelected, canWrite, clearVarFilters, contextItem, contextMenuItems, current, error, filtered, folderDotOf, items, listFailed, listFailure, load, loading, narrow, openMenuId, prepareRemoveSelected, rowMenuItems, selected, selectedAccountId, setActiveId, setContextId, setOpenMenuId, setSelected, someOnPageSelected, toggle }: RenderCommonVarListContext) {
  return (accountLoading || (loading && items.length === 0 && !listFailed) ? (
    <div className={styles.skeletonRows} aria-label="読み込み中">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className={styles.skeletonRow} aria-hidden="true">
            <span className={styles.skeletonDot} />
            <span className={styles.skeletonBar} />
            <span className={styles.skeletonBar} />
          </div>
        ))}
    </div>
  ) : !selectedAccountId ? (
    <ListState kind="empty" title="LINEアカウントを選択してください" description="共通情報はLINEアカウントごとに管理します。"  icon={<Braces size={20} aria-hidden="true" />} />
  ) : listFailed ? (
    isForbidden(listFailure) ? (
      <ListState kind="error" title="共通情報を見る権限がありません" description="オーナーか管理者に、共通情報を見られるよう頼んでください。"  action={<><Button type="button" onClick={() => load()} busyLabel="処理中…">もう一度読み込む</Button><Button href="/staff" variant="secondary">できることを確かめる</Button></>} />
    ) : (
      <ListState kind="error" title="共通情報を読み込めませんでした" description={error || '読み込みに失敗しました。接続を確かめて、もう一度お試しください。'} data-design-node="RqO7O" action={<><Button type="button" onClick={() => load()} busyLabel="処理中…">もう一度読み込む</Button></>} />
    )
  ) : filtered.length === 0 ? (
    /* 修正案 D-2：空の一覧。 */
    <EmptyList
      icon={<Braces aria-hidden="true" />}
      title="まだ共通情報がありません"
      description="会社名や営業時間を1か所で持ち、メッセージに差し込みます。"
      create={{ label: '最初の共通情報を作る', href: '/contents/vars/new' }}
      canCreate={canWrite}
      filtered={items.length > 0}
      onClearFilters={clearVarFilters}
      filteredDescription="「空のまま」「期限つき」「使われていない」「下書き・止めた」や検索を外すと、すべて出ます"
    />
  ) : (
    <>
      <ContextMenu
        label={contextItem ? `共通情報「${contextItem.name}」の操作` : '共通情報の操作'}
        items={contextMenuItems}
        shouldOpen={(event) => canWrite && Boolean((event.target as HTMLElement | null)?.closest?.('tr[data-row-id]'))}
      >
        <div className={styles.tableWrap}>
          <DataTable>
            <colgroup>
              <col className={styles.colSelect} />
              <col />
              <col className={styles.colValue} />
              <col className={styles.colState} />
              {!narrow && <col className={styles.colUsage} />}
              <col className={styles.colMenu} />
            </colgroup>
            <thead>
              <TableHeadRow>
                <Th className={styles.selectCell} aria-label="選択">
                  {canWrite ? (<SaveErrorField names={["allOnPageSelected","selected","all_on_page_selected"]}><Checkbox
                      checked={allOnPageSelected}
                      indeterminate={!allOnPageSelected && someOnPageSelected}
                      onCheckedChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev)
                          for (const item of current) {
                            if (allOnPageSelected) next.delete(item.id)
                            else next.add(item.id)
                          }
                          return next
                        })
                      }
                      aria-label="このページの共通情報をすべて選ぶ"
                    /></SaveErrorField>) : <UnavailableSelection label="このページの共通情報をすべて選ぶ" />}
                </Th>
                <Th className={styles.headCell}>共通情報（差し込み名）</Th>
                <Th className={styles.headCell}>中身</Th>
                <Th className={styles.headCell}>状態</Th>
                {!narrow && <Th className={styles.headCell}>使っている所</Th>}
                <Th aria-label="操作" />
              </TableHeadRow>
            </thead>
            <tbody>
              {current.map((item, saveFieldIndex) => {
                const badge = stateBadge(item)
                const valueText = formatVarValue(item.type, item.value)
                const pending = item.nextSchedule ?? null
                const updateTitle = `最終更新 ${formatListDate(item.updatedAt)}${!pending ? ' ／ 予定なし' : ` ／ ${formatStamp(pending.effectiveFrom)} に ${formatVarValue(item.type, pending.value) || '（空）'}へ${(item.pendingScheduleCount ?? 0) > 1 ? ` ほか${(item.pendingScheduleCount ?? 1) - 1} 件` : ''}`}`
                return (
                  <Tr
                    interactive
                    key={item.id}
                    selected={selected.has(item.id)}
                    data-row-id={item.id}
                    className={styles.rowClick}
                    tabIndex={0}
                    title={updateTitle}
                    detailKey="row" onOpen={() => setActiveId(activeId === item.id ? null : item.id)}
                    onContextMenuCapture={() => setContextId(item.id)}

                  >
                    <Td className={styles.selectCell}>
                      {canWrite ? (<SaveErrorField names={[`current.${saveFieldIndex}.id`,"id","item.id","itemId"]}><Checkbox
                          checked={selected.has(item.id)}
                          onCheckedChange={() => toggle(item.id)}
                          aria-label={`${item.name}を選ぶ`}
                        /></SaveErrorField>) : <UnavailableSelection label={`${item.name}を選ぶ`} />}
                    </Td>
                    <NameCell name={
                        <div className={styles.dotLine}>
                          <>
                            <RowNameLink
                              href={`/contents/vars/edit?id=${item.id}`}

                              className={styles.nameLink}
                              onClick={(event) => event.stopPropagation()}
                            >
                              <TruncatedText value={String(item.name ?? '')} />
                            </RowNameLink>
                          </>
                        </div>
                      } description={placeholderText(item.varKey)} folder={folderDotOf(item)}
                    />
                    <Td className={styles.valueCell} title={displayValue(valueText, 'unconfigured')}>
                      {valueText || <span className={styles.valueEmpty}>{emptyValue('unconfigured')}</span>}
                    </Td>
                    <Td>
                      <SharedStatusPill tone={badge.tone}>{badge.label}</SharedStatusPill>
                    </Td>
                    {!narrow && (
                      <Td>
                        {item.usageCount === undefined ? (
                          <span className={styles.usageNone} title="使われている場所を取得できていません">{emptyValue('unknown')}</span>
                        ) : item.usageCount === 0 ? (
                          <span className={styles.usageNone}>{emptyValue('none')}</span>
                        ) : (
                          <Link
                            href={`/contents/vars/edit?id=${item.id}`}
                            title={`${formatNumber(item.usageCount)}か所で使われています`}
                            className={styles.usageLink}
                          >
                            {formatNumber(item.usageCount)}か所
                          </Link>
                        )}
                      </Td>
                    )}
                    <Td className={styles.menuCell}>
                      {/* 横並びにして、メニューの位置の目印が行を1段増やさないようにする。
                          閲覧のみ：「…」の中は変える項目だけなので、ボタンごと置かない（列の幅は残す）。 */}
                      <div className={styles.menuBox}>
                        <RowMenu
                          appearance="box"
                          size="row"
                          label={`共通情報「${item.name}」の操作`}
                          items={rowMenuItems(item)}
                          open={openMenuId === item.id}
                          onOpenChange={(next) => setOpenMenuId(next ? item.id : null)}
                        />
                      </div>
                    </Td>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
        </div>
      </ContextMenu>

      {/* まとめての帯（選ぶと表の下に出る）。 */}
      {canWrite ? <BulkBar count={selected.size} total={filtered.length} onSelectAll={() => setSelected(new Set(filtered.map(item => item.id)))} hint="対象を確認してから操作を選んでください" onClear={() => setSelected(new Set())}>
        <Button type="button" variant="secondary" onClick={() => setSelected(new Set())}>選択を外す</Button>
        <Button type="button" variant="text" textTone="danger" onClick={() => prepareRemoveSelected()} busyLabel="処理中…">選択した共通情報を削除</Button>
      </BulkBar> : null}
    </>
  ))
}
