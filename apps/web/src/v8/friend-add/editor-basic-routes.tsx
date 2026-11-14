'use client'

import { parseFriendConditionJson } from './editor-model';

import Button from '@/components/shared/button';
import PermissionGatedButton from '@/components/shared/permission-gated-button';
import Card,{ CardHeader } from '@/components/shared/card';
import CheckCard from '@/components/shared/check-card';
import ConditionBuilder from '@/components/shared/condition-builder';
import DateTimeField from '@/components/shared/date-time-field';
import Dialog from '@/components/shared/dialog';
import { EntityPickerSummary } from '@/components/shared/entity-picker';
import FolderSelect,{ folderByName,type FolderSelectCreate } from '@/components/shared/folder-select';
import { Field,OptionalBadge } from '@/components/shared/form-controls';
import ListToolbar from '@/components/shared/list-toolbar';
import Notice from '@/components/shared/notice';
import RadioCard,{ RadioCardGroup } from '@/components/shared/radio-card';
import { SaveErrorField } from '@/components/shared/save-form-errors';
import SearchField from '@/components/shared/search-field';
import { SettingsFormRow } from '@/components/shared/settings-form-card';
import { TextArea,TextField } from '@/components/shared/text-field';
import TruncatedText from '@/components/shared/truncated-text';
import { type FriendAddRuleDefinition,type FriendAddRuleOptions } from '@/lib/api';
import { pruneCondition } from '@/lib/segment-condition';
import { useNarrowViewport } from '@/lib/use-narrow-viewport';
import { CircleAlert,Plus,Route,UserPlus,UserRound } from 'lucide-react';
import type { Dispatch,SetStateAction } from 'react';
import { useEffect,useMemo,useState } from 'react';
import { EditorRule,RouteUse,b244Requirements } from './editor-model';
import styles from './editor.module.css';
import { conditionSummary,localInputValue } from './text';

import { ReadOnlyText } from './editor-message';
/** 名前の共通の頭（「秋フェア チラシ」「秋フェア 店頭ポスター」→「秋フェア」）。 */
export function sharedPrefix(names: string[]) {
  const words = names.map((name) => name.split(/[\s　]/)[0])
  return words.every((word) => word === words[0]) && words[0] !== names[0] ? words[0] : ''
}

