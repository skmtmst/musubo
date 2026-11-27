import type { HqTemplateListItem } from '@/lib/hq-templates-api'
import type { HqTemplateVersionDisplay } from '@line-crm/shared'
import { inUseVersionOf } from './detail'
const knownCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * 回答フォームの題の下の1行。いまの版がまだ配った先に届いていなければ、配った版との違いを出す（API-18 の版の履歴）。
 */
export function formStatusLine(row: HqTemplateListItem | undefined, versions?: readonly HqTemplateVersionDisplay[] | null): string {
  if (!row) return '下書き・まだ配っていません（保存してから配ると、選んだアカウントへ届きます）'
  if (!knownCount(row.distributed_account_count)) return '下書き・配布状況を確認できません。再読み込みして確認してください。'
  if (row.distributed_account_count === 0) return '下書き・まだ配っていません（保存してから配ると、選んだアカウントへ届きます）'
  const current = versions?.find((version) => version.is_current)
  const inUse = inUseVersionOf(versions ?? null)
  if (current && inUse && current.version !== inUse.version) return `下書き・配った版${inUse.version}と違うところがあります（保存してから配ると、配った先へ新しい版として届きます）`
  return '下書き（保存してから配ると、配った先へ新しい版として届きます）'
}

/** 右の列「配った先」の文。名前は API-14 の最大3件と、ほかの数。 */
export function formDistributedLine(row: HqTemplateListItem | undefined): string {
  if (!row) return 'まだどのアカウントにも配っていません。保存してから配ると、各アカウントでは回答フォームとして使えます。'
  const count = row.distributed_account_count
  if (!knownCount(count)) return '配布状況を確認できません。再読み込みして確認してください。'
  if (count === 0) return 'まだどのアカウントにも配っていません。保存してから配ると、各アカウントでは回答フォームとして使えます。'
  const names = (row.distributed_account_names ?? []).map((name) => name.replace(/^然\s*-NEN-\s*/, ''))
  const more = row.distributed_account_more ?? 0
  const list = names.length ? `（${names.join('・')}${more > 0 ? `・ほか${more}` : ''}）` : ''
  return `${count} アカウント${list}に配っています。各アカウントでは回答フォームとして使えます。`
}
