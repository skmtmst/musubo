'use client'

import Notice from '@/components/shared/notice'
import { jstCalendar as japanCalendar } from '@/lib/jst-datetime'
import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { Tag, TagGroup } from '@line-crm/shared'
import { api, ApiError, type TagDependencies, type TagDeleteImpactReferences } from '@/lib/api'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Button from '@/components/shared/button'
import { formatDay, formatNumber } from '@/lib/format'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextField as SharedTextField } from '@/components/shared/text-field'

export const UNGROUPED = '__ungrouped__'

/** 色未設定のフォルダに出す中性の点の色（V8側と共用するため1か所に置く）。 */
export const FOLDER_FALLBACK_COLOR = '#8b938d'

/**
 * 一覧に中身を出せるかどうか。
 *
 * **`items.length === 0` だけを見て「ありません」と出さない**ための状態。
 * 読み込みに失敗しても同じ文が出ていて、運用する人からは「登録したものが
 * 消えた」ように見えていた（PR #216 と同じ壊れ方）。403 も分ける。
 * 「見せてよい人ではない」を「表示できませんでした」と出すと、
 * 直らない再読み込みを繰り返させることになる。
 */

/* ---- 4-1 の表のための小物。設計 `HrwyW` の値をそのまま持つ ---- */

/** 並び替えのつまみ。設計 `DaXeY`（lucide grip-vertical・16px・hairline）。 */
/**
 * 連動の札。設計 `B9QCB3`（緑）／`IoiWQ`（黄）／`Ws7fo`（灰）。
 *
 * 灰色の「他N」は、マイル以外の連動アクション（テキスト送信・
 * テンプレート送信・シナリオ開始など）の数。0件のときサーバーは
 * `otherActionCount` を省くので、**「他0」は出さない**。
 */
export const SOURCE_LABELS: Record<NonNullable<Tag['assignSource']>, string> = {
  ec: 'EC連携',
  line_login: 'LINE Login',
  form: '回答フォーム',
  ec_purchase: 'EC購入',
  manual: '手動',
  birthday: '誕生日ルール',
}

/**
 * 自動付与のもと。
 *
 * **無いときは `—`。「手動」と書かない。** サーバーは「いまのデータから
 * 出どころを断定できるものだけ」を返す（`friend_tags` に付与元が
 * 残っていないため、一般のタグを manual と推測しない）。
 * ここで「手動」と埋めると、断定できなかったものを断定したことになる。
 */
export function sourceLabel(tag: Tag): string {
  return tag.assignSource ? SOURCE_LABELS[tag.assignSource] : '—'
}

/** 設計 `lML5Q`「配信3・フォーム1」の呼び分けと並び順。 */
const USAGE_LABELS: Array<[keyof NonNullable<Tag['usedIn']>, string]> = [
  ['broadcasts', '配信'],
  ['forms', 'フォーム'],
  ['scenarios', 'シナリオ'],
  ['autoReplies', '自動応答'],
  ['savedSearches', '保存検索'],
]

/**
 * 使用先。設計は「配信3・フォーム1」のように数まで出す。
 *
 * **`withCounts=1` で読んでいるので、`usedIn` が無いのは「0件」。**
 * 集計していないわけではないので、`—` ではなく言い切ってよい。
 * （`withCounts` を付けずに読む画面でこの関数を使うときは、この前提が崩れる）
 *
 * **「なし」であって「未使用」ではない。** 2026-08-26 に「未使用」の定義が
 * 「友だち0人**かつ**全参照0件」で確定した。この列が見ているのは参照だけなので、
 * 友だち200人・参照0件のタグをここで「未使用」と書くと、絞り込みやKPIの
 * 「未使用」と別の意味になる。同じ画面で1つの言葉に2つの意味を持たせない。
 */
export function usageLabel(tag: Tag): string {
  if (!tag.usedIn) return 'なし'
  const parts = USAGE_LABELS
    .map(([key, label]) => (tag.usedIn?.[key] ? `${label}${tag.usedIn[key]}` : null))
    .filter(Boolean)
  return parts.length ? parts.join('・') : 'なし'
}

