import type {AccountStyle,SetupAnswer} from '@line-crm/shared';
export type StyleProfile = {
  line_account_id: string;
  style: AccountStyle;
  answers_json: string;
  cards_json: string | null;
  metrics_json: string | null;
  settings_json: string;
  selected_at: string | null;
  first_selected_at: string | null;
  selection_mode: SetupAnswer['mode'];
  version: number;
  updated_at: string;
};
export function hasPendingStyleSelection(p: StyleProfile | null): boolean {
  if (!p || p.selected_at || p.selection_mode !== 'later') return false;
  const answers = JSON.parse(p.answers_json) as { style?: { selectionPending?: boolean } };
  return answers.style?.selectionPending === true;
}
export function profileAnswers(
  p: StyleProfile | null,
): Record<string, SetupAnswer> {
  return {
    ...JSON.parse(p?.answers_json ?? '{}'),
    style: {
      mode: p?.selection_mode ?? 'later',
      ...(p?.selection_mode === 'configured' ? { value: p.style } : {}),
    },
  };
}
export async function profile(db: D1Database, account: string) {
  return db
    .prepare('SELECT * FROM account_styles WHERE line_account_id=?')
    .bind(account)
    .first<StyleProfile>();
}
