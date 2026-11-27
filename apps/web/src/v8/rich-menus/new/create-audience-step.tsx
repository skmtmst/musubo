'use client'

import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import ConditionBuilder from '@/components/shared/condition-builder'
import { Field,TextInput } from '@/components/shared/form-controls'
import RadioCard,{ RadioCardGroup } from '@/components/shared/radio-card'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import SectionHeader from '@/components/shared/section-header'
import SegmentedControl from '@/components/shared/segmented'
import {
type RichMenuGroupListItem
} from '@/lib/api'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import {
type SegmentCondition
} from '@/lib/segment-condition'
import {
CircleDashed,
Repeat,
Tag,
Users
} from 'lucide-react'
import type { Dispatch,JSX,SetStateAction } from 'react'
import styles from '../../../app/rich-menus/new/create-v8.module.css'
import Notice from '@/components/shared/notice'
import { formatNumber } from '@/lib/format'

type RenderHqAudienceStepContext = {
  audience: "all" | "tag" | "none" | "targeted"
  defaultOpen: boolean
  host: RichMenuCreateHost | undefined
  hqTagName: string
  setAudience: Dispatch<SetStateAction<"all" | "tag" | "none" | "targeted">>
  setDefaultOpen: Dispatch<SetStateAction<boolean>>
  setHqTagName: Dispatch<SetStateAction<string>>
}

export function renderHqAudienceStep({ audience, defaultOpen, host, hqTagName, setAudience, setDefaultOpen, setHqTagName }: RenderHqAudienceStepContext) {
    if (!host) return null
    return (
      <>
        {host.distribute}
        <Card variant="form" gap="normal">
          <SectionHeader
            title="各アカウントで誰に出すか"
            help="配った先のアカウントで、このメニューを誰に出すかの初めの形です。配ったあとに各アカウントで変えられます。"
            helpLabel="各アカウントで誰に出すかの説明"
          />
          <SaveErrorField names={["audience","displayAudience"]}><RadioCardGroup legend="各アカウントで誰に出すか" className="grid grid-cols-3 gap-3">
            <RadioCard
              name="audience"
              value="all"
              checked={audience === 'all'}
              onChange={() => setAudience('all')}
              title="全員"
              icon={<Users aria-hidden="true" />}
              note="全員の既定のメニューにする"
            />
            <RadioCard
              name="audience"
              value="tag"
              checked={audience === 'tag'}
              onChange={() => setAudience('tag')}
              title="タグが付いた人"
              icon={<Tag aria-hidden="true" />}
              note="同じ名前のタグの人に出す"
            />
            <RadioCard
              name="audience"
              value="targeted"
              checked={audience !== 'all' && audience !== 'tag'}
              onChange={() => setAudience('targeted')}
              title="決めない"
              icon={<CircleDashed aria-hidden="true" />}
              note="誰に出すかは各アカウントで"
            />
          </RadioCardGroup></SaveErrorField>
          {audience === 'tag' ? (
            <Field label="タグの名前" htmlFor="rm-hq-tag" help="配った先のアカウントにある、同じ名前のタグが付いた人に出します。無いアカウントには配れません。">
              <SaveErrorField names={["displayTagName","tag"]}><TextInput id="rm-hq-tag" value={hqTagName} onChange={(e) => setHqTagName(e.target.value)} placeholder="例：会員" maxLength={100} /></SaveErrorField>
            </Field>
          ) : null}
          <Notice tone="info" icon={<span><Repeat size={16} aria-hidden /></span>}>
            <span>
              {audience === 'all'
                ? '「全員」にすると、配った先で既定のメニューとして届きます。LINE に出て、いまの既定のメニューと入れ替わるのは、各アカウントで公開したときです。'
                : audience === 'tag'
                  ? '配った先では、同じ名前のタグが付いた人に出します。タグが無い・同じ名前が複数あるアカウントは、配る前の確認で止まります。'
                  : '配った先では下書きのまま届きます。誰に出すかは、各アカウントで決めます。'}
            </span>
          </Notice>
        </Card>
        <Card variant="form" gap="normal">
          <SectionHeader title="トークを開いたとき" />
          <div className={styles.segRow}>
            <span className={`${styles.segLabel} ${styles.segLabelPlain}`}>メニューを</span>
            <SaveErrorField names={["defaultOpen"]}><SegmentedControl
              aria-label="トークを開いたときのメニュー"
              options={[
                { value: 'open', label: '開いておく' },
                { value: 'closed', label: '閉じておく' },
              ]}
              value={defaultOpen ? 'open' : 'closed'}
              onChange={(v) => setDefaultOpen(v === 'open')}
            /></SaveErrorField>
          </div>
        </Card>
      </>
    )
  }

