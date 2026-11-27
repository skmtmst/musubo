'use client'
import { useId, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Lock } from 'lucide-react'
import Dialog from './dialog'
import Checkbox from './checkbox'
import SearchField from './search-field'
import Card from './card'
import Notice from './notice'
import { ReorderHandle, RowMenu, useReorder } from './row-actions'
import styles from './display-items-dialog.module.css'
export type DisplayItem = {key: string; label: string; group: string; note?: string}

/** 一覧と顧客情報の欄が共通で使う。取消では保存せず、順序は選んだ順。 */
export default function DisplayItemsDialog({title = '表示項目を編集', items, selected, maxSelected, manageHref, presentation, hierarchy = false, fixedLabel = '友だち（名前）', minSelected = 0, description, onCancel, onConfirm}: {
  title?: string; items: DisplayItem[]; selected: string[]; maxSelected?: number;
  manageHref?: string; onCancel: () => void; onConfirm: (keys: string[]) => void;
  presentation?: 'columns'; hierarchy?: boolean; fixedLabel?: string; minSelected?: number; description?: string;
}) {
  const limitId = useId()
  const ChosenFrame = presentation === 'columns' ? Card : 'div'
  const [keys, setKeys] = useState(() => selected.filter(key => items.some(item => item.key === key)))
  const [search, setSearch] = useState('')
  const chosen = keys.map(key => items.find(item => item.key === key)!).filter(Boolean)
  const reorder = useReorder({items: chosen, idOf: item => item.key, onReorder: change => setKeys(change.ids)})
  const parents = chosen.filter(item => !item.key.startsWith('fixed:'))
  const children = chosen.filter(item => item.key.startsWith('fixed:'))
  const parentReorder = useReorder({ items: parents, idOf: item => item.key, onReorder: change => setKeys([...change.ids, ...children.map(item => item.key)]) })
  const childReorder = useReorder({ items: children, idOf: item => item.key, onReorder: change => setKeys([...parents.map(item => item.key), ...change.ids]) })
  const shown = hierarchy ? parents.flatMap(item => item.key === 'names' ? [item, ...children] : [item]).concat(parents.some(item => item.key === 'names') ? [] : children) : chosen
  const available = items.filter(item => !keys.includes(item.key) && `${item.label} ${item.group}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const groups = useMemo(() => [...new Set(available.map(item => item.group))], [available])
  const full = maxSelected !== undefined && chosen.length >= maxSelected
  const columns = presentation === 'columns'
  const fieldCount = items.filter(item => item.key.startsWith('field:')).length
  /* お店が作った情報欄は、ほかの欄のあとに見出し（数と「情報欄を管理」）を置いてから並べる。 */
  const FIELD_GROUP = 'お店が作った情報欄'
  const fieldGroups = maxSelected !== undefined ? groups.filter(group => group.startsWith(FIELD_GROUP)) : []
  const otherGroups = groups.filter(group => !fieldGroups.includes(group))
  const renderGroup = (group: string) => <section key={group} className={styles.section}>{group === FIELD_GROUP ? null : <h3 className={styles.subheading}>{group.startsWith(`${FIELD_GROUP} / `) ? group.slice(FIELD_GROUP.length + 3) : group}</h3>}<div className={styles.options} role="group" aria-label={`${group}の追加できる列`}>
    {available.filter(item => item.group === group).map(item => <div key={item.key} className={styles.row}>
      <Checkbox checked={false} disabled={full} aria-describedby={full ? limitId : undefined} onCheckedChange={() => setKeys(current => [...current, item.key])}>{item.label}</Checkbox>
    </div>)}
  </div></section>
  const manageLink = manageHref ? <Link href={manageHref} onClick={onCancel} className={styles.manage}>情報欄を管理<ArrowUpRight size={16} aria-hidden="true" /></Link> : null
  return <Dialog open title={title} size="medium" onCancel={onCancel} onConfirm={() => onConfirm(chosen.map(item => item.key))} confirmLabel="保存する"
    /* 絵 ：列の窓は題の下に1行の説明。説明は本文に重ねない。 */
    description={description ?? (columns && maxSelected !== undefined ? `出す列を選び、並べ替えます。友だちの名前のほかに ${maxSelected} 列まで出せます` : undefined)}
    confirmDisabled={chosen.length < minSelected || (maxSelected !== undefined && chosen.length > maxSelected)} confirmDisabledReason={chosen.length < minSelected ? `少なくとも${minSelected}項目を選んでください。` : full ? '選択数が上限を超えています。別の項目を外してから保存してください。' : undefined}>
    <div className={styles.body} data-presentation={presentation}>
      {columns && maxSelected !== undefined ? null : <p className={styles.note}>{maxSelected === undefined ? '選んだ項目は、つまみで並べ替えられます。' : `友だちの名前はいつも表示します。ほかは${maxSelected}列まで選べます。`}</p>}
      <div className={styles.group}>
        {columns
          ? <div className={styles.headRow}><h3 className={styles.heading}>いま出している列</h3><span>{chosen.length}{maxSelected === undefined ? '' : ` / ${maxSelected}`} 列</span></div>
          : <h3 className={styles.heading}>表示する項目（{chosen.length}{maxSelected === undefined ? '' : ` / ${maxSelected}`}）</h3>}
        <ChosenFrame {...(columns ? { padding: 'rows' as const, surface: 'bordered' as const } : {})} className={styles.chosen} aria-label="選択した列">
          {columns ? <div className={styles.fixedRow} data-fixed-display-name><span><Lock size={16} role="img" aria-label="いつも表示する列" />{fixedLabel}</span><span>いつも出ます</span></div> : null}
          {shown.map(item => { const activeReorder = hierarchy ? (item.key.startsWith('fixed:') ? childReorder : parentReorder) : reorder; return <div key={item.key} data-child={hierarchy && item.key.startsWith('fixed:') || undefined} className={styles.row} {...activeReorder.rowProps(item.key)}>
            <ReorderHandle label={item.label} {...activeReorder.handleProps(item.key)} onMove={direction => activeReorder.moveBy(item.key, direction)} />
            <Checkbox checked onCheckedChange={() => setKeys(current => current.filter(key => key !== item.key))}>{item.label}</Checkbox>
            {item.note ? <span className={styles.note}>{item.note}</span> : null}
            <RowMenu label={`${item.label}の順序`} items={activeReorder.menuItems(item.key)} />
          </div>})}
          {!chosen.length ? <p className={styles.note}>下から表示する項目を選んでください</p> : null}
        </ChosenFrame>
      </div>
      <div className={styles.group}>
        {columns ? <h3 className={styles.heading}>足せる列</h3> : null}
        <SearchField aria-label="表示項目を検索" value={search} onChange={setSearch} placeholder={columns ? '列の名前で探す' : '項目名・分類で探す'} />
        {full ? columns ? <Notice id={limitId} role="status" tone="info">上限に達しました。別の項目を外してから選んでください。</Notice> : <p id={limitId} role="status" className={styles.note}>上限に達しました。別の項目を外してから選んでください。</p> : null}
        <div className={styles.available}>
          {otherGroups.map(renderGroup)}
          {maxSelected !== undefined ? <div className={styles.headRow}><h3 className={styles.subheading}>お店が作った情報欄（{fieldCount}）</h3>{columns ? manageLink : null}</div> : null}
          {fieldGroups.map(renderGroup)}
          {!available.length ? <p className={styles.note}>{search ? '一致する項目がありません' : '追加できる項目はありません'}</p> : null}
          {maxSelected !== undefined && !fieldCount && manageHref ? <p className={styles.note}>まだありません。<Link href={manageHref} onClick={onCancel}>情報欄を作る</Link></p> : null}
        </div>
      </div>
      {manageHref && !columns ? <Link href={manageHref} onClick={onCancel}>情報欄を管理</Link> : null}
    </div>
  </Dialog>
}
