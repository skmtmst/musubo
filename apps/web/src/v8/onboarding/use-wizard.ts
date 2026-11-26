'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'
import { notifySaved } from '@/components/shared/toast'
import { accountStyleUpdated } from '@/hooks/use-account-style'
import { styleApi } from '@/lib/api/helpers/styles'
import type { AccountStyle,SetupAnswer } from '@line-crm/shared'
import { useEffect,useMemo,useState } from 'react'
import { LOOK_CHOICES, SETTINGS_KEYS, answerOf, answersForApi, changedAnswers, isBookingConfirmSample, needsActivation, pairStarterItems, questionsFor, recommendedValue, selectedValue, settingsChanges, stepNames } from './model'
import { type Question } from './question-types'
import type { Props, SummaryData, WizardStep } from './wizard-types'
export function useWizard({ accountId, state, initialStep = 0, styleOnly = false, onClose }: Props) {
  const [style, setStyle] = useState<AccountStyle>(state.style)
  const [styleChosen, setStyleChosen] = useState(state.styleSelected)
  const [answers, setAnswers] = useState<Record<string, SetupAnswer>>(state.answers ?? {})
  const [choices, setChoices] = useState<Record<string, { mode: 'sample' | 'existing' | 'configured'; resourceId?: string }>>({})
  const [menuConfirmed,setMenuConfirmed]=useState(false)
  const [version, setVersion] = useState(state.version)
  const [step, setStep] = useState<WizardStep>(initialStep)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()
  const [summary, setSummary] = useState<SummaryData | null>(null)
  const [enabled, setEnabled] = useState<Record<string, boolean>>({})
  const [resources, setResources] = useState<Array<{ id: string; name: string; kind: string }> | null>(null)
  const [resource, setResource] = useState(state.answers?.image?.value==='existing'?state.answers.image.resourceId??'':'')
  const preparing = usePreparingDialog()

  const steps = useMemo(() => stepNames(style), [style])
  const questions = useMemo(() => questionsFor(style), [style])
  const total = steps.length
  const index = step === 'summary' ? total : step
  const question: Question | null = typeof step === 'number' && step >= 2 ? questions[step - 2] ?? null : null

  /* 今の手順で選んでいる値（まだ答えていなければおすすめ）。 */
  const current = (() => {
    /* 1 問目は本人が選ぶまで空（保存済みのスタイルがあればそれ）。見ているだけのスタイルは入れない。 */
    if (step === 0) return styleChosen ? style : ''
    /* 「あとで」「手動」にした質問を開き直したときは、答えに来たのでおすすめを選んでおく。 */
    const picked = (key: string) => (answers[key]?.mode === 'configured' ? selectedValue(answers[key], questions.find((q) => q.key === key)) : null)
    if (step === 1) return picked('image')==='existing'?'existing':'simple'
    if (question) return picked(question.key) ?? recommendedValue(question, style)
    return ''
  })()
  const [choiceState,setChoiceState]=useState<{step:WizardStep;value:string}>({step,value:current})
  const choice=choiceState.step===step?choiceState.value:current
  const setChoiceValue=(value:string)=>setChoiceState({step,value})
  const setChoice=(value:string)=>{if(step===1)setMenuConfirmed(false);setChoiceValue(value);setDirty(true)}

  const answer = (key: string, value: SetupAnswer) => {
    setAnswers((prev) => ({ ...prev, [key]: value }))
    setDirty(true)
  }

  /*  (2)：開き直して保存するときは、変えた答えだけを送る（前の答えで予約設定を書き戻さない）。 */
  const [saved, setSaved] = useState<Record<string, SetupAnswer>>(answersForApi(state.answers ?? {}))
  const [confirm, setConfirm] = useState<{ lines: string[]; run: () => Promise<boolean>; complete: () => void; cancel: () => void } | null>(null)

  const save = async (next: Record<string, SetupAnswer>, nextChoices = choices, options: { skipSettings?: boolean } = {}) => {
    let changed = changedAnswers(saved, answersForApi(next))
    if (options.skipSettings) changed = Object.fromEntries(Object.entries(changed).filter(([key]) => !SETTINGS_KEYS.includes(key)))
    const res = await styleApi.save(accountId, { expectedVersion: version, ...(menuConfirmed?{confirmInitialMenu:true}:{}), ...(styleChosen ? { style } : {}), answers: changed, choices: Object.keys(nextChoices).length ? nextChoices : undefined })
    if (!res.success) throw new Error('save failed')
    accountStyleUpdated(accountId)
    setVersion(res.data.version)
    setSaved((prev) => ({ ...prev, ...changed }))
    setDirty(false)
  }

  /* 予約設定が変わる答え（承認の仕方）を送るときは、何が変わるかを確かめの窓で出してから保存する。 */
  const confirmThenSave = (next: Record<string, SetupAnswer>, nextChoices = choices) => new Promise<boolean>((resolve, reject) => {
    const lines = settingsChanges(saved, answersForApi(next))
    if (lines.length === 0) { save(next, nextChoices).then(() => resolve(true), reject); return }
    setError('')
    setConfirm({
      lines,
      run: async () => { await save(next, nextChoices); return true },
      complete: () => { setConfirm(null); resolve(true) },
      cancel: () => { setConfirm(null); resolve(false) },
    })
  })

  const loadSummary = async () => {
    const [set, items] = await Promise.all([styleApi.starterSet(accountId, style), styleApi.starterItems(accountId)])
    if (!set.success || !items.success) throw new Error('summary failed')
    const pairs = pairStarterItems(set.data.definition.items, items.data.items)
    /*  (3)：予約確定の見本の自動送信は、いつもの確定の知らせと重なるので一覧に出さない（動かさせない）。 */
    const activation = pairs.filter((pair) => needsActivation(pair.state) && !isBookingConfirmSample(pair.item))
    setSummary({ inserted: pairs.filter((pair) => pair.item.kind in KIND_WORD), activation })
    /*  (3)：自動で送る物・予約メニューは最初から全部止めた状態。オンにするのは利用者が自分で。 */
    setEnabled(Object.fromEntries(activation.map((pair) => [pair.state.target_id, false])))
  }

  /* 最後の一覧から開いたときは、入った物を読んでから出す。 */
  useEffect(() => {
    if (step !== 'summary' || summary) return
    let cancelled = false
    setBusy(true)
    loadSummary().catch((caught) => { if (!cancelled) setError(describeApiFailure(caught, '読み込み')) }).finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [step]) // eslint-disable-line react-hooks/exhaustive-deps

  const go = async (next: WizardStep, nextAnswers = answers, nextChoices = choices) => {
    setError('')
    if (next === 'summary') {
      setBusy(true)
      try {
        if (!(await confirmThenSave(nextAnswers, nextChoices))) return
        setSummary(null)
        setStep('summary')
      } catch (caught) {
        setError(describeApiFailure(caught, '保存'))
      } finally {
        setBusy(false)
      }
      return
    }
    setStep(next)
  }

  const nextOf = (i: number): WizardStep => (i + 1 >= total ? 'summary' : i + 1)

  const commitAndNext = (key: string, value: SetupAnswer, nextChoices = choices) => {
    const nextAnswers = { ...answers, [key]: value }
    answer(key, value)
    setChoices(nextChoices)
    void go(nextOf(index), nextAnswers, nextChoices)
  }

  const selectedAnswer = async (): Promise<{ key: string; value: SetupAnswer; nextChoices: typeof choices } | null> => {
    if (step === 1) {
      if (choice === 'configured') { preparing.open(LOOK_CHOICES.find((c) => c.value === choice)!.label); return null }
      if (choice === 'later' || choice === 'manual') return { key: 'image', value: { mode: choice }, nextChoices: choices }
      if (choice === 'simple') {
        const set=await styleApi.starterSet(accountId,style,true)
        if(!set.success)throw new Error('メニューを確認できませんでした')
        const key=set.data.definition.items.find(item=>item.kind==='rich_menu')?.key
        return {key:'image',value:{mode:'configured',value:'simple'},nextChoices:key?{...choices,[key]:{mode:'sample'}}:choices}
      }
      if (choice === 'existing') {
        if (!resource) { setError('使うリッチメニューを選んでください。'); return null }
        /* 今あるリッチメニューをそのまま使う：初期セットのリッチメニューの代わりにする（choices）。 */
        try {
          const set = await styleApi.starterSet(accountId, style)
          const menuKey = set.success ? set.data.definition.items.find((item) => item.kind === 'rich_menu')?.key : undefined
          return { key: 'image', value: { mode: 'configured', value: 'existing',resourceId:resource }, nextChoices: menuKey ? { ...choices, [menuKey]: { mode: 'existing', resourceId: resource } } : choices }
        } catch (caught) { setError(describeApiFailure(caught, '読み込み')); return null }
      }
      return { key: 'image', value: { mode: 'configured', value: choice }, nextChoices: choices }
    }
    return question ? { key: question.key, value: answerOf(choice, question), nextChoices: choices } : null
  }

  const onNext = async () => {
    if (step === 0) {
      /* スタイルの「あとで」「手動」は口の styleMode で保存する（別の人・別の端末でも同じ）。 */
      if (choice === 'later' || choice === 'manual') { await saveStyleMode(choice); return }
      if (!choice) return
      if (styleOnly) {
        if (choice === state.style) { onClose(false); return }
        setBusy(true)
        setError('')
        try {
          const res = await styleApi.save(accountId, { expectedVersion: version, style: choice as AccountStyle })
          if (!res.success) throw new Error('使い方を保存できませんでした')
          accountStyleUpdated(accountId)
          onClose(true)
        } catch (caught) { setError(describeApiFailure(caught, '保存')) }
        finally { setBusy(false) }
        return
      }
      setStyleChosen(true)
      setDirty(true)
      if (choice !== style) {setMenuConfirmed(false);setStyle(choice as AccountStyle)}
      void go(1)
      return
    }
    const selected = await selectedAnswer()
    if (selected) {if(step===1)setMenuConfirmed(selected.value.value==='simple');commitAndNext(selected.key, selected.value, selected.nextChoices)}
  }

  /* 1 問目で選ぶ。保存は［次へ］から先の今の流れのまま。選び直しは閉じる時の未保存確認に入れる。 */
  const chooseStyle = (next: AccountStyle) => {
    if(next!==style)setMenuConfirmed(false)
    setChoice(next)
    if (next !== (styleChosen ? style : '')) setDirty(true)
  }

  const discard = () => {
    if (!busy) onClose(version !== state.version)
  }

  const saveAndClose = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      /* 途中保存では、予約設定を変更する答えは最後の確認まで送らない。 */
      if (step !== 'summary' && step !== 0) {
        const selected = await selectedAnswer()
        if (!selected) return
        await save({ ...answers, [selected.key]: selected.value }, selected.nextChoices, { skipSettings: true })
      }
      onClose(true)
    } catch (caught) {
      setError(describeApiFailure(caught, '保存'))
    } finally {
      setBusy(false)
    }
  }

  /* スタイルを「あとで」（はじめにやることに残る）・「手動」（スタイルを使わず設定の画面で決める）。 */
  const saveStyleMode = async (mode: 'later' | 'manual') => {
    setBusy(true)
    setError('')
    try {
      const res = await styleApi.save(accountId, { expectedVersion: version, styleMode: mode })
      if (!res.success) throw new Error('save failed')
      onClose(true)
      if (mode === 'manual') router.push('/settings')
    } catch (caught) {
      setError(describeApiFailure(caught, '保存'))
    } finally {
      setBusy(false)
    }
  }

  const activate = async () => {
    const targets = (summary?.activation ?? []).filter((pair) => enabled[pair.state.target_id])
    setBusy(true)
    setError('')
    try {
      /* 予約メニューは今の版を読んで渡す。オートメーションは下書きの版（draftRevision）。 */
      const items = await Promise.all(targets.map(async ({ state: target }) => {
        if (target.kind === 'automation') return { id: target.target_id, kind: 'automation' as const, expectedDraftVersionId: target.draftRevision ?? undefined }
        const menu = await styleApi.menu(accountId, target.target_id)
        if (!menu.success) throw new Error('menu failed')
        return { id: target.target_id, kind: 'booking_menu' as const, expectedVersion: menu.data.version }
      }))
      const res = await styleApi.activate(accountId, items)
      if (!res.success) throw new Error('activate failed')
      const failed = res.data.items.filter((item) => !item.success)
      if (!res.data.complete || failed.length > 0) {
        /* 途中の失敗を成功で隠さない（API-CONTRACT-4）。動いた物は動いたまま、動かなかった物の名前を出す。 */
        const names = failed.map((item) => targets.find((pair) => pair.state.target_id === item.id)?.item.name ?? item.id)
        setError(`動かせなかった物があります：${names.join('・')}。中身を確かめて、もう一度押してください。`)
        await loadSummary()
        return
      }
      notifySaved(`${formatNumber(items.length)}件を動かしました`)
      onClose(true)
    } catch (caught) {
      setError(describeApiFailure(caught, '動かす操作'))
    } finally {
      setBusy(false)
    }
  }


 return { style, setStyle, answers, setAnswers, choices, setChoices, version, setVersion, step, setStep, dirty, setDirty, busy, setBusy, error, setError, router, summary, setSummary, enabled, setEnabled, resources, setResources, resource, setResource, preparing, steps, questions, total, index, question, current, choice, setChoice, answer, saved, setSaved, confirm, setConfirm, save, confirmThenSave, loadSummary, go, nextOf, commitAndNext, onNext, chooseStyle, discard, saveAndClose, saveStyleMode, activate }
}

import { KIND_WORD } from './wizard-item-kinds'
import { formatNumber } from '@/lib/format'
