'use client'

import { PageHeading } from '@/components/templates/page-frame'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type Recipe } from '@/lib/api'
import { useResponseGate } from '@/lib/use-response-gate'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import ListState from '@/components/shared/list-state'
import { isForbiddenOrRateLimited, loadFailureCopy } from '@/components/shared/api-error-message'
import TargetMissing from '@/components/shared/target-missing'

import StatusBadge from '@/components/shared/status-badge'
import StickyBar from '@/components/shared/sticky-bar'
import { TextField } from '@/components/shared/text-field'
import { Field, RequiredBadge } from '@/components/shared/form-controls'
import { CareCard } from '@/components/shared/side-cards'
import {
  CARE_ITEMS,
  ITEMS_UNDECIDED_NOTE,
  apiRecipeFeatureSummary,
  apiRecipeRequirements,
  apiRecipeRest,
  createButtonLabel,
  prefixedName,
} from '../recipe-catalog'
import styles from './clone.module.css'
import { formatNumber } from '@/lib/format'

/** 設計 ★管理画面 34-3「レシピを複製する」（`D5UaX`）。 */
function RecipeClone() {
  /*
    **`[recipeId]` は使えない。** 静的書き出し（`output: 'export'`）なので
    ビルド時に全IDが分からない動的セグメントは書き出せない
    （`route-integrity.test.ts`）。ほかの画面と同じく `?id=` で表す。
    要件 §5-3 の `/recipes/{recipeId}/clone` はこの形に読み替える。
  */
  const search = useSearchParams()
  const id = search?.get('id') ?? ''

  const { selectedAccountId, selectedAccount, loading: accountLoading } = useAccount()
  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  /** 404・空で見つからないとき。取得の失敗（error）とは分ける。 */
  const [missing, setMissing] = useState(false)
  /*
   * M044: 捕まえた取得失敗は共通部品へ渡す。403 は権限の案内になり、
   * 押しても直らない再試行は出ない。429 は待ち秒数を添えた案内になる。
   */
  const [loadError, setLoadError] = useState<unknown>(null)
  const [prefix, setPrefix] = useState('')
  const [cloneState, setCloneState] = useState<'idle' | 'saving' | 'success' | 'error'>('idle')
  /** 同じ作成意図の再送で使い回すキー（監査 R126）。 */
  const cloneKeyRef = useRef<{ intent: string; key: string } | null>(null)

  usePageTitle(recipe ? `${recipe.name}を作る` : null)
  /* パンくずは上の帯だけ（板の中の2つ目のパンくずは置かない）。 */
  usePageCrumbs([{ label: 'レシピ', href: '/recipes' }])

  /*
   * WEB321：レシピ・アカウントを変えたら、前の遅い応答（読み込み・作成の結果）を
   * 今の画面へ書かない。作成の再送キーと版（R126）はそのまま使う。
   */
  const gate = useResponseGate()
  const targetRef = useRef('')
  targetRef.current = `${id}|${selectedAccountId ?? ''}`
  useEffect(() => { setCloneState('idle') }, [id, selectedAccountId])

  const reload = useCallback(async (): Promise<'ok' | 'missing' | 'error' | 'stale'> => {
    const token = gate.begin()
    try {
      const res = await api.recipes.get(id, selectedAccountId ?? undefined)
      if (!gate.current(token)) return 'stale'
      if (!res.success || !res.data) {
        setLoadError(null)
        return 'error'
      }
      setRecipe(res.data)
      setLoadError(null)
      return 'ok'
    } catch (caught: unknown) {
      if (!gate.current(token)) return 'stale'
      if (caught instanceof ApiError && caught.status === 404) return 'missing'
      setLoadError(caught)
      return 'error'
    }
  }, [id, selectedAccountId, gate])

  const refresh = useCallback(() => {
    setStatus('loading')
    setMissing(false)
    setLoadError(null)
    void reload().then((outcome) => {
      if (outcome === 'stale') return
      if (outcome === 'missing') {
        setMissing(true)
        setStatus('ready')
        return
      }
      setStatus(outcome === 'ok' ? 'ready' : 'error')
    })
  }, [reload])

  useEffect(() => {
    if (accountLoading || !id) return
    refresh()
  }, [accountLoading, id, refresh])

  /*
    id なしで開くと取得が始まらず、後段で空のまま数えて落ちていた。
    対象未指定は失敗ではないので、一覧へ戻して選び直させる。
  */
  if (!id) {
    return (
      <TargetMissing
        kind="unspecified"
        title="作るレシピが指定されていません"
        description="一覧から、作りたいレシピを選び直してください。"
        backHref="/recipes"
        backLabel="レシピ一覧へ戻る"
      />
    )
  }

  if (missing || (status === 'ready' && !recipe)) {
    return (
      <TargetMissing
        kind="not-found"
        title="このレシピは見つかりません"
        description="削除されたか、別の記録です。一覧から選び直してください。"
        backHref="/recipes"
        backLabel="レシピ一覧へ戻る"
      />
    )
  }

  /*
   * M044: 403・429だけ共通文へ切り替える（権限・混雑の案内。再試行の
   * 有無は `loadFailureCopy` が決める）。それ以外は画面の文のまま。
   */
  const cloneFailure = loadError ? loadFailureCopy(loadError, 'レシピ') : null
  const useCommonCopy = loadError ? isForbiddenOrRateLimited(loadError) : false
  if (status === 'error') {
    return (
      <TargetMissing
        kind="error"
        title={useCommonCopy && cloneFailure ? cloneFailure.title : 'レシピを読み込めませんでした'}
        description={useCommonCopy && cloneFailure ? cloneFailure.description : '通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。'}
        error={loadError ?? undefined}
        onRetry={() => refresh()}
      />
    )
  }

  if (status !== 'ready' || !recipe) return <ListState kind="loading" />

  const requirements = apiRecipeRequirements(recipe)
  const rest = apiRecipeRest(recipe)
  const canClone = Boolean(selectedAccountId) && recipe.missingFeatures.length === 0 && recipe.items !== null

  const clone = async () => {
    if (!selectedAccountId || !canClone || cloneState === 'saving') return
    setCloneState('saving')
    /*
      監査 R126: 同じ作成のやり直しには同じ再送キーを使う。
      応答だけが切れたあと新しいキーで送ると別の依頼になり、先に作った
      下書きと名前がぶつかって失敗する。宛先・名前のあたま・レシピが
      変わったら別の依頼なので、その時だけ新しいキーにする。
    */
    const intent = `${recipe.id}:${selectedAccountId}:${prefix}`
    if (cloneKeyRef.current?.intent !== intent) {
      cloneKeyRef.current = { intent, key: crypto.randomUUID() }
    }
    const target = targetRef.current
    try {
      const result = await api.recipes.clone(
        recipe.id,
        { accountId: selectedAccountId, namePrefix: prefix || null, expectedVersion: recipe.version },
        cloneKeyRef.current.key,
      )
      if (targetRef.current !== target) return
      setCloneState(result.success ? 'success' : 'error')
    } catch {
      if (targetRef.current !== target) return
      setCloneState('error')
    }
  }

  return (
    <div className={styles.page}>
      <div><PageHeading title="レシピを複製する" /></div>

      <>
          <div className={styles.columns}>
            <div className={styles.main}>
              <section className={styles.block}>
                <h2 className={styles.blockTitle}>名前の付け方</h2>
                <Field label="名前のあたまに付ける文字（任意）" htmlFor="recipe-clone-prefix">
                  <TextField
                    id="recipe-clone-prefix"
                    placeholder="例：2026春"
                    value={prefix}
                    onChange={(e) => setPrefix(e.target.value)}
                  />
                </Field>
                <p className={styles.hint}>
                  付けると「{prefixedName(prefix, recipe.name)}
                  」のようになります。同じレシピを何度も使うとき、どれがどれか分かりやすくなります。
                </p>
                <label className={styles.accountLabel} htmlFor="recipe-clone-account">
                  どのLINEアカウントに作るか<RequiredBadge />
                </label>
                <p id="recipe-clone-account" className="text-body">{selectedAccount?.name ?? 'アカウントが選ばれていません'}</p>
                <p className={styles.hint}>
                  作る先はいま選んでいるアカウントです。変えるときは上のLINEアカウントから選び直します。
                </p>
              </section>

              <section className={styles.block}>
                <h2 className={styles.blockTitle}>
                  作られるもの{recipe.itemCount != null ? ` ${formatNumber(recipe.itemCount)}件` : ''}
                </h2>
                <p className={styles.hint}>
                  すべて下書きで作られます。動きはじめるのは、ひとつずつ公開してからです。
                </p>
                {recipe.items ? (
                  <ul className={styles.items}>
                    {recipe.items.map((item) => (
                      <li key={`${item.kind}-${item.name}`} className={styles.item}>
                        <span className={styles.itemKind}>{item.kind}</span>
                        <span className={styles.itemName}>{prefixedName(prefix, item.name)}</span>
                        <span className={styles.itemNote}>{item.note}</span>
                        <StatusBadge tone="neutral" size="compact">
                          下書き
                        </StatusBadge>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.undecided}>{ITEMS_UNDECIDED_NOTE}</p>
                )}
                {rest ? <p className={styles.hint}>{rest}</p> : null}
              </section>
            </div>

            <aside className={styles.side} aria-label="この画面の案内">
              <section className={styles.sideCard}>
                <h2 className={styles.sideTitle}>必要な機能</h2>
                <ul className={styles.features}>
                  {requirements.map((requirement) => {
                    return (
                      <li key={requirement.key ?? 'friend-attributes'} className={styles.feature}>
                        <StatusBadge tone={requirement.on ? 'success' : 'warning'} size="compact">
                          {requirement.on ? 'オン' : 'オフ'}
                        </StatusBadge>
                        <span>{requirement.label}</span>
                      </li>
                    )
                  })}
                </ul>
                <p className={styles.hint}>{apiRecipeFeatureSummary(recipe)}</p>
              </section>

              <section className={styles.sideCard}>
                <h2 className={styles.sideTitle}>作ったあと</h2>
                <ul className={styles.notes}>
                  <li>できたものはすべて下書きです。放っておいても、友だちには何も届きません。</li>
                  <li>
                    公開するときは、シナリオ・ルールをひとつずつ開いて確かめてから公開します。
                  </li>
                  <li>できたものはレシピとつながりません。名前も中身も自由に直せます。</li>
                  <li>どのレシピから作ったかは記録に残ります。あとから見返せます。</li>
                </ul>
              </section>
              <CareCard items={[...CARE_ITEMS]} />
            </aside>
          </div>

          <StickyBar
            status={cloneState === 'success'
              ? '下書きを作りました。レシピ一覧から作成回数を確認できます。'
              : cloneState === 'error'
                ? '作れませんでした。入力と必要な機能を確認して、もう一度お試しください。'
                : undefined}
            actions={
              <>
                <Link href="/recipes" className={styles.cancel}>
                  やめる
                </Link>
                <button
                  type="button"
                  className={canClone ? styles.primary : styles.blocked}
                  disabled={!canClone || cloneState === 'saving'}
                  onClick={() => void clone()}
                >
                  {cloneState === 'saving' ? '作っています…' : createButtonLabel(recipe)}
                </button>
              </>
            }
          />
        </>
    </div>
  )
}

export default function RecipeClonePage() {
  return (
    <Suspense fallback={<ListState kind="loading" />}>
      <RecipeClone />
    </Suspense>
  )
}
