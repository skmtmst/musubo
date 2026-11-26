'use client'

import { ListToolbarRow, ListToolbarSearchSlot, ListToolbarEnd, ListToolbarSort } from '@/components/shared/list-toolbar'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import TruncatedText from '@/components/shared/truncated-text'
import SearchField from '@/components/shared/search-field'
import Select from '@/components/shared/select'
import EntitySelect from '@/components/shared/entity-select'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { ApiError } from '@/lib/api'
import { nenPetsApi, petAnimalTypeLabel, type NenPetKpis, type NenPetListData, type NenPetRow, type NenPetSort } from '@/lib/nen-pets-api'
import PetEditorV8 from './editor'
import { NEUTERED_LABEL, Pill, RowMenu, feedingLines, monthDay, type PetsQuery } from './parts'
import styles from './pets.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { PAGE_SIZES as STANDARD_PAGE_SIZES } from '@/components/shared/page-size-select'

/*
 * ★V8-B 登録ペットの一覧（・1152 は ）。
 * 案内の帯 → 道具の段（探す・種別・主食・体重更新・並び・件数）→ 表 → 件数 → ヒント。
 * 表は「見出し 36・行 56」。1152 では 年齢・避妊去勢・運動量 を隠し、年齢は種類の後ろへ寄せる。
 * 取得の口・指定は今の画面と同じ（GET /api/nen/pets）。
 */

type ListStatus = 'loading' | 'ready' | 'error' | 'forbidden'
const PAGE_SIZES = STANDARD_PAGE_SIZES