/**
 * 整理候補の理由。サーバーがタグごとに返す。
 *
 * `unused` … 友だち0人**かつ**全18種の参照0件
 * `duplicate_name` … 正規化した名前が他のタグと重なる
 *   （NFKC → 前後空白除去 → 連続空白を1つ → 小文字化）
 *
 */
/**
 * 整理候補の数え方が**サーバーから来ているか**。
 *
 * **1つでも欠けていたら「来ていない」とみなす。** 揃っていないまま数えると、
 * 欠けたぶんだけ少ない数を出すことになる。少なめに出た「未使用」は、
 * 「整理するものは無い」と読まれて放置される。
 *
 * `cleanupReasons` は `withCounts=1` のとき**理由が無くても `[]` で必ず返す**
 * 約束。省略＝未取得（`docs/v8-design-rules.md` §5）。
 */
export function cleanupKnown(items: Tag[], ready: boolean): boolean {
  // 読み込み中の空配列と、取得済みの0件を区別する。後者は `0件` と出せる。
  return ready && items.every((tag) => Array.isArray(tag.cleanupReasons))
}

/**
 * 未使用。**友だち0人かつ全18種の参照0件**（kenta 確定 2026-08-26）。
 *
 * 参照だけを見ていた頃は、200人に付いているタグまで「未使用」に入り、
 * 整理候補として消させるところだった。
 *
 * サーバーが `cleanupReasons` を返しているならそれに従う。**画面とサーバーで
 * 別々に数えない**（別々に数えると、同じ画面のKPIと絞り込みで数が食い違う）。
 */
export function isUnused(tag: Tag): boolean {
  if (Array.isArray(tag.cleanupReasons)) return tag.cleanupReasons.includes('unused')
  return !tag.usedIn && (tag.friendCount ?? 0) === 0
}

/** 連動が1つでもあるか。「連動あり」の絞り込みと削除の確認で使う。 */
export function hasLinkedActions(tag: Tag): boolean {
  return Boolean(tag.mileageReward || tag.referralMileageReward || tag.mileageMultiplierBps || tag.otherActionCount)
}

/**
 * 今月（日本時間）に作られたか。「今月増えたタグ」の判定。
 *
 * サーバーは UTC の ISO で返す。日本時間で数えないと、月初と月末の
 * 9時間ぶんがずれる（8/1 の朝に作ったタグが7月扱いになる）。
 */
export function isThisMonth(value: string): boolean {
  const month = (d: Date) => {
    if (Number.isNaN(d.getTime())) return null
    const jst = japanCalendar(d)
    return `${jst.getUTCFullYear()}-${jst.getUTCMonth()}`
  }
  return month(new Date(value)) === month(new Date())
}

/**
 * 登録日。設計は `2026/01/11`（0埋め）。
 * getFullYear 系は端末の地域で読むので、日本より遅い地域で開くと
 * 登録日が前日にずれる。ほかの一覧と同じく JST 固定で出す（#640 D-3）。
 */
export function formatDate(value: string): string {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  return formatDay(d)
}

/**
 * 設計 `UOmne` の「よく使う」。**5つとも効く。**
 *
 * 2026-08-26 まで3つしか無く、しかも「今月増えた」は絞り込みの中に
 * 対応する枝が無くて**押しても何も起きなかった**。
 */
export const QUICK_FILTERS: Array<[string, string]> = [
  ['unused', '未使用のタグ'],
  ['recent', '今月増えたタグ'],
  ['auto', '自動付与あり'],
  ['linked', '連動あり'],
]

export const FRIEND_ATTRIBUTES_QA_GROUPS: TagGroup[] = [
  { id: 'qa-vip', accountId: null, name: 'VIP', sortOrder: 0, color: 'var(--color-status-warn-deep)', createdAt: '', updatedAt: '' },
  { id: 'qa-pet', accountId: null, name: 'ペット', sortOrder: 1, color: 'var(--color-status-danger)', createdAt: '', updatedAt: '' },
  { id: 'qa-member', accountId: null, name: '会員', sortOrder: 2, color: 'var(--color-accent)', createdAt: '', updatedAt: '' },
  { id: 'qa-purchase', accountId: null, name: '購入', sortOrder: 3, color: 'var(--color-status-info)', createdAt: '', updatedAt: '' },
]

