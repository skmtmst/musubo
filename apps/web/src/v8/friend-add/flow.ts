/*
 * 友だち追加時配信「確認」段の説明文を組み立てる（IDEA-09）。
 *
 * 保存済みの定義から「経路 → 初回案内 → 付く属性 → 次の配信」の順と、
 * 再追加（ブロック解除を含む）で動く／動かない処理を並べる。
 * すべて画面表示専用の説明で、ここで実際の登録・送信・属性更新は行わない。
 */
import type {
  FriendAddRuleDefinition,
  FriendAddRuleKind,
  FriendAddRuleStatus,
} from '@/lib/api'
import { knownValue } from '@/lib/known-value'
import { resendSuppressionText } from './text'
import { formatNumber } from '@/lib/format'

export type FriendAddFlowStep = {
  key: 'route' | 'firstMessage' | 'attributes' | 'nextDelivery'
  title: string
  detail: string
}

export const MESSAGE_TYPE_LABEL: Record<FriendAddRuleDefinition['messageType'], string> = Object.assign(Object.create(null) as Record<FriendAddRuleDefinition['messageType'], string>, {
  text: 'テキスト',
  template: 'テンプレート',
  form: '回答フォーム',
  scenario: 'シナリオ',
})

/**
 * 「この経路から来た人に起きること」を、経路・初回案内・付く属性・次の配信の
 * 順で返す。設定に無いものは例示で埋めず、「ありません」と書く。
 */
export function friendAddFlowSteps(input: {
  isFallback: boolean
  /** 選択した routeIds のうち、候補一覧から名前が取れたもの。 */
  routeNames: string[]
  /** 選択した routeIds のうち、候補に無い（停止・削除済み）数。 */
  missingRouteCount: number
  friendKind: FriendAddRuleKind
  definition: FriendAddRuleDefinition
  /** scenarioId に対応するシナリオ名。候補に無い（削除済み）なら null。 */
  scenarioName: string | null
}): FriendAddFlowStep[] {
  const { definition } = input
  // 再追加で「何も配信しない」は最初の案内を届けない（R261）。
  // 案内後のアクション（タグ付けやシナリオ開始）は実行される。
  const deliversNothing = input.friendKind === 'returning' && definition.returningMode === 'none'

  // ① 経路 —— どこから来た人か。基本URLと個別QRは同じ経路URLとして扱う。
  let routeTitle: string
  let routeDetail: string
  if (input.isFallback) {
    routeTitle = '経路が分からなかった人（受け皿）'
    routeDetail = '基本の追加URL・素のQRなど、流入経路を特定できない追加にいちばん最後に動きます。'
  } else {
    routeTitle = input.routeNames.length > 0
      ? input.routeNames.join('、')
      : '対象の流入リンクは未選択です'
    const notes = ['選んだ経路のURL・QR（どちらも同じ入口）から追加された人に動きます。']
    if (input.missingRouteCount > 0) {
      notes.push(`停止・削除済みの経路が${formatNumber(input.missingRouteCount)} 件含まれています。`)
    }
    notes.push('基本の追加URLなど経路を特定できない追加には、この設定ではなく「経路が分からなかった人」の設定が動きます。')
    routeDetail = notes.join('')
  }

  // ② 初回案内 —— 最初に届くもの
  const sendsWelcome = !deliversNothing
    && definition.deliveryChoices?.sendWelcomeMessage !== false
    && definition.messageType !== 'scenario'
  const firstTitle = sendsWelcome
    ? `初回案内（${knownValue(MESSAGE_TYPE_LABEL, definition.messageType, '種類を確認できません')}）`
    : '初回案内'
  const firstDetail = deliversNothing
    ? '「何も配信しない」の設定のため届きません。'
    : sendsWelcome
      ? `${definition.timing === 'immediate' ? '登録直後に届きます。' : 'シナリオの時刻に従って届きます。'}${definition.messageText.trim() ? '' : '文面は未設定です。'}`
      : '最初の1通は送らず、シナリオへの登録だけを行います。'

  // ③ 付く属性 —— タグの追加・解除（start_scenario は次の配信へ回す）
  const tagActions = definition.actions.filter(
    (action) => action.type === 'add_tag' || action.type === 'remove_tag',
  )
  const attrDetail = tagActions.length > 0
    ? tagActions.map((action) => action.label).join('／')
    : 'タグの追加・解除はありません。'

  // ④ 次の配信 —— 登録するシナリオと、シナリオ開始アクション
  const nextParts: string[] = []
  if (deliversNothing) {
    // 実行側と同じ区別：最初の案内は届けないが、案内後のアクションとして
    // 設定したシナリオ開始は動く。動かないと断定すると下の文と矛盾する（R261）。
    nextParts.push('「何も配信しない」の設定のため、最初の案内は届きません。')
  } else if (definition.scenarioId) {
    nextParts.push(input.scenarioName
      ? `シナリオ「${input.scenarioName}」を開始します。`
      : '削除済みのシナリオを指しています。')
  } else {
    nextParts.push('配信シナリオは未選択です。')
  }
  const scenarioActions = definition.actions.filter((action) => action.type === 'start_scenario')
  if (scenarioActions.length > 0) {
    nextParts.push(scenarioActions.map((action) => action.label).join('／'))
  }

  return [
    { key: 'route', title: routeTitle, detail: routeDetail },
    { key: 'firstMessage', title: firstTitle, detail: firstDetail },
    { key: 'attributes', title: '付く属性', detail: attrDetail },
    { key: 'nextDelivery', title: '次の配信', detail: nextParts.join('') },
  ]
}

