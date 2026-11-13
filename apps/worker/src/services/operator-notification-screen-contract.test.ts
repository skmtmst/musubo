import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { listOperatorEventTypes } from './operator-notification-registry.js';

// 実際の選択肢を実行して比べる。別アプリ全体をWorkerの型検査へ含めない。
const optionsPath = fileURLToPath(new URL('../../../web/src/v8/line-notifications/operator-event-options.ts', import.meta.url));
const { OPERATOR_EVENT_OPTIONS } = await import(optionsPath) as {
  OPERATOR_EVENT_OPTIONS: ReadonlyArray<{ value: string; label: string }>;
};

/**
 * 画面に出さない登録簿のきっかけ。
 *
 * **空のままにしておくのが既定。**「まだ画面に出さない」種類を足すときは、
 * ここへ値と理由を書く。書かずに画面から外すと下の試験が落ちる。
 * 黙って消えるのを防ぐのがこの配列の役目で、**理由を書く場所があること
 * 自体が抑止**になる。
 */
const SCREEN_HIDDEN_EVENT_TYPES: ReadonlyArray<{ eventType: string; reason: string }> = [
  {eventType:'inbox_new_inquiry',reason:'担当者通知はAPIのみの担当。画面の選択肢・PWAはClaudeの接続待ち。APIから通知ルールを作れる。画面の接続時にこの例外を消す。'},
  {eventType:'inbox_assigned_reply',reason:'担当者通知はAPIのみの担当。画面の選択肢・PWAはClaudeの接続待ち。APIから通知ルールを作れる。画面の接続時にこの例外を消す。'},
];

describe('画面のきっかけと登録簿の突き合わせ', () => {
  it('画面の選択肢には空の値・ラベルと重複がない', () => {
    const options = OPERATOR_EVENT_OPTIONS;
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((option) => option.value.length > 0)).toBe(true);
    expect(options.every((option) => option.label.length > 0)).toBe(true);
    // 値の重複は、片方のラベルが死ぬので落とす。
    expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
  });

  it('画面にあって登録簿に無いきっかけは1つも無い（選べるのに発火しない）', () => {
    const registry = new Set(listOperatorEventTypes().map((entry) => entry.eventType));
    const orphans = OPERATOR_EVENT_OPTIONS.map((option) => option.value)
      .filter((value) => !registry.has(value));
    expect(
      orphans,
      `画面にあるが登録簿に無い: ${orphans.join(', ')}。`
      + 'このきっかけは公開しても自動発火しません。producer を繋ぐか、画面から外してください。',
    ).toEqual([]);
  });

  it('登録簿にあって画面に無いきっかけは、理由を書いたものだけ（出し忘れを防ぐ）', () => {
    const shown = new Set(OPERATOR_EVENT_OPTIONS.map((option) => option.value));
    const hidden = new Set(SCREEN_HIDDEN_EVENT_TYPES.map((entry) => entry.eventType));
    const missing = listOperatorEventTypes().map((entry) => entry.eventType)
      .filter((eventType) => !shown.has(eventType) && !hidden.has(eventType));
    expect(
      missing,
      `登録簿にあるが画面に無い: ${missing.join(', ')}。`
      + '画面へ足すか、SCREEN_HIDDEN_EVENT_TYPES へ理由を書いてください。',
    ).toEqual([]);
    // 除外の理由は必ず書かせる。空文字で黙らせられないようにする。
    expect(SCREEN_HIDDEN_EVENT_TYPES.every((entry) => entry.reason.trim().length > 0)).toBe(true);
  });

  it('接続済みのきっかけは、明示したAPI先行分を除き画面から選べる', () => {
    const shown = new Set(OPERATOR_EVENT_OPTIONS.map((option) => option.value));
    const connectedButHidden = listOperatorEventTypes()
      .filter((entry) => entry.connected && !shown.has(entry.eventType)
        && !SCREEN_HIDDEN_EVENT_TYPES.some(hidden=>hidden.eventType===entry.eventType))
      .map((entry) => entry.eventType);
    // 接続済み = producer が実際に出している。出せるのに作れないのは穴。
    expect(connectedButHidden).toEqual([]);
    // 画面へ接続したら、API先行の例外を残し続けない。
    expect(SCREEN_HIDDEN_EVENT_TYPES.filter(entry=>shown.has(entry.eventType))).toEqual([]);
  });
});