/* ===== 作る① 基本設定（板 ） ===== */
export function BasicStep({ rule, setRule, definition, setDefinition, options, canEdit, isExisting, nameError, onCreateFolder }: {
  rule: EditorRule
  setRule: Dispatch<SetStateAction<EditorRule>>
  definition: FriendAddRuleDefinition
  setDefinition: Dispatch<SetStateAction<FriendAddRuleDefinition>>
  options: FriendAddRuleOptions
  canEdit: boolean
  isExisting: boolean
  nameError?: string
  /** フォルダを選ぶ欄からその場で作る（dLffh）。閲覧のみは渡さない。 */
  onCreateFolder?: FolderSelectCreate
}) {
  const [memoOpen, setMemoOpen] = useState(false)
  const locked = rule.isFallback || isExisting
  const folderOptions = options.folders.some((folder) => folder.name === (rule.folderName ?? ''))
    ? options.folders
    : rule.folderName ? [...options.folders, { id: rule.folderName, name: rule.folderName }] : options.folders
  const lockReason = locked ? '保存したあとの設定では変えられません。変更するには一覧から新しく作ってください。' : undefined
  return (
    <>
      <Card variant="form" gap="normal" className={styles.card} aria-label="名前とフォルダ">
        <CardHeader size="stacked" title={<>名前とフォルダ</>} meta={<>一覧に出る名前です。友だちには見えません。</>} />
        <SettingsFormRow layout="name-folder">
          <div className={styles.field}><Field requirement={b244Requirements.rule_name} label="設定名（60文字まで）" htmlFor="fa-name"><SaveErrorField names={["name","rule.name","mine"]}><TextField
              id="fa-name"
              value={rule.name}
              maxLength={60}
              readOnly={!canEdit}
              invalid={Boolean(nameError)}
              aria-describedby={nameError ? 'fa-name-error' : undefined}
              placeholder="例：秋フェアの初回案内"
              onChange={(event) => setRule((current) => ({ ...current, name: event.target.value }))}
            /></SaveErrorField>
{nameError ? <span id="fa-name-error" className={styles.fieldError} role="alert">{nameError}</span> : null}</Field></div>
          <div className={styles.field}><Field label="フォルダ" htmlFor="fa-folder">{canEdit ? (
              <SaveErrorField names={["folderName","rule.folderName","folder_name","mine","id","name","rule.folder_name"]}><FolderSelect
                id="fa-folder"
                aria-label="フォルダ"
                size="full"
                value={rule.folderName ?? ''}
                onChange={(value) => setRule((current) => ({ ...current, folderName: value || null }))}
                folders={folderOptions.map(folderByName)}
                onCreate={onCreateFolder}

              /></SaveErrorField>
            ) : (
              <ReadOnlyText id="fa-folder" label="フォルダ" value={rule.folderName || '未分類'} />
            )}</Field></div>
        </SettingsFormRow>
        {<PermissionGatedButton allowed={canEdit} type="button" variant="text" onClick={() => setMemoOpen(true)}>社内メモ</PermissionGatedButton>}
      </Card>
      <Dialog open={memoOpen && canEdit} title="社内メモ" dirty={false} onCancel={() => setMemoOpen(false)} >
        <Field label="社内メモ" htmlFor="fa-internal-memo" note="配信の条件には使いません">
          <SaveErrorField names={["internalMemo", "definition.internalMemo"]}><TextArea id="fa-internal-memo" aria-label="社内メモ" value={definition.internalMemo ?? ''} onChange={(event) => setDefinition((current) => ({ ...current, internalMemo: event.target.value }))} /></SaveErrorField>
        </Field>
      </Dialog>
      <Card variant="form" gap="normal" className={styles.card} aria-label="だれに送るか">
        <CardHeader size="stacked" title={<>だれに送るか</>} meta={<>保存したあとは変えられません</>} />
        {!canEdit ? (
          <ReadOnlyText label="だれに送るか" value={rule.friendKind === 'returning' ? '以前からの友だち・ブロック解除した人' : 'はじめて友だち追加した人'} />
        ) : (
        <SaveErrorField names={["fa-kind","friendKind","rule.friendKind","rule"]}><RadioCardGroup legend="だれに送るか" className={styles.kindPair}>
          <RadioCard
            name="fa-kind"
            value="first_time"
            checked={rule.friendKind === 'first_time'}
            disabled={locked}
            disabledReason={lockReason}
            onChange={() => setRule((current) => ({ ...current, friendKind: 'first_time' }))}
            icon={<UserPlus size={16} />}
            title="はじめて友だち追加した人"
            note="初めての人にだけ「はじめまして」"
            className={styles.kindCard}
          />
          <RadioCard
            name="fa-kind"
            value="returning"
            checked={rule.friendKind === 'returning'}
            disabled={locked}
            disabledReason={lockReason}
            onChange={() => setRule((current) => ({ ...current, friendKind: 'returning' }))}
            icon={<UserRound size={16} />}
            title="以前からの友だち・ブロック解除した人"
            note="戻ってきた人には別の案内"
            className={styles.kindCard}
          />
        </RadioCardGroup></SaveErrorField>
        )}
        <Notice tone="info" icon={<CircleAlert size={16} aria-hidden="true" />} message="この2つを分けないと、以前からのお客さまに「はじめまして」が届きます。" />
      </Card>
    </>
  )
}

