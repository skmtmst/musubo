-- 初回の時刻は後のスタイル保存や初期セットの再配布で変わらないようにする。
ALTER TABLE account_styles ADD COLUMN first_selected_at TEXT;
ALTER TABLE account_styles ADD COLUMN first_starter_at TEXT;

UPDATE account_styles SET first_selected_at = selected_at;
-- 既存の記録から復元できる最も早い適用時刻。過去に上書き・削除された時刻は復元できない。
UPDATE account_styles SET first_starter_at = (
  SELECT MIN(applied_at) FROM (
    SELECT applied_at FROM style_starter_items WHERE line_account_id = account_styles.line_account_id
    UNION ALL
    SELECT updated_at AS applied_at FROM style_starter_catalog_items
      WHERE line_account_id = account_styles.line_account_id AND state = 'succeeded'
  )
);