export const FRIEND_ATTRIBUTES_QA_TAGS: Tag[] = [
  ['EC顧客連携済み', 'qa-purchase', 5, 10, 0, 12000],
  ['LINEログイン連携済み', 'qa-member', 5, 0, 0, null],
  ['定期便会員', 'qa-member', 5, 10, 5, 15000],
  ['商品到着確認対象', 'qa-purchase', 3, 1, 0, null],
  ['未契約', '', 3, 0, 0, null],
  ['誕生日クーポン対象', 'qa-vip', 0, 20, 0, null],
].map(([name, groupId, friendCount, mileageReward, referralMileageReward, mileageMultiplierBps], index) => ({
  id: `qa-${index}`,
  name: String(name),
  color: 'var(--color-ink-faint)',
  groupId: String(groupId),
  friendCount: Number(friendCount),
  mileageReward: Number(mileageReward),
  referralMileageReward: Number(referralMileageReward),
  mileageMultiplierBps: mileageMultiplierBps == null ? null : Number(mileageMultiplierBps),
  mileageMultiplierPriority: 0,
  isStarred: index < 2,
  displayOrder: index,
  createdAt: '2026-01-13T00:00:00.000Z',
}))

const MANUAL_REFS: Array<[keyof TagDeleteImpactReferences, string]> = [
  ['broadcasts', '一斉配信'],
  ['forms', '回答フォーム'],
  ['templates', 'テンプレート'],
  ['richMenus', 'リッチメニュー'],
  ['webinars', 'ウェビナー'],
  ['events', 'イベント予約'],
  ['bookingMenus', '予約メニュー'],
  ['entryRoutes', '流入経路'],
  ['trackedLinks', '計測リンク'],
  ['affiliateOffers', 'アフィリエイト案件'],
  ['analyticsFunnels', 'ファネル'],
]

const AUTO_REFS: Array<[keyof TagDeleteImpactReferences, string]> = [
  ['scenarios', 'シナリオ'],
  ['autoReplies', '自動応答'],
  ['savedSearches', '保存検索'],
  ['automations', 'オートメーション'],
  ['commonActions', '共通アクション'],
  ['reminders', 'リマインダ'],
  ['friendAddSettings', '友だち追加時の配信'],
]

/** 「一斉配信3・回答フォーム1」。**0件のものは出さない。** */
function refSummary(
  refs: TagDeleteImpactReferences,
  labels: Array<[keyof TagDeleteImpactReferences, string]>,
): string {
  const parts = labels.filter(([key]) => refs[key] > 0).map(([key, label]) => `${label}${refs[key]}`)
  return parts.length ? parts.join('・') : 'なし'
}

/** アフィリエイト参照は削除不可の警告欄で目立たせ、通常の参照行へ重ねて出さない。 */
function manualRefSummary(refs: TagDeleteImpactReferences): string {
  return refSummary(refs, MANUAL_REFS.filter(([key]) => key !== 'affiliateOffers'))
}

/**
 * 設計 `★ 管理画面 4-1-F タグ削除の確認ダイアログ`（`dKlkz`）の影響5行。
 *
 * 「名前・値・結果」の3列。**取れていないときは `—`。0とは書かない。**
 * 何が起きるか（結果）は設定によらず決まっているので、値が取れなくても出す。
 */
