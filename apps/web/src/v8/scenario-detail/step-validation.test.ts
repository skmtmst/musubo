/*
 * 通を保存する前の検査（validateScenarioStep）を、入力の形ごとに呼んで確かめる。
 * - SCENARIO-21：質問・直接入力・テンプレートは別々に検査し、直接作った質問をテンプレート必須で止めない
 * - SCENARIO-22：URL などを開くだけの選択肢に、届かない設定（返信・タグ・友だち情報）が残っていたら止める
 * - R214：選択肢の行き先（URL・電話・メール）の形が正しくなければ止める
 */
import { describe, expect, it } from 'vitest'
import { emptyMessageKindState } from '@/components/scenarios/message-kind-fields'
import type { ScenarioQuestion } from '@/components/scenarios/question-editor'
import { emptyStepForm, type StepFormState } from './detail-model'
import { validateScenarioStep } from './step-validation'

const question = (patch: Partial<ScenarioQuestion> = {}): ScenarioQuestion => ({
  tapMode: 'single',
  text: '体調はいかがですか？',
  choices: [{ label: 'はい', behavior: 'none' }],
  ...patch,
})

function form(patch: Partial<StepFormState>): StepFormState {
  const base = emptyStepForm(1)
  return { ...base, schedule: { ...base.schedule, deliveryTime: '10:00' }, ...patch }
}

const check = (patch: Partial<StepFormState>) => validateScenarioStep(form(patch), emptyMessageKindState(), 'absolute_time')

describe('SCENARIO-21: 直接作った質問はテンプレート必須にかからない', () => {
  it('テンプレートを選ばない質問の通は、テンプレートが無くても通る', () => {
    expect(check({ inputMode: 'template', templateId: null, question: question() })).toBeNull()
  })

  it('質問でも直接入力でもない通だけ、テンプレートを求める', () => {
    expect(check({ inputMode: 'template', templateId: null })).toEqual({ field: 'template', message: 'テンプレートを選択してください' })
    expect(check({ inputMode: 'template', templateId: 'tpl-1' })).toBeNull()
  })

  it('質問の空文・空の選択肢は止める', () => {
    expect(check({ question: question({ text: '  ' }) })).toEqual({ field: 'question', message: '質問文を入力してください' })
    expect(check({ question: question({ choices: [{ label: 'はい', behavior: 'none' }, { label: ' ', behavior: 'none' }] }) })).toEqual({ field: 'question', message: 'すべての選択肢に文字を入力してください' })
    expect(check({ question: question({ choices: [] }) })?.message).toBe('すべての選択肢に文字を入力してください')
  })

  it('直接入力は本文を求め、Flex・画像は JSON の形を見る', () => {
    expect(check({ inputMode: 'direct', messageContent: '' })).toEqual({ field: 'content', message: 'メッセージ内容を入力してください' })
    expect(check({ inputMode: 'direct', messageType: 'flex', messageContent: '{壊れた' })?.message).toBe('Flex メッセージの JSON が不正です')
    expect(check({ inputMode: 'direct', messageType: 'image', messageContent: 'not json' })?.message).toBe('画像メッセージの JSON が不正です')
    expect(check({ inputMode: 'direct', messageType: 'flex', messageContent: '{"type":"bubble"}' })).toBeNull()
  })
})

describe('SCENARIO-22: URIだけの挙動に届かない設定を残したまま保存させない', () => {
  it('URL を開く選択肢に返信が残っていたら、選択肢の番号と届かない設定を名指しして止める', () => {
    const problem = check({ question: question({ choices: [
      { label: 'はい', behavior: 'none' },
      { label: '詳しく見る', behavior: 'url', url: 'https://example.com', reply: 'ありがとう' },
    ] }) })
    expect(problem?.field).toBe('question')
    expect(problem?.message).toBe('選択肢2はURLなどを開くだけの挙動のため、設定されている選択時の返信は実行されません。設定を消すか、挙動を「何もしない」に変えてください。')
  })

  it('届く挙動（何もしない）なら同じ返信が残っていても止めない', () => {
    expect(check({ question: question({ choices: [{ label: 'はい', behavior: 'none', reply: 'ありがとう' }] }) })).toBeNull()
  })
})

describe('R214: 行き先の形が正しくない選択肢は保存しない', () => {
  it('URL を開くに not-a-url を入れると、選択肢の番号で止める', () => {
    const problem = check({ question: question({ choices: [{ label: '見る', behavior: 'url', url: 'not-a-url' }] }) })
    expect(problem?.field).toBe('question')
    expect(problem?.message).toContain('選択肢1のURL')
  })

  it('正しい URL・電話・メールは通す', () => {
    expect(check({ question: question({ choices: [
      { label: '見る', behavior: 'url', url: 'https://example.com/a' },
      { label: '電話', behavior: 'tel', tel: '03-0000-5678' },
      { label: 'メール', behavior: 'mail', email: 'a@example.com' },
    ] }) })).toBeNull()
  })
})

it('既存の20文字超の選択肢は消さず保存を止め、20文字に直せば保存できる', () => {
  const original = question({ choices: [{ label: 'あ'.repeat(25), behavior: 'none' }] })
  expect(check({ question: original })).toEqual({ field: 'question', message: '選択肢 1 のボタンの文字は20文字以内で入力してください。' })
  expect(original.choices[0].label).toBe('あ'.repeat(25))
  expect(check({ question: question({ choices: [{ label: 'あ'.repeat(20), behavior: 'none' }] }) })).toBeNull()
})