type RenderAudienceStepContext = {
  aggregateOnly: boolean
  audience: "all" | "tag" | "none" | "targeted"
  canOperate: boolean
  conditionCount: number
  conditionEmpty: boolean
  conditionUnsaved: boolean
  currentDefaultMenu: RichMenuGroupListItem | undefined
  defaultOpen: boolean
  editGroupId: string | undefined
  host: RichMenuCreateHost | undefined
  orderRows: { id: string; label: string; isSelf: boolean; }[]
  renderHqAudience: () => JSX.Element | null
  setAudience: Dispatch<SetStateAction<"all" | "tag" | "none" | "targeted">>
  setDefaultOpen: Dispatch<SetStateAction<boolean>>
  setPriorityInput: Dispatch<SetStateAction<string>>
  setPriorityOpen: Dispatch<SetStateAction<boolean>>
  setTargetingCondition: Dispatch<SetStateAction<SegmentCondition | null>>
  setTargetingPriority: Dispatch<SetStateAction<number>>
  targetedMenus: RichMenuGroupListItem[]
  targetingCondition: SegmentCondition | null
  targetingPriority: number
}

export function renderAudienceStep({ aggregateOnly, audience, canOperate, conditionCount, conditionEmpty, conditionUnsaved, currentDefaultMenu, defaultOpen, editGroupId, host, orderRows, renderHqAudience, setAudience, setDefaultOpen, setPriorityInput, setPriorityOpen, setTargetingCondition, setTargetingPriority, targetedMenus, targetingCondition, targetingPriority }: RenderAudienceStepContext) {
    if (host) return renderHqAudience()
    const validConditionCount = Number.isInteger(conditionCount) && conditionCount >= 0 ? conditionCount : null
    const validPriority = Number.isInteger(targetingPriority) && targetingPriority >= 0 ? targetingPriority : null
    return (
      <>
        {/* 出す相手 */}
        <Card variant="form" gap="normal">
          <SectionHeader title="出す相手" />
          <SaveErrorField names={["audience"]}><RadioCardGroup legend="出す相手" className={`grid ${host ? 'grid-cols-2' : 'grid-cols-3'} gap-3`}>
            <RadioCard
              name="audience"
              value="all"
              checked={audience === 'all'}
              onChange={() => setAudience('all')}
              title="すべての友だち"
              icon={<Users aria-hidden="true" />}
              note="全員の既定のメニューにする"
            />
            <RadioCard
              name="audience"
              value="targeted"
              checked={audience === 'targeted'}
              onChange={() => {
                setAudience('targeted')
                // 既定は「いちばん下」。0 は先頭の順番を意味するので、
                // すでにある出し分けのあとに置く（編集で前に持っていける）。
                if (targetingPriority === 0 && targetedMenus.length > 0) {
                  setTargetingPriority(targetedMenus.length)
                }
              }}
              title="条件に当てはまる友だちだけ"
              icon={<Tag aria-hidden="true" />}
              note={host ? '条件は配った先のアカウントで決めます' : 'タグ・友だち情報などで絞る'}
            />
            {/* 絵 OxEMM の3つ目。登録だけして、出す相手は一覧の「表示先」・シナリオ・切替タブで決める。 */}
            {host ? null : (
              <RadioCard
                name="audience"
                value="none"
                checked={audience === 'none'}
                onChange={() => setAudience('none')}
                title="決めない"
                icon={<CircleDashed aria-hidden="true" />}
                note="シナリオ・切替タブから出す"
              />
            )}
          </RadioCardGroup></SaveErrorField>

          {audience === 'all' ? (
            <Notice tone="info" icon={<span><Repeat size={16} aria-hidden /></span>}>
              <span>
                公開すると LINE の既定のメニューになります。
                {currentDefaultMenu
                  ? `いまの既定「${currentDefaultMenu.name}」と入れ替わります。`
                  : 'いま既定のメニューはありません。'}
              </span>
            </Notice>
          ) : audience === 'none' ? (
            <p className={styles.cardNote}>このメニューはLINEへの登録だけです。出す相手は一覧の「表示先」で決めてください。</p>
          ) : (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>どんな人に出すか</span>
              <fieldset disabled={aggregateOnly} className="contents">
              <ConditionBuilder
                value={targetingCondition}
                onChange={setTargetingCondition}
                label="このメニューを出す相手"
                showCount={false}
              />
              </fieldset>
              {editGroupId && !conditionEmpty ? (
                <p className={styles.fieldHint}>
                  {validConditionCount === null
                    ? (conditionUnsaved ? '条件数を確認できません（未保存）' : '保存済みの条件数を確認できません')
                    : (conditionUnsaved ? `条件 ${formatNumber(validConditionCount)}件（未保存）` : `保存済み条件 ${formatNumber(validConditionCount)}件`)}
                </p>
              ) : null}
              {conditionEmpty ? (
                <p className={styles.fieldHint}>条件が空のままだと、公開しても誰にも出ません。</p>
              ) : null}
            </div>
          )}
        </Card>

        <Card variant="form" gap="normal">
          <div className={`flex flex-col ${styles.stackCompact}`}>
            <SectionHeader title="出す順番" actions={editGroupId && canOperate ? <Button type="button" variant="text" size="inline" onClick={() => {
              setPriorityInput(validPriority === null ? '' : String(validPriority + 1)); setPriorityOpen(true)
            }}>順番を変更する</Button> : undefined} />
            <p className={styles.cardNote}>ほかの出し分けにも当てはまる人には、順番が早いメニューが出ます</p>
          </div>
          {orderRows.length > 0 ? (
            <ol className={styles.orderList}>
              {orderRows.map((row, i) => (
                <li key={row.id} className={`${styles.orderRow} ${row.isSelf ? styles.orderRowSelf : ''}`}>
                  <span className={styles.orderNum}>{i + 1}</span>
                  <span className={styles.orderName}>{row.label}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.cardNote}>ほかの出し分けメニューはありません。</p>
          )}
          {audience === 'targeted' ? (
            <p className={styles.fieldHint}>新しく作るメニューはいちばん下に置きます。前に出したいときは、あとで編集画面の「出す順番」から変えられます。</p>
          ) : null}
        </Card>

        {/* トークを開いたとき */}
        <Card variant="form" gap="normal">
          <SectionHeader title="トークを開いたとき" />
          <div className={styles.segRow}>
            <span className={`${styles.segLabel} ${styles.segLabelPlain}`}>メニューを</span>
            <SaveErrorField names={["defaultOpen"]}><SegmentedControl
              aria-label="トークを開いたときのメニュー"
              options={[
                { value: 'open', label: '開いておく' },
                { value: 'closed', label: '閉じておく' },
              ]}
              value={defaultOpen ? 'open' : 'closed'}
              onChange={(v) => setDefaultOpen(v === 'open')}
            /></SaveErrorField>
          </div>
        </Card>
      </>
    )
  }