function deleteImpactRows(
  tag: Tag,
  impact: TagDependencies | null,
): Array<{ name: string; value: string; result: string }> {
  const refs = impact?.referenceCounts
  const hasMileage = impact?.mileageImpact.configured ?? ((tag.mileageReward ?? 0) > 0 || (tag.referralMileageReward ?? 0) > 0 || tag.mileageMultiplierBps != null)
  const linked = [
    tag.mileageReward ? `本人+${tag.mileageReward}` : null,
    tag.referralMileageReward ? `紹介者+${tag.referralMileageReward}` : null,
    tag.mileageMultiplierBps ? `${tag.mileageMultiplierBps / 10000}倍` : null,
    tag.otherActionCount ? `アクション${formatNumber(tag.otherActionCount)}件` : null,
  ].filter(Boolean).join('／')

  const rows = [
    {
      name: '付与人数',
      // 人数はサーバーが数え直したものを使う。取れなければ一覧の値。
      value: `${formatNumber((impact?.friendCount ?? tag.friendCount ?? 0))}人`,
      result: 'タグが外れます',
    },
    { name: '参照先', value: refs ? manualRefSummary(refs) : '—', result: '絞り込み条件から外れます' },
    { name: '参照先（自動）', value: refs ? refSummary(refs, AUTO_REFS) : '—', result: '開始条件が空になります' },
    { name: '連動の停止', value: impact?.mileageImpact.configured ? `本人+${impact.mileageImpact.self}／紹介者+${impact.mileageImpact.referrer}／${impact.mileageImpact.multiplier ? `${impact.mileageImpact.multiplier / 10000}倍` : '倍率なし'}／アクション${impact.linkedActions.length || tag.otherActionCount || 0}件` : linked || 'なし', result: '以後は実行されません' },
    /*
      **数は出さない。口も待たない。**（kenta 判断 2026-08-26）

      設計の絵は「1,450 mile」だが、運用者がここで知りたいのは
      「消したら取り上げられるのか」であって、何マイルかではない。
      数が無くても判断はできる。`—` のままにすると「まだ数えている」
      ように見え、いつまでも埋まらない欄になる。
    */
    ...(hasMileage ? [{ name: '積んだマイル', value: 'そのまま残る', result: '取り消されません' }] : []),
  ]
  if (impact?.linkedActions.length) {
    rows.push({ name: '使用中の版', value: impact.linkedActions.map((item) => `${item.state === 'published' ? '公開' : '下書き'} 第${item.version}版`).join('・'), result: impact.linkedActions.some((item) => item.state === 'published') ? '公開している版があるので消せません' : '公開版はありません' })
  }
  return rows
}

