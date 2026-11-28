/*
 * テンプレートの見本（F-5）。`GET /api/templates/examples` の4件。
 * 口は保存・送信をしない。見本を押すと、メッセージを作る画面に名前と本文を入れて開く（保存は利用者が押す）。
 */
import { fetchApi } from '@/lib/api'

export type TemplateExample = {
  id: string
  name: string
  body: string
}

/** 口の返事から、形の合う見本だけを取り出す（合わないものは黙って捨てる）。 */
export function pickTemplateExamples(value: unknown): TemplateExample[] {
  if (!value || typeof value !== 'object') return []
  const data = (value as { success?: unknown; data?: unknown }).data
  if ((value as { success?: unknown }).success !== true || !Array.isArray(data)) return []
  return data.flatMap((item): TemplateExample[] => {
    if (!item || typeof item !== 'object') return []
    const { id, name, body } = item as Record<string, unknown>
    if (typeof id !== 'string' || typeof name !== 'string' || typeof body !== 'string') return []
    if (!id.trim() || !name.trim()) return []
    return [{ id, name, body }]
  })
}

export async function loadTemplateExamples(): Promise<TemplateExample[]> {
  const response = await fetchApi<unknown>('/api/templates/examples')
  if (!response || typeof response !== 'object' || (response as { success?: unknown }).success !== true || !Array.isArray((response as { data?: unknown }).data)) throw new Error('見本の応答を確認できません')
  const data = (response as { data: unknown[] }).data
  const examples = pickTemplateExamples(response)
  if (data.length > 0 && examples.length === 0) throw new Error('見本の内容を確認できません')
  return examples
}

/** 見本から作るときの行き先（メッセージを作る画面。`?example=` で見本の番号を渡す）。 */
export function exampleHref(example: Pick<TemplateExample, 'id'>): string {
  return `/templates/edit?example=${encodeURIComponent(example.id)}`
}
