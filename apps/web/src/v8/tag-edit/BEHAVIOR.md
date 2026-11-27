> 文書：タグ：タグの編集・保存した検索の編集の動き（BEHAVIOR.md）｜区分：今の説明｜最終確認：2026-10-19（日本時間）

# タグ：タグの編集・保存した検索の編集の動き（BEHAVIOR.md）

板：タグの編集 `Qat9s`・競合 `xn95q`（閲覧のみ `fkGUR`）／保存した検索の編集 `AqDWN`。
写し元：`src/v8/tag-edit/edit.tsx`・`src/v8/tag-edit/edit-form.tsx`（タグ）、`src/v8/tag-edit/search-edit.tsx`（保存した検索）、`app/tags/edit/tag-conflict-diff.ts`・`app/tags/searches/edit/reference-options.ts` を写した（src/v8 から @/app は読まない）。共通部品（components/friend-fields の ArchivedTagEditor・DeleteDialog・ActionDrawer・RetroactiveDialog など）はそのまま使う。入口 `app/tags/edit/page.tsx`・`app/tags/searches/edit/page.tsx` の V8 の import だけ差し替えた。旧表示への分岐と未使用の写しは廃止し、V8だけを使う。

## タグの編集（edit.tsx）
- URL：`/tags/edit?id=<タグID>`（`visualQa=retroactive` で さかのぼり反映の確認を開いた形）。id 無し・見つからない・読めないときは TargetMissing。アカウント未選択は「選んでください」。保管済みのタグは ArchivedTagEditor（名前と説明だけ）。
- 呼ぶ口：`api.tags.definition`・`dependencies`（使っている所の数・削除の影響）・`api.tagGroups.list`（アカウントで絞る）・`api.tags.list`（同じ名前の注意）・`retroactivePreview`（さかのぼりの人数・400ms 待つ）・`updateDefinition`（PATCH・`expectedVersion`・要求キー）・`delete`。
- 画面：頭（戻る・タグ名・「フォルダ・N人に付いている・作った日」）。左に 基本（タグ名・所属フォルダ・友だち一覧に出す）→ タグ連動（畳んだ1行の要約・開く。開くと 動きの行（上へ・下へ・複製・削除）・アクションを追加する。題の右に オン／オフ）→ マイル（連動がオンのとき。畳んだ1行・開く。開くと 倍率・優先度・さかのぼって積む・付与するマイル（本人／紹介者）・付け直したときの扱い）。右に 使っている所（一斉配信・回答フォーム・オートメーションは常に、ほかは使っているときだけ。タグ連動は押すと段を開く）と案内の帯。
- 下の帯：タグを削除する（左）・キャンセル・複製して作る・タグを保存する。
- 競合（409）：頭の下に琥珀の帯（違いを比べる・最新を読み込んで続ける）。入力は残し、畳んだ段は全部開く。保存ボタンは「比べてから保存」（比べる窓）。
- 閲覧のみ：削除・複製して作る・保存・アクションを追加するを置かない（隠す）。変更欄は読み取りの文字で見せ、明細の開く／閉じるは使える。保存中はfieldsetで止める。閲覧のみの帯を出す。
- 今の画面から変えたところ：「分類の使い分け」の案内と「できあがるタグ」「取り消せない操作です」の箱を外した（絵に無い。編集では種類は変わらない）。連動の説明2行は題の横の「？」へ。動きの並べ替えは上へ・下へのボタンだけ（つまんで動かすのは外した。絵の言葉「並べ替えは上下の印で」）。

## 保存した検索の編集（search-edit.tsx）
- URL：`/tags/searches/edit?id=<検索ID>`。FeatureGate（saved_searches）は入口の page.tsx のまま。
- 呼ぶ口・動きは今の画面と同じ：`savedSearches.detail`・`list`・`tags.list`・`supportMarks.list`・`scenarios.list`・`friendFields.list`・`forms.list`・`operators.list`・`preview`（数え直す・世代で古い応答を捨てる）・`update`（`expectedRevision`）・`create`（複製）・`delete`（`canDelete` のときだけ）。未保存で離れるときは確かめる。
- 画面：頭（戻る・条件名・「N人が当てはまる・共有・使っている所」）。左に 名前と共有（条件名・説明・共有＝全員／自分だけの切り替え。上限と共有の説明は「？」）→ 条件（最初／かつ／または・種類140・比べ方120・値・×）→ 友だち一覧での見せ方（並び順・表示件数）→ 分類の使い分け。右に 当てはまる人（数・数えた時刻・数え直す・当てはまる人を見る）→ 使っている所（一斉配信・自動処理は常に）と案内の帯。
- 下の帯：削除する（左・使っている所があると押せない＋理由）・キャンセル・複製して保存する・保存する。

- タグ編集で同名の確認が失敗したときは、入力を残したまま確認し直せる。アカウント切替後は以前の候補を使わず、閲覧のみと統括では確認を取得しない。