export function DeleteTagDialog({ tag, accountId, onCancel, onArchived }: { tag: Tag; accountId: string | null; onCancel: () => void; onArchived: (notice?: string) => void }) {
  const key = JSON.stringify([accountId, tag.id])
  const scope = useRef({ key, generation: 1 })
  if (scope.current.key !== key) scope.current = { key, generation: scope.current.generation + 1 }
  const generation = scope.current.generation
  const [checkedGeneration, setCheckedGeneration] = useState(0)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  /**
   * 削除して何が失われるか（`GET /api/tags/:id/delete-impact`）。
   *
   * **DELETE 側にはまだ強制停止が入っていない。** 止めるのはここ。
   * 読み込み中と失敗のあいだも押せなくする。失敗を「参照0件」と読み違えて
   * 使用中のタグを消させないため。
   */
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const close = () => { if (active.current && !saving) { active.current = false; onCancel() } }
  const [impact, setImpact] = useState<TagDependencies | null>(null)
  const [impactStatus, setImpactStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    const requestGeneration = generation
    setText('')
    setImpact(null)
    setCheckedGeneration(0)
    setSaving(false)
    setSaveError('')
    setImpactStatus('loading')
    ;(async () => {
      try {
        if (!accountId) throw new Error('account required')
        const res = await api.tags.dependencies(tag.id, accountId)
        if (cancelled || requestGeneration !== scope.current.generation) return
        if (!res.success) throw new Error(res.error)
        setImpact(res.data)
        setCheckedGeneration(requestGeneration)
        setImpactStatus('ready')
      } catch {
        if (!cancelled && requestGeneration === scope.current.generation) setImpactStatus('error')
      }
    })()
    return () => { cancelled = true }
  }, [accountId, tag.id, generation])

  const blocked = impactStatus !== 'ready' || checkedGeneration !== generation || !impact || !accountId || saving
  const blockedReason = impactStatus === 'loading'
    ? '影響を確認しています'
    : impactStatus === 'error'
      ? '影響を確認できませんでした。時間をおいて開き直してください'
      : ''

  const archive = async () => {
              if (!active.current || blocked || text !== tag.name || !impact || !accountId || checkedGeneration !== scope.current.generation) return
              const requestGeneration = scope.current.generation
              setSaving(true); setSaveError('')
              try {
                await api.tags.archive(tag.id, accountId, {
                  expectedVersion: impact.tag.version,
                  impactRevision: impact.revision,
                }, crypto.randomUUID())
                if (!active.current || requestGeneration !== scope.current.generation) return
                onArchived(`「${tag.name}」を保管しました`)
              } catch (reason) {
                if (!active.current || requestGeneration !== scope.current.generation) return
                /*
                 * 「もう整理済み」は失敗ではない。着きたかった状態にはもう着いている
                 * ので、赤い失敗ではなく、成功と同じ通知で見せて一覧を読み直す。
                 * 409 をそのまま失敗として出すと、利用者からは「押したのに何が
                 * 起きたか分からない」に見える（#708 の裁定）。
                 */
                if (reason instanceof ApiError && reason.code === 'already_archived') {
                  onArchived('このタグはすでに保管済みです。')
                  return
                }
                setSaveError('保管できませんでした。影響を読み直して、もう一度お試しください。')
                setSaving(false)
              }

  }
  return <Dialog open size="large" tone="destructive" confirmation dirty={false}
    busy={saving} onCancel={close} title={`「${tag.name}」を保管しますか？`}
    titleIcon={<Trash2 aria-hidden="true" />} error={saveError || undefined}
    footer={<DialogActions leadingAction={blockedReason || undefined}>
      <Button onClick={close} disabled={saving}>キャンセル</Button>
      <Button variant="danger" disabled={blocked || text !== tag.name} busy={saving} onClick={() => void archive()}>このタグを保管する</Button>
    </DialogActions>}
  >
    <OperationTargetSummary accounts={[{ id: accountId ?? '' }]} />
    <div data-qa-dialog="tag-delete" data-impact={impactStatus}>
      <p className="mt-1 text-sm text-ink-secondary">このタグを使っている場所と、外れる友だちを確認してください。保管すると友だちから外れ、一覧には「保管済み」として残ります。元に戻せません。保管しても、過去の履歴は残ります。</p>
        <dl className="mt-5 divide-y divide-hairline overflow-hidden rounded-control border border-hairline text-sm">
          {deleteImpactRows(tag, impact).map((row) => (
            <div key={row.name} className="flex items-baseline gap-3 px-4 py-3">
              <dt className="w-[130px] shrink-0 text-ink-secondary">{row.name}</dt>
              <dd className="min-w-0 flex-1 font-bold text-ink">{row.value}</dd>
              <span className="shrink-0 text-xs text-ink-faint">{row.result}</span>
            </div>
          ))}
        </dl>

        {/* 設計 `WrDxu`。使用中で止まっているときだけ、その理由をここに出す。 */}
        {impactStatus === 'ready' && impact && !impact.canDelete && (
          <Notice tone="danger" data-qa="tag-delete-blocked-warning">
            {impact.referenceCounts.affiliateOffers > 0 ? (
              <><p className="font-bold">アフィリエイトのオファーで使用中のタグは保管できません</p><p className="mt-1">その場合は、先にオファー側の設定からこのタグを外してください。</p></>
            ) : (
              <><p className="font-bold">有効な参照があるタグは保管できません</p><p className="mt-1">参照中の設定を確認してから操作してください。</p></>
            )}
          </Notice>
        )}

        {/* 設計 `seGRS`。 */}
        <label className="mt-4 block">
          <span className="mb-1.5 block text-xs font-semibold text-ink-secondary">確認のため、タグ名を入力してください</span>
          <SaveErrorField names={["text"]}><SharedTextField value={text} onChange={(event) => setText(event.target.value)} placeholder={tag.name} disabled={blocked} className="w-full rounded-control border border-hairline px-3 py-2.5 text-sm placeholder:text-ink-disabled focus:border-danger" /></SaveErrorField>
        </label>
    </div>
  </Dialog>
}
