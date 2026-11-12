import type { ScenarioQuestion } from '@/components/scenarios/question-editor'
import type { Tag, Scenario } from '@line-crm/shared'
import type { QuestionChoice } from '@/components/scenarios/question-editor'
import { Tag as TagIcon, GitBranch, MousePointerClick, type LucideIcon } from 'lucide-react'
/** 「押されたら」に出す1行（絵：「タグ「継続」を付ける」「シナリオ「解約フォロー」を始める」）。 */
export function choiceActionText(choice: QuestionChoice, tags: Array<Pick<Tag, 'id' | 'name'>>, scenarios: Array<Pick<Scenario, 'id' | 'name'>>): string {
  const parts: string[] = []
  const tagNames = (choice.addTagIds ?? []).map((id) => tags.find((tag) => tag.id === id)?.name ?? 'タグ')
  if (tagNames.length) parts.push(`タグ「${tagNames[0]}」を付ける${tagNames.length > 1 ? ` ほか${tagNames.length - 1}` : ''}`)
  if (choice.removeTagIds?.length) parts.push(`タグを${choice.removeTagIds.length}つ外す`)
  if (choice.field?.fieldId) parts.push('友だち情報に書く')
  if (choice.scenario?.op === 'start') {
    const name = scenarios.find((item) => item.id === choice.scenario?.scenarioId)?.name
    parts.push(name ? `シナリオ「${name}」を始める` : 'シナリオを始める')
  }
  if (choice.scenario?.op === 'stop') parts.push('シナリオを止める')
  const behavior: Partial<Record<QuestionChoice['behavior'], string>> = {
    url: 'URLを開く', tel: '電話をかける', add_friend: '友だち追加へ', mail: 'メールを送る', form: '回答フォームを開く',
  }
  if (behavior[choice.behavior]) parts.push(behavior[choice.behavior] as string)
  return parts.length ? parts.join('・') : '何もしない'
}

/** 「押されたら」の欄の印：タグ＝札、シナリオ＝分かれ道、そのほか＝押す。 */
export function choiceActionIcon(choice: QuestionChoice): LucideIcon {
  if (choice.addTagIds?.length || choice.removeTagIds?.length) return TagIcon
  if (choice.scenario?.op) return GitBranch
  return MousePointerClick
}

export function displayText(value: string): string {
  return value
    .replaceAll('{{name}}', '見本 141')
    .replace(/\{\{field\.[^}]+\}\}/g, '登録済みの情報')
    .replace(/\{\{var\.[^}]+\}\}/g, '共通情報')
}

export function isEditableQuestion(value: unknown): value is ScenarioQuestion {
  if (!value || typeof value !== 'object') return false
  const question = value as Record<string, unknown>
  if (typeof question.text !== 'string') return false
  if (question.tapMode !== 'single' && question.tapMode !== 'multiple') return false
  if (!Array.isArray(question.choices)) return false
  return question.choices.every((choice) => !!choice && typeof choice === 'object' && typeof (choice as Record<string, unknown>).label === 'string')
}