export default function PetsListV8({
  accountId,
  canEdit,
  query,
  onQueryChange,
  onKpis,
  onKpisFailed,
}: {
  accountId: string
  canEdit: boolean
  query: PetsQuery
  onQueryChange: (next: PetsQuery) => void
  /** 数の帯へ渡す。setState をそのまま渡す（毎回作り直さない）。 */
  onKpis: (kpis: NenPetKpis) => void
  /** 数の帯の読み込み失敗を伝える。setState をそのまま渡す。 */
  onKpisFailed?: (failed: boolean) => void
}) {
  const [status, setStatus] = useState<ListStatus>('loading')
  const [data, setData] = useState<NenPetListData | null>(null)
  const [draft, setDraft] = useState(query.q)
  const [page, setPage] = useListUrlValue('page', 1)
  const [pageSize, setPageSize] = useListUrlValue('pageSize', 20)
  const [editing, setEditing] = useState<NenPetRow | null>(null)
  const requestRef = useRef(0)

  const load = useCallback(async () => {
    const request = ++requestRef.current
    setStatus('loading')
    onKpisFailed?.(false)
    try {
      const res = await nenPetsApi.pets(accountId, { ...query, page, pageSize })
      if (request !== requestRef.current) return
      if (!res.success) throw new Error(res.error)
      if (!res.data?.kpis || !Number.isFinite(res.data.kpis.total) || !Array.isArray(res.data.items)) {
        throw new Error('ペット一覧の内容を確認できませんでした。時間をおいて、もう一度お試しください。')
      }
      setData(res.data)
      onKpisFailed?.(false)
      onKpis(res.data.kpis)
      setStatus('ready')
    } catch (caught) {
      if (request !== requestRef.current) return
      onKpisFailed?.(true)
      setStatus(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : 'error')
    }
  }, [accountId, query, page, pageSize, onKpis, onKpisFailed])

  useEffect(() => {
    void load()
  }, [load])

  // 探す欄は打ち終わってから（0.3秒）取り直す。

  const change = (patch: Partial<PetsQuery>) => { onQueryChange({ ...query, ...patch }); setPage(1) }
  const filtering = query.q !== '' || query.species !== '' || query.product !== '' || query.weight !== ''
  const clearFilters = () => { onQueryChange({ ...query, q: '', species: '', product: '', weight: '' }); setDraft(''); setPage(1) }

  return (
    <>


      <ListToolbarRow data-design="ListControls">
        <ListToolbarSearchSlot>
          <SearchField aria-label="ペット名・飼い主で探す" placeholder="ペット名・飼い主で探す" value={draft} onChange={(value: string) => { setDraft(value); onQueryChange({ ...query, q: value.trim() }); setPage(1) }} onClear={() => { setDraft(''); onQueryChange({ ...query, q: '' }); setPage(1) }} />
        </ListToolbarSearchSlot>
        <SaveErrorField names={["species","query.species"]}><Select
          aria-label="種別で絞り込む"
          width={140}
          value={query.species}
          onChange={(value) => change({ species: value })}
          options={[{ value: '', label: '種別：すべて' }, { value: 'dog', label: '種別：犬' }, { value: 'cat', label: '種別：猫' }, { value: 'other', label: '種別：その他' }]}
        /></SaveErrorField>
        <SaveErrorField names={["product","query.product"]}><EntitySelect
          aria-label="主食で絞り込む"
          noun="主食"
          valuePrefix="主食"
          width={140}
          value={query.product}
          onChange={(value) => change({ product: value })}
          options={[
            { value: '', label: '主食：すべて' },
            ...(data?.products ?? []).map((p) => ({ value: p.id, label: `主食：${p.name}` })),
            { value: 'none', label: '主食：未設定' },
          ]}
        /></SaveErrorField>
        <SaveErrorField names={["weight","query.weight"]}><Select
          aria-label="体重の更新で絞り込む"
          width={140}
          value={query.weight}
          onChange={(value) => change({ weight: value === 'stale' || value === 'fresh' ? value : '' })}
          options={[{ value: '', label: '体重更新：すべて' }, { value: 'fresh', label: '体重更新：90日以内' }, { value: 'stale', label: '体重更新：90日以上前' }]}
        /></SaveErrorField>
        <SaveErrorField names={["sort","query.sort"]}><ListToolbarSort
          aria-label="並び順"
          width={170}
          value={query.sort}
          onChange={(value) => change({ sort: value as NenPetSort })}
          options={[
            { value: 'updated_desc', label: '並び：更新が新しい順' },
            { value: 'name', label: '並び：名前順' },
            { value: 'weight_desc', label: '並び：体重が重い順' },
            { value: 'age_desc', label: '並び：年齢が高い順' },
          ]}
        /></SaveErrorField>
        <ListToolbarEnd>
          <SaveErrorField names={["pageSize","page_size"]}><Select aria-label="1ページに出す件数" size="page-size" value={String(pageSize)} onChange={(value) => { setPageSize(Number(value)); setPage(1) }} options={PAGE_SIZES.map((size) => ({ value: String(size), label: `${size}件表示` }))} /></SaveErrorField>
        </ListToolbarEnd>
      </ListToolbarRow>

      {status === 'loading' && !data ? (
        <ListState kind="loading" title="ペットを読み込んでいます" />
      ) : status === 'forbidden' ? (
        <ListState kind="forbidden" onRetry={() => void load()} />
      ) : status === 'error' ? (
        <ListState kind="error" title="ペットを読み込めませんでした" description="通信の状態を確認して、もう一度お試しください。" onRetry={() => void load()} />
      ) : data && data.items.length === 0 ? (
        filtering ? (
          <ListState kind="empty" title="条件に合うペットはいません" description="検索や絞り込みを外すと、すべて出ます。" action={<Button onClick={clearFilters}>条件を外す</Button>} />
        ) : (
          <ListState kind="empty" emptyPreset="readonly" title="まだペットがいません" description="お客さまがマイページでペットを登録すると、ここに並びます。" />
        )
      ) : data ? (
        <>
          <DataTable className={styles.table}>
            <thead>
              <TableHeadRow className={styles.headRow} data-table-layout="columns">
                <Th className={styles.colPet}>ペット</Th>
                <Th className={styles.colOwner}>飼い主</Th>
                <Th className={styles.colAge}>年齢</Th>
                <Th className={styles.colWeight}>体重</Th>
                <Th className={styles.colFeed}>今日の目安</Th>
                <Th className={styles.colNeutered}>避妊去勢</Th>
                <Th className={styles.colActivity}>運動量</Th>
                <Th className={styles.colProduct}>主食</Th>
                <Th className={styles.colUpdated}>体重の更新</Th>
                <Th className={styles.colMenu}><span className="sr-only">操作</span></Th>
              </TableHeadRow>
            </thead>
            <tbody>
              {data.items.map((pet) => (
                <PetRow key={pet.id} pet={pet} canEdit={canEdit} onEdit={() => setEditing(pet)} />
              ))}
            </tbody>
          </DataTable>
          <div className={styles.pagerRow}>
            <Pagination page={data.page} pageCount={Math.max(1, Math.ceil(data.total / data.pageSize))} onPageChange={setPage} range={{ total: data.total, first: (data.page - 1) * data.pageSize + 1, last: Math.min(data.total, data.page * data.pageSize) }} />
          </div>
          <p className={styles.hint}>{canEdit ? '行の「…」から ペットの情報を直す・飼い主を開く・マイページで更新を促す。' : '行の「…」から 飼い主を開く・マイページで更新を促す。'}</p>
        </>
      ) : null}

      {editing ? (
        <PetEditorV8 accountId={accountId} pet={editing} onClose={() => setEditing(null)} onSaved={() => void load()} />
      ) : null}
    </>
  )
}