/* ===== 作る② 流入リンク（板 ・1152 ） ===== */
export function RoutesStep({ rule, definition, setDefinition, options, routeUses, toggleRoute, canEdit, routeError }: {
  rule: EditorRule
  definition: FriendAddRuleDefinition
  setDefinition: Dispatch<SetStateAction<FriendAddRuleDefinition>>
  options: FriendAddRuleOptions
  routeUses: Map<string, RouteUse>
  toggleRoute: (id: string) => void
  canEdit: boolean
  routeError?: string
}) {
  const [query, setQuery] = useState('')
  const [conditionOpen, setConditionOpen] = useState(false)
  const [conditionsDialogOpen, setConditionsDialogOpen] = useState(false)
  const narrow = useNarrowViewport()
  // 選択不足のときは検索で隠れた候補を戻し、最初の選択欄へ移れるようにする。
  useEffect(() => { if (routeError) setQuery('') }, [routeError])
  const keyword = query.trim()
  /* 選んだリンクを上に。並びは選んだ順ではなく、口の並びのまま。 */
  const visibleRoutes = useMemo(() => {
    const filtered = keyword ? options.routes.filter((route) => route.name.includes(keyword)) : options.routes
    const chosen = filtered.filter((route) => definition.routeIds.includes(route.id))
    return [...chosen, ...filtered.filter((route) => !definition.routeIds.includes(route.id))]
  }, [definition.routeIds, keyword, options.routes])
  const selectedCount = definition.routeIds.length
  const raw = definition.friendCondition ?? ''
  const parsed = parseFriendConditionJson(raw)
  const legacy = raw.trim() !== '' && parsed === null
  const conditionLine = conditionSummary(parsed, options.tags)
  const conditionName = parsed && parsed.rules.length + (parsed.groups?.length ?? 0) > 0 ? conditionLine.replace(/^友だち条件：/, '') : ''
  const conditions = (<>
      <p className={styles.subDesc}>空のままなら、選んだリンクから来た全員に送ります。</p>
      <div className={styles.datePair}>
        <div className={styles.field}><Field label="有効期間 はじめ" htmlFor="fa-from"><SaveErrorField names={["activeFrom","definition.activeFrom","active_from","definition.active_from"]}><DateTimeField
            id="fa-from"
            value={localInputValue(definition.activeFrom)}
            readOnly={!canEdit}
            onChange={(next) => setDefinition((current) => ({ ...current, activeFrom: next || null }))}
          /></SaveErrorField></Field></div>
        <div className={styles.field}><Field label="有効期間 おわり" htmlFor="fa-until"><SaveErrorField names={["activeUntil","definition.activeUntil","active_until","definition.active_until"]}><DateTimeField
            id="fa-until"
            value={localInputValue(definition.activeUntil)}
            readOnly={!canEdit}
            onChange={(next) => setDefinition((current) => ({ ...current, activeUntil: next || null }))}
          /></SaveErrorField></Field></div>
      </div>
      {legacy ? (
        <Notice tone="warn" role="alert">以前の形式の条件が入っているため、今は配信を止めています。下の条件を作り直してください。</Notice>
      ) : null}
      <div className={styles.conditionRow}>
        {<PermissionGatedButton allowed={canEdit} type="button" onClick={() => setConditionOpen(true)}>条件を足す</PermissionGatedButton>}
        {/* 選んだ後の欄（B-175）：欄全体を押すと条件の組み立てを開閉する。右に「変える ›」。 */}
        {canEdit ? (
          <div className={styles.conditionField}>
            <EntityPickerSummary
              label="友だち条件"
              noun="友だち条件"
              name={conditionName}
              placeholder={conditionLine}
              compact
              onOpen={() => setConditionOpen((open) => !open)}
            />
          </div>
        ) : (
          // 閲覧のみ：条件を開いて変える部品は置かず、条件の中身を文字で見せる。
          <span className={styles.conditionReadOnly}>{conditionLine}</span>
        )}
      </div>
      {canEdit && conditionOpen ? (
        <ConditionBuilder
          value={parsed}
          onChange={(next) => {
            const pruned = pruneCondition(next)
            setDefinition((current) => ({ ...current, friendCondition: pruned ? JSON.stringify(pruned) : '' }))
          }}
          label="この初回案内を使う友だち"
          showCount={false}
        />
      ) : null}
  </>)
  return (
    <>
      <Card variant="form" gap="normal" className={styles.card} aria-label="どの流入リンクから来た人に送るか" data-friend-add-routes>
        <CardHeader size="stacked" title={<>どの流入リンクから来た人に送るか</>} meta={<>選んだリンクの URL・QR（どちらも同じ入口）から追加された人に動きます</>} />
        <ListToolbar searchSlot={<SearchField
          value={query}
          placeholder="流入リンクの名前で探す"
          aria-label="流入リンクの名前で探す"
          onChange={setQuery}
          onClear={() => setQuery('')}
        />} />
        {/* 閲覧のみ：選ぶチェックは置かず、選んでいるリンクの名前だけを並べる。 */}
        {(canEdit ? visibleRoutes : visibleRoutes.filter((route) => definition.routeIds.includes(route.id))).map((route) => {
          const checked = definition.routeIds.includes(route.id)
          const use = routeUses.get(route.id)
          if (!canEdit) {
            return (
              <p key={route.id} className={styles.readOnlyRoute}>
                <span className={styles.readOnlyRouteName} ><TruncatedText value={String(route.name ?? '')} /></span>
                <span className={styles.routeSub}>{route.kind ? `QR・URL｜${route.kind}` : 'QR・URL'}</span>
              </p>
            )
          }
          return (
            <CheckCard
              key={route.id}
              className={styles.routeCard}
              checked={checked}
              invalid={Boolean(routeError)}
              describedBy={routeError ? 'fa-routes-error' : undefined}
              onChange={() => toggleRoute(route.id)}
              title={route.name}
              note={use && !checked ? (
                <span className={styles.routeWarn}>{`いま「${use.name}」（順番${use.priority}）が動いています`}</span>
              ) : (
                <span className={styles.routeSub}>{route.kind ? `QR・URL｜${route.kind}` : 'QR・URL'}</span>
              )}
            />
          )
        })}
        {visibleRoutes.length === 0 ? (
          <p className={styles.cardDesc}>条件に合う流入リンクはありません。名前を変えて探してください。</p>
        ) : null}
        <div className={styles.routeFoot}>
          {canEdit ? (
            <Button href="/inflow-links" variant="text">
              <Plus size={16} aria-hidden="true" />流入リンクを新しく発行する
            </Button>
          ) : null}
          {narrow ? <Button type="button" variant="text" onClick={() => setConditionsDialogOpen(true)}>対象をしぼる <OptionalBadge /></Button> : null}
          <span className={styles.spacer} aria-hidden="true" />
          <span className={styles.countNote}>{selectedCount > 0 ? `${selectedCount}つ選んでいます` : '選んでいません'}</span>
        </div>
        {routeError ? <p id="fa-routes-error" className={styles.fieldError} role="alert">{routeError}</p> : null}
        {!narrow ? (
          <div className={styles.narrowBox} aria-label="対象をしぼる" role="group">
            <CardHeader headingLevel={3} size="stacked" title="対象をしぼる" optional />
            {conditions}
          </div>
        ) : null}
      </Card>
      <Dialog open={narrow && conditionsDialogOpen} title="対象をしぼる" titleHelp={<OptionalBadge />} onCancel={() => setConditionsDialogOpen(false)}>
        {conditions}
      </Dialog>
      <Notice
        tone="info"
        icon={<Route size={16} aria-hidden="true" />}
        message={rule.isFallback
          ? 'この設定は、流入経路を確定できなかった人へ最後に動きます。'
          : '基本の追加URL・素のQR・検索から来た人は、どの設定でも選べません。いちばん最後の「経路が分からなかった人」が動きます。'}
      />
    </>
  )
}
