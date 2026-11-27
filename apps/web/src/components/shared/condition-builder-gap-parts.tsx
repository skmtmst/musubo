'use client'

import { useEffect, useRef, useState } from 'react';
import { useAccount } from '@/contexts/account-context';
import { EntityPickerDialog } from './entity-picker';
import { Plus } from 'lucide-react';
import Select from './select';
import { type SegmentRule } from '@/lib/segment-condition';
import Button from '@/components/shared/button';
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select';
import { memberRanksApi } from '@/lib/api/helpers/gap3';


/**
 * 追加できる絞り込みの種類。並びは Lステップの並びに合わせてある。
 * `group` は候補の右端に出すまとまり名（友だちの情報・タグ・行動など）。
 */



type RuleKind = { type: string; label: string; group: string; feature?: 'support_marks' | 'friend_fields'; make: () => SegmentRule }

interface Option {
  id: string
  name: string
  color?: string | null
  groupId?: string | null
  folderId?: string | null
}


/**
 * 条件の足し口（1つ選ぶ）。共通の選ぶ窓（/）を使う。
 *
 * 確定したときだけ追加し、窓を閉じる。取消では条件を変えない。
 */
function KindPicker({
  kinds,
  onPick,
  disabled = false,
  lockedReason,
}: {
  kinds: RuleKind[]
  onPick: (kind: RuleKind) => void
  disabled?: boolean
  lockedReason?: string
}) {
  const [open, setOpen] = useState(false)
  const blocked = disabled || Boolean(lockedReason)
  const blockedRef = useRef(blocked)
  blockedRef.current = blocked
  useEffect(() => { if (blocked) setOpen(false) }, [blocked])
  return <>
    <Button type="button" aria-label="追加する条件を選択する" disabled={disabled} lockedReason={lockedReason} onClick={() => { if (!blockedRef.current) setOpen(true) }}>
      <Plus size={16} aria-hidden="true" />条件を足す
    </Button>
    {open && !blocked ? <EntityPickerDialog title="条件を選ぶ" confirmLabel="条件を足す" searchPlaceholder="条件の名前で探す"
      items={kinds.map(kind => ({ id: kind.type, name: kind.label, meta: kind.group, keywords: kind.group }))}
      onConfirm={id => { if (blockedRef.current) return; const kind = kinds.find(kind => kind.type === id); if (kind) onPick(kind); setOpen(false) }}
      onCancel={() => setOpen(false)} /> : null}
  </>
}


/**
 * タグを選ぶ。
 *
 * 全部を並べるだけだと、タグが増えたときに画面が埋まる。実際の運用アカウントで
 * 101個あり、条件を1つ足すだけで縦20行のタグの壁ができて、その下にある
 * 「送る内容」まで届かなかった。Lステップも入力して絞る形にしている。
 *
 * 選んだものは常に先頭に出す。絞り込んだ状態で選ぶと、消したいときに
 * もう一度同じ言葉を打ち直さないと見つからない。
 */
function TagPicker({
  tags,
  selected, multiple, onChange
}: {
  tags: Option[];
  selected: string[]; multiple: boolean; onChange: (ids: string[]) => void
}) {
  const options = tags.map((tag) =>({...entityOptionMetadata(tag), value: tag.id, label: tag.name }))
  return multiple ?<EntitySelect kind="tag" aria-label="条件のタグ" size ="full" options={options} values={selected} onChange={onChange}/>
    : <EntitySelect kind="tag" aria-label="条件のタグ" size="full" options={[{ value: '', label: 'タグを選ぶ' }, ...options]} value={selected[0] ?? ''} onChange={(id) => onChange(id ? [id] : []
      )}/>
}



/** 会員ランクで絞る行。段の名前は、いまのアカウントのランクの段から読む（動かしていなくても選べる）。 */
function MemberTierRule({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const { selectedAccountId } = useAccount()
  const [tiers, setTiers] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    if (!selectedAccountId) return
    let alive = true
    memberRanksApi.program(selectedAccountId)
      .then((response) => { if (alive && response.success) setTiers(response.data.tiers.map((tier) => ({ id: tier.id, name: tier.name }))) })
      .catch(() => undefined)
    return () => { alive = false }
  }, [selectedAccountId])
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-ink text-sm font-semibold">会員ランク</span>
      <EntitySelect aria-label="会員ランク" value={value} onChange={onChange} options={[{ value: '', label: 'ランクを選ぶ' }, ...tiers.map((tier) => ({ value: tier.id, label: `${tier.name}の人` }))]} />
    </div>
  )
}
export { type RuleKind, type Option, KindPicker, TagPicker, MemberTierRule }