export type FriendAddTimeWindow = { start: string; end: string }

/**
 * 時間帯の1件だけを更新する。先頭以外の時間帯は保持する（FRIENDADD-05）。
 * 以前は先頭だけを表示し、配列全体を1件で置き換えて2件目以降を消していた。
 */
export function updateTimeWindow(
  windows: FriendAddTimeWindow[] | undefined,
  index: number,
  patch: Partial<FriendAddTimeWindow>,
): FriendAddTimeWindow[] {
  return (windows ?? []).map((window, itemIndex) => (itemIndex === index ? { ...window, ...patch } : window))
}

export function removeTimeWindow(
  windows: FriendAddTimeWindow[] | undefined,
  index: number,
): FriendAddTimeWindow[] {
  return (windows ?? []).filter((_, itemIndex) => itemIndex !== index)
}

export function addTimeWindow(windows: FriendAddTimeWindow[] | undefined): FriendAddTimeWindow[] {
  return [...(windows ?? []), { start: '08:00', end: '21:00' }]
}

/** サマリー向けの時間帯表示。複数あるときは全件あることが分かる形にする。 */
export function timeWindowsSummary(windows: FriendAddTimeWindow[] | undefined): string {
  const list = windows ?? []
  if (list.length === 0) return 'いつでも'
  if (list.length === 1) return `${list[0].start}〜${list[0].end}`
  return `${list[0].start}〜${list[0].end} など${formatNumber(list.length)} 件`
}

/**
 * 再追加（ブロック解除を含む）で動く／動かない処理の説明行。
 * 実行側と同じ分岐（returningMode・再送制限・状態）だけを説明する。
 */
export function friendAddReaddLines(input: {
  friendKind: FriendAddRuleKind
  status: FriendAddRuleStatus
  definition: FriendAddRuleDefinition
}): string[] {
  const lines: string[] = []
  if (input.status === 'stopped') {
    lines.push('この設定は停止中です。はじめての追加にも再追加にも動きません。')
  } else if (input.status === 'draft') {
    lines.push('この設定は下書きです。有効化するまで実行されません。')
  }

  if (input.friendKind === 'first_time') {
    lines.push('再追加・ブロック解除で戻った人には動きません。「以前からの友だち・ブロック解除した人」側の設定が動きます。')
  } else {
    // 未選択は実行側の既定（別のシナリオ扱い）に合わせる。
    const mode = input.definition.returningMode ?? 'other'
    if (mode === 'none') {
      // 実行側と同じ区別：最初の案内は届けないが、案内後のアクション
      // （シナリオ開始を含む）は実行される。「シナリオを動かさない」と
      // 書くと、開始するよう設定した文と矛盾する（R261）。
      lines.push('再追加では最初の案内は届きません。')
      lines.push(input.definition.actions.length > 0
        ? '設定したアクションは実行されます。'
        : 'アクションも実行されません。')
    } else if (mode === 'same') {
      lines.push('再追加では、はじめての人と同じ案内・シナリオ・アクションが動きます。')
    } else {
      lines.push(`再追加では選んだシナリオを${input.definition.startPosition === 'resume' ? '前回配信した次から' : '最初から'}流します。`)
    }
  }

  // 送るものが無い設定（再追加で「何も配信しない」）に再送の説明は要らない。
  const deliversNothing = input.friendKind === 'returning' && input.definition.returningMode === 'none'
  if (!deliversNothing) {
    const hours = input.definition.resendSuppressionHours ?? 24
    lines.push(hours > 0
      ? `同じ人への再送は「${resendSuppressionText(hours)}」。期間内に届いている人には送りません。`
      : '同じ人への再送は制限しません。')
  }
  return lines
}