function PetRow({ pet, canEdit, onEdit }: { pet: NenPetRow; canEdit: boolean; onEdit: () => void }) {
  const router = useRouter()
  const kind = petAnimalTypeLabel(pet.animalType)
  const name = pet.name || pet.callName || '（名前なし）'
  const kindLine = pet.breed ? `${kind}・${pet.breed}` : kind
  const feed = feedingLines(pet)
  const friendHref = `/friends/detail?id=${encodeURIComponent(pet.owner.friendId)}`
  const items: ActionMenuItem[] = [
    ...(canEdit ? [{ id: 'edit', label: 'ペットの情報を直す', onSelect: onEdit }] : []),
    { id: 'owner', label: '飼い主を開く', external: false, href: friendHref, onSelect: () => { router.push(friendHref) } },
    /* マイページの更新を頼む送信の口は無いので、受信箱でこの飼い主とのトークを開いて頼む。 */
    { id: 'nudge', label: 'マイページで更新を促す', external: false, href: `/chats?friend=${encodeURIComponent(pet.owner.friendId)}`, onSelect: () => { router.push(`/chats?friend=${encodeURIComponent(pet.owner.friendId)}`) } },
  ]
  const updated = pet.weightKg == null ? emptyValue('unknown') : monthDay(pet.weightUpdatedAt)
  return (
    <Tr className={styles.row} data-table-layout="columns">
      <Td className={styles.colPet}>
        <span className={styles.petCell}>
          {pet.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- お客様がマイページで登録した写真
            <img width={28} height={28} src={pet.imageUrl} alt="" className={styles.face} />
          ) : (
            <span aria-hidden="true" className={styles.face}>{name.slice(0, 1)}</span>
          )}
          <span className={styles.stack}>
            <span className={styles.nameText} title={pet.callName || name}>{name}</span>
            <span className={styles.sub} title={kindLine}>
              <span className={styles.wideOnly}>{kindLine}</span>
              <span className={styles.narrowOnly}><TruncatedText value={pet.ageLabel === '—' ? kindLine : `${kindLine}・${pet.ageLabel}`} /></span>
            </span>
          </span>
        </span>
      </Td>
      <Td className={styles.colOwner}>
        <span className={styles.stack}>
          <span className={styles.cellStrong} title={pet.owner.name}>{pet.owner.name || '（名前なし）'}</span>
          <span className={styles.sub}>{pet.owner.customerId ? `EC会員 ${pet.owner.customerId}` : 'EC未連携'}</span>
        </span>
      </Td>
      <Td className={styles.colAge}><span className={styles.cell} title={pet.ageLabel}>{pet.ageLabel}</span></Td>
      <Td className={styles.colWeight}><span className={styles.num}>{pet.weightKg == null ? emptyValue('unknown') : `${pet.weightKg}kg`}</span></Td>
      <Td className={styles.colFeed}>
        <span className={styles.stack}>
          <span className={feed.main === '—' ? styles.cell : styles.cellStrong}>{feed.main}</span>
          <span className={styles.sub}><TruncatedText value={feed.sub} /></span>
        </span>
      </Td>
      <Td className={styles.colNeutered}><span className={styles.cell} title={NEUTERED_LABEL[pet.neutered]}>{NEUTERED_LABEL[pet.neutered]}</span></Td>
      <Td className={styles.colActivity}><span className={styles.cell} title={pet.activityLabel}>{pet.activityLabel}</span></Td>
      <Td className={styles.colProduct}><span className={styles.cell} title={pet.productName ?? '（未設定）'}>{pet.productName ?? '（未設定）'}</span></Td>
      <Td className={styles.colUpdated}>
        {pet.weightStale && updated !== '—' ? (
          <span className={styles.stack}>
            <span className={styles.cell}>{updated}</span>
            <Pill tone="warn" title="体重が90日更新されていません">90日以上前</Pill>
          </span>
        ) : <span className={styles.cell}>{updated}</span>}
      </Td>
      <Td className={styles.colMenu}><RowMenu subject={name} items={items} /></Td>
    </Tr>
  )
}
