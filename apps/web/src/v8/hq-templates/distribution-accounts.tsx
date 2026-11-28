'use client'

import type { Folder } from '@line-crm/shared'
import { useHqAccountFolders, type HqAccountMembership } from '@/components/shared/hq-account-picker'
import Checkbox from '@/components/shared/checkbox'
import FolderPanel, { type FolderPanelRow } from '@/components/shared/folder-panel'
import { FolderDot } from '@/components/shared/folder-dot'
import Notice from '@/components/shared/notice'
import { SaveErrorField } from '@/components/shared/save-form-errors'

export const ALL_ACCOUNTS = 'all'
const UNFILED = 'none'
type AccountMembership = HqAccountMembership

/** 統括のアカウント一覧と同じ口。配れるアカウントの集合は呼ぶ側の権限付きAPIを使う（共通の選ぶ窓と同じ読み込み）。 */
export const useDistributionFolders = useHqAccountFolders

export function accountsInFolder<T extends { id: string }>(accounts: T[], filter: string, membership: Map<string, AccountMembership> | null): T[] {
  if (filter === ALL_ACCOUNTS) return accounts
  // 未取得を未分類として扱わない。
  return accounts.filter((account) => membership?.has(account.id) && (filter === UNFILED
    ? membership.get(account.id)?.folderId === null : membership.get(account.id)?.folderId === filter))
}

export function distributionFolderRows({ accounts, folders, membership, selected, onChange, disabled }: {
  accounts: Array<{ id: string }>
  folders: Folder[]
  membership: Map<string, AccountMembership> | null
  selected: string[]
  onChange: (ids: string[]) => void
  disabled?: boolean
}): FolderPanelRow[] {
  const folderIds = new Set(folders.map((folder) => folder.id))
  const incomplete = membership !== null && accounts.some((account) => {
    const member = membership.get(account.id)
    return !member || (member.folderId !== null && (typeof member.folderId !== 'string' || !folderIds.has(member.folderId)))
  })
  const row = (id: string, label: string, folder?: Folder | null): FolderPanelRow => {
    const ids = accountsInFolder(accounts, id, membership).map((account) => account.id)
    const count = ids.filter((accountId) => selected.includes(accountId)).length
    const unknown = id !== ALL_ACCOUNTS && incomplete
    return {
      id, label, count: unknown ? null : ids.length,
      icon: id === ALL_ACCOUNTS ? undefined : <FolderDot folder={folder} />,
      leading: <SaveErrorField names={["length","ids.length","count"]}><Checkbox aria-label={`${label}をまとめて選ぶ`} checked={ids.length > 0 && count === ids.length}
        title={unknown ? '一部のアカウントの所属を確認できません。' : ids.length === 0 ? 'このフォルダには配れるアカウントがありません。' : disabled ? '配布の確認中は選択を変更できません。' : undefined}
        indeterminate={count > 0 && count < ids.length} disabled={disabled || unknown || ids.length === 0}
        onCheckedChange={(checked) => onChange(checked ? [...new Set([...selected, ...ids])] : selected.filter((accountId) => !ids.includes(accountId)))} /></SaveErrorField>,
    }
  }
  return [row(ALL_ACCOUNTS, 'すべて'), ...(membership ? [
    ...folders.map((folder) => row(folder.id, folder.name, folder)), row(UNFILED, '未分類', null),
  ] : [])]
}

export function DistributionFolderPanel({ rows, activeId, onSelect, failed, compact, hideHeading }: {
  rows: FolderPanelRow[]; activeId: string; onSelect: (id: string) => void; failed: boolean; compact?: boolean; hideHeading?: boolean
}) {
  return <>
    <FolderPanel showHeading={!hideHeading} heading={compact ? 'フォルダ' : 'アカウントのフォルダ'} headingHelp="フォルダごとに選べます。" rows={rows} activeId={activeId} onSelect={onSelect} />
    {failed ? <Notice tone="warn" message="フォルダを読み込めませんでした。ページを再読み込みしてください。" /> : rows.some((row) => row.id !== ALL_ACCOUNTS && row.count === null) ? <Notice tone="warn" message="一部のアカウントの所属を確認できません。すべてから選ぶか、ページを再読み込みしてください。" /> : null}
  </>
}
