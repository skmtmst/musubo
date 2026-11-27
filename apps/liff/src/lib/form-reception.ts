export function choiceReceptionLabel(choice?: { remaining: number; full: boolean }): string {
  if (choice === undefined) return '';
  if (!choice || typeof choice.full !== 'boolean' || !Number.isSafeInteger(choice.remaining) || choice.remaining < 0 || choice.full !== (choice.remaining === 0)) return '（受付状況を確認できません）';
  return `（${choice.full ? '受付終了' : `残り${choice.remaining}件`}）`;
}
