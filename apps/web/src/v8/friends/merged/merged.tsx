'use client'

import { useDetailPanelUrl } from '@/components/shared/detail-panel';
import { requestUnsavedAction } from '@/lib/unsaved-action';
import { useListItemHref } from '@/components/shared/list-navigation';
import { useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Inbox, ChevronUp, Download, RotateCw } from 'lucide-react';

import { useAccount } from '@/contexts/account-context';
import { formatDay, formatNumber, formatYmd } from '@/lib/format';
import { useStaffRole, canManageRole } from '@/lib/staff-role';
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome';
import { PageFrame } from '@/components/templates/page-frame';
import Button from '@/components/shared/button'
import { type ActionMenuItem } from '@/components/shared/action-menu';
import { RowMenu as SharedRowMenu } from '@/components/shared/row-actions';
import KpiCard from '@/components/shared/kpi-card'
import KpiBand from '@/components/shared/kpi-band'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import ListState from '@/components/shared/list-state'
import { RowNameLink, DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table';
import { mergedPersonIdOf } from '@/components/merged-person/merged-person-view';
import type { UserRowData } from '@/components/users/users-types';
import { FriendsSectionHead } from '../shared/head';
import MergedPersonV8 from './person'
import { useMergedUsers, USERS_PAGE_SIZES } from './use-merged-users';
import styles from './merged.module.css'
import { emptyValue } from '@/components/shared/empty-value';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select';
import Notice from '@/components/shared/notice'

/*
 * ★V8 統合ユーザー（Pencil ）。/friends?tab=merged。
 *
 * データの口は今と同じ（/api/users-grouped・/api/duplicates/stats・CSV の全件書き出し）。
 * 詳細（）は今と同じく一覧の面を差し替える。URL の `?person=<id>` でも開ける。
 *
 * 絵の列「配信に使うアカウント」「結び付けた日」の値は一覧の API に無い。
 * 出せる分だけ出す：配信に使うアカウントは、友だちが1つだけの人はその名前、
 * 2つ以上の人は決め方が詳細にあるので「—」。結び付けた日は一覧の API に無いので「—」
 * （友だちの登録日は結び付けた日ではないので代わりに出さない。詳細の linkedAt を一覧にも足す依頼は Codex へ）。
 * 「複数アカウントのみ」の絞り込みは絵に口が無いので、所属アカウントの選びの末尾に入れた。
 */

/** 所属アカウントの選びの「複数アカウントのみ」（絞り込みの口は今と同じ onlyDups）。 */
const MULTI_ACCOUNTS = '__multi'

/** 結び付けた日：一覧の API に値が来たら出す。来るまでは「—」。 */
function linkedDay(row: UserRowData): string {
  const linkedAt = (row as UserRowData & { linkedAt?: string | null }).linkedAt
  if (!linkedAt) return '—'
  const [, m, d] = formatYmd(linkedAt).split('-')
  return m && d ? `${Number(m)}/${Number(d)}` : emptyValue('unknown')
}

/** 配信に使うアカウント：友だちが1つだけの人は、そのアカウントだけに届く。 */
function deliveryAccount(row: UserRowData): string {
  return row.accounts.length === 1 ? `${row.accounts[0].accountName}だけ` : emptyValue('unknown')
}

export default function MergedUsersV8() {
  const editingRef = useRef(false)
  const [openedPersonId, setOpenedPersonId] = useDetailPanelUrl('person', () => editingRef.current)
  const close = () => setOpenedPersonId(null)
  /*
   * 人の詳細は一覧と同じ URL のまま開くことがあるので、上の帯のパンくずの「統合ユーザー」で
   * 一覧へ戻す（板の頭の「← 統合ユーザーへ」は 2026-10-08 に無くした）。最新の close を呼ぶ。
   */
  const closeRef = useRef(close)
  closeRef.current = close
  usePageCrumbs(openedPersonId
    ? [{ label: '友だち', href: '/friends' }, { label: '統合ユーザー', href: '/friends?tab=merged', onSelect: () => requestUnsavedAction(() => closeRef.current()) }]
    : null)

  if (openedPersonId) {
    return <MergedPersonV8 personId={openedPersonId} onClose={close} onDirtyChange={(dirty) => { editingRef.current = dirty }} />
  }
  return <MergedUsersList onOpen={setOpenedPersonId} />
}

function MergedUsersList({ onOpen }: { onOpen: (personId: string) => void }) {
  const itemHref = useListItemHref()
  usePageTitle('友だち')
  const { selectedAccountId } = useAccount()
  const u = useMergedUsers(selectedAccountId)
  const staffRole = useStaffRole()
  const canManage = canManageRole(staffRole)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)

  const uniquePeople = u.memberTotal

  const pageCount = Math.max(1, Math.ceil(u.total / u.pageSize))
  const linkedUidCount = u.rows.filter((row) => row.identityKeyKind === 'uid').length
  const multiAccountCount = u.rows.filter((row) => row.accounts.length > 1).length

  const kpis = [
    { key: 'people', title: '統合ユーザー', value: uniquePeople, help: '重複を1人にまとめた数です。' },
    { key: 'uid', title: 'UID連携済み', value: u.loading || u.error ? null : linkedUidCount, help: 'このページに出ている人のうち、LINE UIDを根拠にまとめている数です（このページでUID確認済み）。' },
    { key: 'multi', title: '複数アカウントにいる', value: u.loading || u.error ? null : multiAccountCount, help: 'このページに出ている人のうち、2つ以上のLINEアカウントに登録がある数です。送信前に配信先の確認が必要です。' },
  ]

  return (
    <PageFrame kind="list" boardId="ADjK8">
      <FriendsSectionHead current="merged" description="結び付けて、同じ人として扱っている人の一覧です" />
      <div className={styles.body}>
        <div className={styles.actions}>
          <Button
            type="button"
            variant="secondary"
            onClick={() => u.setPendingForceRefresh(true)}
            disabled={u.refreshing}
            busy={u.refreshing}
            busyLabel="再計算中…"
            title="最新の状態を取得して一覧を更新"
          >
            <RotateCw size={16} aria-hidden="true" />
            再計算
          </Button>
          {canManage ? (
            <Button type="button" variant="secondary" onClick={() => void u.exportCsv()} disabled={u.exporting} busy={u.exporting} busyLabel="書き出し中…">
              <Download size={16} aria-hidden="true" />
              CSVで書き出す
            </Button>
          ) : null}
          {canManage ? (
            <Button variant="primary" href="/friends/identity-candidates">
              統合ユーザーを作る
            </Button>
          ) : null}
        </div>
        {u.exportError ? <Notice tone="danger" className={styles.alertPlacement}>{u.exportError}</Notice> : null}

        <KpiBand gridClassName="grid grid-cols-3" className={styles.metrics}>
          {kpis.map((kpi) => (
            <KpiCard
              key={kpi.key}
              presentation="band"
              loading={kpi.key === 'people' ? u.summaryStatus === 'loading' : u.loading}
              icon={<Inbox size={16} />}
              title={kpi.title}
              value={kpi.value}
              unit="人"
              detail={kpi.key === 'people' ? (u.summaryStatus === 'loading' ? '読み込んでいます' : u.summaryStatus === 'error' ? '読み込めませんでした' : null) : u.error ? '読み込めませんでした' : null}
              onRetry={kpi.key === 'people' && u.summaryStatus === 'error' ? () => void u.loadSummary() : undefined}
              retryLabel="再読み込み"
              help={kpi.help}
            />
          ))}
        </KpiBand>

        <div className={styles.filters}>
          <SaveErrorField names={["uid","u.uid"]}><Select
            aria-label="UID連携で絞り込む"
            width={180}
            value={u.uid}
            onChange={u.setUid}
            options={[
              { value: '', label: 'UID連携：すべて' },
              { value: 'linked', label: 'UID連携：連携済み' },
              { value: 'unlinked', label: 'UID連携：未連携・要確認' },
            ]}
          /></SaveErrorField>
          <SaveErrorField names={["MULTI_ACCOUNTS","account","u.account","_m_u_l_t_i__a_c_c_o_u_n_t_s"]}><EntitySelect
            aria-label="所属アカウントで絞り込む"
            valuePrefix="所属アカウント"
            width={200}
            value={u.onlyDups ? MULTI_ACCOUNTS : u.account}
            onChange={(value) => {
              if (value === MULTI_ACCOUNTS) {
                u.setAccount('')
                u.setOnlyDups(true)
              } else {
                u.setOnlyDups(false)
                u.setAccount(value)
              }
            }}
            options={[
              { value: '', label: '所属アカウント：すべて' },
              ...u.accountOptions.map((a) => ({ ...entityOptionMetadata(a), value: a.id, label: `所属アカウント：${a.name}` })),
              { value: MULTI_ACCOUNTS, label: '所属アカウント：複数アカウントのみ' },
            ]}
          /></SaveErrorField>
        </div>
        {u.accountOptionsError ? (
          <Notice
            tone="warn"
            className={styles.alertPlacement}
            message="所属アカウントの候補を読み込めませんでした。一覧の確認はそのまま続けられます。"
            action={
              <Button
                variant="text"
                size="inline"
                onClick={() => void u.loadAccountOptions()}
                disabled={u.accountOptionsLoading}
                busy={u.accountOptionsLoading}
                busyLabel="読み込んでいます"
              >
                候補を読み直す
              </Button>
            }
          />
        ) : null}

        <div className={styles.listArea}>
          <div className={styles.searchRow}>
            <div className={styles.search}>
              <SearchField aria-label="統合ユーザーを探す" value={u.q} onChange={u.setQ} onClear={() => u.setQ('')} placeholder="名前・メール・電話で探す" />
            </div>
            <SaveErrorField names={["pageSize","u.pageSize","page_size","u.page_size"]}><Select
              aria-label="表示件数"
              size="page-size"
              value={String(u.pageSize)}
              onChange={(value) => u.setPageSize(Number(value))}
              options={USERS_PAGE_SIZES.map((size) => ({ value: String(size), label: `${size} 件表示` }))}
            /></SaveErrorField>
          </div>

          <section className={styles.panel} aria-labelledby="merged-users-title">
            <div className={styles.panelHead}>
              <h3 id="merged-users-title" className={styles.panelTitle}>統合ユーザー</h3>
            </div>
            <DataTable className={styles.table}>
              <colgroup>
                <col />
                <col className={styles.colFriends} />
                <col className={styles.colState} />
                <col className={styles.colDate} />
                <col className={styles.colMenu} />
              </colgroup>
              <thead>
                <TableHeadRow>
                  <Th className={styles.th}>人</Th>
                  <Th className={styles.th}>結び付いた友だち</Th>
                  <Th className={styles.th}>配信に使うアカウント</Th>
                  <Th className={styles.th}>結び付けた日</Th>
                  <Th className={styles.th}><span className="sr-only">操作</span></Th>
                </TableHeadRow>
              </thead>
              <tbody>
                {u.error ? (
                  <tr><td colSpan={5} className={styles.stateCell}>
                    <ListState kind="error" title="統合ユーザーを読み込めませんでした" description="通信が切れたか、サーバが応えませんでした。" onRetry={() => void u.load()} />
                  </td></tr>
                ) : u.loading && u.rows.length === 0 ? (
                  <tr><td colSpan={5} className={styles.stateCell}><ListState kind="loading" title="読み込んでいます" /></td></tr>
                ) : u.rows.length === 0 ? (
                  <tr><td colSpan={5} className={styles.stateCell}>
                    <ListState kind="empty" emptyPreset={u.q || u.onlyDups || u.account || u.uid ? 'filtered' : 'readonly'} title={u.q || u.onlyDups || u.account || u.uid ? '条件に合う人はいません' : 'まだ友だちがいません'} description={u.q || u.onlyDups || u.account || u.uid ? '検索や絞り込みを外すと、すべて出ます。' : 'LINEで友だちになった人がここに並びます。'} action={u.q || u.onlyDups || u.account || u.uid ? <Button onClick={() => { u.setQ(''); u.setOnlyDups(false); u.setAccount(''); u.setUid(''); u.setPage(1) }}>条件を外す</Button> : undefined} />
                  </td></tr>
                ) : u.rows.flatMap((row) => {
                  const personId = mergedPersonIdOf(row)
                  const open = expanded === row.identityKey
                  const items: ActionMenuItem[] = [
                    ...(personId ? [{ id: 'open', label: "友だちの詳細を見る", onSelect: () => onOpen(personId) }] : []),
                    { id: 'accounts', label: open ? '登録アカウントを閉じる' : '登録アカウントを見る', onSelect: () => setExpanded(open ? null : row.identityKey) },
                  ]
                  const main = (
                    <Tr key={row.identityKey} className={styles.row} onOpen={personId ? () => onOpen(personId) : undefined}>
                      <Td className={styles.td}>
                        <div className={styles.person}>
                          {personId ? (
                            <RowNameLink onOpen={() => onOpen(personId)} href={itemHref('person', personId)} className={styles.name} data-qa-open="Hn9eE">{row.displayName || '名前なし'}</RowNameLink>
                          ) : (
                            <span className={`${styles.name} ${styles.nameStatic}`}>{row.displayName || emptyValue('unknown')}</span>
                          )}
                          <span className={styles.contact}>{row.emails[0] ?? row.phones[0] ?? emptyValue('unknown')}</span>
                        </div>
                      </Td>
                      <Td className={styles.td}>
                        <span className={styles.cellText} title={row.accounts.map((a) => a.accountName).join('・')}>
                          {`${row.accounts.length}（${row.accounts.map((a) => a.accountName).join('・')}）`}
                        </span>
                      </Td>
                      <Td className={styles.td}><span className={styles.cellText}>{deliveryAccount(row)}</span></Td>
                      <Td className={styles.td}><span className={styles.cellText}>{linkedDay(row)}</span></Td>
                      <Td className={styles.tdMenu}>
                        <RowMenu label={`${row.displayName || '名前なし'}の操作`} items={items} open={menuFor === row.identityKey} onOpenChange={(next) => setMenuFor(next ? row.identityKey : null)} />
                      </Td>
                    </Tr>
                  )
                  if (!open) return [main]
                  return [main, <AccountsRow key={`${row.identityKey}-accounts`} row={row} onClose={() => setExpanded(null)} />]
                })}
              </tbody>
            </DataTable>
            {u.total > 0 && !u.error ? (
              <div className={styles.pager}>
                <span className={styles.pagerCount}>
                  {`${formatNumber(u.total)} 人中 ${formatNumber((u.page - 1) * u.pageSize + 1)}〜${formatNumber(Math.min(u.page * u.pageSize, u.total))} 人`}
                </span>
                {pageCount > 1 ? <Pagination page={u.page} pageCount={pageCount} onPageChange={u.setPage} disabled={u.loading} ariaLabel="統合ユーザーのページ" /> : null}
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </PageFrame>
  )
}

function RowMenu({ label, items, open, onOpenChange }: { label: string; items: ActionMenuItem[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <span className={styles.menuBox}>
      <SharedRowMenu label={label} items={items} open={open} onOpenChange={onOpenChange} />
    </span>
  )
}

function AccountsRow({ row, onClose }: { row: UserRowData; onClose: () => void }) {
  return (
    <tr className={styles.accountsRow}>
      <td colSpan={5}>
        <div className={styles.accounts}>
          <div>
            <p className={styles.accountsTitle}>登録アカウント</p>
            <ul className={styles.accountList}>
              {row.accounts.map((a) => (
                <li key={a.friendId}>
                  <StatusBadge tone={a.isFollowing ? 'success' : 'neutral'} size="compact">{a.isFollowing ? '友だち' : 'ブロック・削除'}</StatusBadge>
                  <span className={styles.accountName}>{a.accountName}</span>
                  <span>{`登録: ${formatDay(new Date(a.joinedAt))}`}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className={styles.contacts}>
            {row.emails.length > 0 ? <p>{`メール（フォーム回答）：${row.emails.join(', ')}`}</p> : null}
            {row.phones.length > 0 ? <p>{`電話（フォーム回答）：${row.phones.join(', ')}`}</p> : null}
            {row.xUsername ? <p>{`X：@${row.xUsername}`}</p> : null}
          </div>
          <button type="button" className={styles.closeLink} onClick={onClose}>
            閉じる <ChevronUp size={16} aria-hidden="true" />
          </button>
        </div>
      </td>
    </tr>
  )
}
