> 文書：二段階認証を付ける手順｜区分：今の説明｜最終確認：2026-11-16（日本時間）

# 二段階認証を付ける手順

対象：オーナー（ケンタさん）とマサトさん。2026-10-16に公式案内を確認。**2人がそれぞれ自分のアカウントで設定する**。パスワードや認証アプリのQRコードを共有して、1つのアカウントを2人で使わない。

二段階認証は、パスワードが知られても、もう1つの確認なしでは入れなくする仕組み。回復コードは、スマートフォンをなくしたときの予備の鍵。APIキーや暗号化鍵とは別物なので、回復コードをWorkerのsecretへ入れない。

## 始める前に

1. 自分のスマートフォンの画面ロック・OS更新を確認し、認証アプリまたは対応するパスキー／セキュリティキーを用意する。
2. 個人の回復コードを保管する鍵付きの場所を決める。仕事用の保管庫を使う場合も、自分のログインを失っても取り出せる経路を確保する。
3. メールが復旧の入口になるため、Googleと回復用メールを先に守る。その後GitHub・Cloudflareなどを1サービスずつ進める。
4. 今入っている画面は残し、別のブラウザのプライベート画面で新しい方法のログインを確かめる。確かめる前に全端末からログアウトしない。

## サービスごとの操作

画面名が変わっていたら下の公式リンクから確認する。設定が見つからない場合は「設定済み」とせず、サービス名だけ担当者に伝える。設定中の画面・コードの写しを送らない。

### Google（Gmail・Google Cloud・Calendarを使う本人）

1. Googleアカウント →「セキュリティとログイン」→「Googleにログインする方法」→「2段階認証プロセス」を開く。
2. 画面に従って有効にし、認証アプリ・パスキー・セキュリティキーなど自分が使える方法を登録する。予備の方法も用意する。
3. 2段階認証の「バックアップコード」から取得して保管する。会社管理のアカウントで操作できなければ管理者に確認する。
4. 別画面でログインを確かめる。Google Cloudのプロジェクト権限と、Calendarの共有権限は別に確認する。

[Google公式の設定手順](https://support.google.com/accounts/answer/185839?hl=ja)、[バックアップコード](https://support.google.com/accounts/answer/1187538?hl=ja)。

### GitHub

1. プロフィール → Settings → Password and authentication → Two-factor authenticationを開く。
2. Enable two-factor authenticationから認証アプリで登録し、表示された番号で確認する。
3. Recovery codesを保管する。対応するパスキーや別のセキュリティキーも追加し、予備の方法を確保する。
4. 別画面でログインを確かめる。リポジトリのメンバー権限は別の設定なので、下の権限表と照合する。

[GitHub公式の設定手順](https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/configuring-two-factor-authentication)、[回復方法](https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/configuring-two-factor-authentication-recovery-methods)。

### Cloudflare

1. 先に登録メールが確認済みであることを確かめる。
2. My Profile → Authentication → Mobile App AuthenticationまたはSecurity Key AuthenticationのAddから登録する。
3. バックアップコードを保管し、予備の認証方法を追加する。自分の登録とログインを確かめてから、管理者がチーム全体の必須化を検討する。
4. Workers・D1・Pages・DNSにどこまで入れるかを、アカウントのメンバー画面で照合する。

[Cloudflare公式の設定手順](https://developers.cloudflare.com/fundamentals/user-profiles/2fa/)。

### LINE Developers（ビジネスID）

1. LINE Developersへ入るときの方法を確認する。ビジネスアカウント（メールアドレス）とLINEアカウントによるログインを混同しない。
2. ビジネスアカウントはビジネスIDのプロフィール →「2段階認証」の鉛筆 →「認証アプリ」を有効にし、画面の番号で確認する。既にオンでも自分の方式を確かめる。
3. 表示されるバックアップコードを保管し、利用できる予備の方法を設定する。LINEアカウントで入る人は公式ヘルプのLINEアカウント向け案内を確認し、ビジネスアカウントの設定だけで完了にしない。
4. 別画面で自分のログインを確かめる。プロバイダー・各チャネルのRolesと、LINE Official Account Managerの権限は別々に照合する。

[ビジネスID公式ヘルプ](https://help2.line.me/business_id/web/pc?lang=ja)、[二段階認証の案内](https://www.lycbiz.com/jp/news/20260317/)。

### Stripe

1. Stripe DashboardのPersonal details（個人設定）→ Two-step authentication → Add authentication methodを開く。
2. 対応するパスキー・セキュリティキー・認証アプリから登録する。予備として2つ目の方法を追加する。
3. 初回に表示されるバックアップコードをその場で保管する。失ったり漏れた疑いがあれば、入れる間に再発行する。
4. 別画面でログインを確かめる。チーム管理者はTeam settingsの必須化とメンバー権限を確認する。本番とsandboxの選択も照合する。

[Stripe公式の設定手順](https://support.stripe.com/questions/how-do-i-enable-two-step-verification)、[バックアップコードの保管](https://support.stripe.com/questions/backup-codes-for-two-step-authentication)。

### Slack

1. 対象ワークスペースの自分のAccount settingsを開く（`my.slack.com/account/settings`）。
2. Two-factor Authentication → Expand → Set Up Two-Factor Authentication → 認証アプリを選び、QRコードを登録して番号を確認する。
3. バックアップコードを保管し、別画面でログインを確かめる。複数のワークスペースはそれぞれ確認する。
4. SSO（Googleなどを通じたログイン）で管理されている場合は、ログイン元の二段階認証と、SSOを経由せず入れる管理者の経路も確認する。

[Slack公式の設定手順](https://slack.com/help/articles/204509068-Set-up-two-factor-authentication)。

### 独自ドメインの管理

1. 契約・請求画面から「ドメインの登録会社」と「DNSの管理会社」を確認する。DNSがCloudflareでも登録会社は別の場合がある。
2. それぞれに自分のアカウントで入り、Security／セキュリティ設定から二段階認証を登録する。Cloudflare Registrarなら上のCloudflare手順、別会社ならその会社の公式手順に従う。
3. 回復コードまたは会社が指定する復旧手段を保管する。管理する会社が未確認のため、特定会社の画面名や回復コードの有無はここで断定しない。
4. ドメインの更新期限・自動更新・連絡用メール・移管ロックも確認する。マサトさんの作業権限は個別招待を使い、オーナーのパスワードを渡さない。

## musubo自身の二段階認証の鍵（TOTP_ENCRYPTION_KEY）

管理画面に入る人の認証アプリの秘密は、`TOTP_ENCRYPTION_KEY` という鍵で暗号にしてDBへ保存します（`apps/worker/src/lib/totp.ts`、`apps/worker/src/lib/mfa-config.ts`）。この鍵は検証と本番で別々に登録し、値はオーナーが入れます。

1. Cloudflareのダッシュボード → Workers & Pages → 対象のWorker（検証は `nen-line-stg`、本番は `nen-line`）→ Settings → Variables and Secrets を開く。
2. `TOTP_ENCRYPTION_KEY` という名前のsecretが「あるかないか」だけ確かめる。値の中身は開かない・写さない・貼らない。
3. 無い環境には、安全な端末で作った32文字以上の値をsecretとして登録する（通常の変数には入れない）。検証と本番で同じ値は使い回さない。
4. **すでにある鍵は上書きしない。** 変えると登録済みの認証アプリの秘密が読めなくなり、登録済みの人が入れなくなるおそれがある。変える必要が出たら司令塔と再登録の計画を立ててから行う。
5. 鍵が無いまま管理画面で二段階認証の必須化をオンにしようとすると、管理画面側が断る仕組みになっている（担当者が運用状態の応答で有無だけ確認でき、値は出ない）。鍵の登録が先、必須化は後。

## 回復コードの保管

- 原本は封筒などに入れて施錠し、スマートフォン・普段のPCと一緒に持ち歩かない。予備の認証端末／セキュリティキーも別の安全な場所に置く。
- パスワード管理ソフトを使う場合は秘密として保護された欄へ入れる。Stripeは紙などを施錠して保管する方法を優先して案内している。通常の共有メモやクラウドの共有フォルダへ置かない。
- 回復コード、QRコード、初期登録の手入力用の鍵をGit・Issue・PR・Slack・メール本文・この文書へ貼らない。保管のための画面共有や撮影もしない。
- 同じ認証先へ入れないと保管庫も開けない、という循環を避ける。持ち主本人が、スマートフォンなしで保管物を取り出せるか確認する。
- 使ったコードは使用済みにし、再発行したら古い控えを差し替える。個数や再発行の効き方はサービスごとの案内で確認する。コードの内容を相手に見せて確認してもらわない。
- 退職・権限変更・端末紛失時は、個別の招待とセッションを整理する。仕事の復旧はマサトさん自身の権限で行い、個人の回復コードを共有して代用しない。

## 誰に何の権限があるか

**GitHubのマサトさん以外は、実際のサービス側の権限は未確認。** Memoryにある「オーナー／共同開発者」は仕事上の役割で、全サービスの管理者権限を示すものではない。下の表は確認を埋めるための台帳。未確認を推測で管理者にしない。

| サービス | ケンタさんの現在の役割 | マサトさんの現在の役割 | 確認する画面 |
| --- | --- | --- | --- |
| この仕事 | オーナー（記録あり） | 共同開発者（記録あり） | `docs/brain/Memory.md` |
| musubo | 未確認 | 未確認 | ユーザー管理・運営権限。統括・店の所属、閲覧のみ、代理ログインも区別 |
| GitHub | 未確認（照会できず） | 管理者（対象リポジトリのみ、APIで確認） | Repository SettingsのCollaborators／アクセス管理 |
| Cloudflare | 未確認 | 未確認 | アカウントのMembersと役割の対象範囲 |
| Google Cloud | 未確認 | 未確認 | 対象プロジェクトのIAM |
| Google Calendar | 未確認 | 未確認 | カレンダー設定の共有権限 |
| LINE Developers | 未確認 | 未確認 | プロバイダーとチャネルそれぞれのRoles |
| LINE公式アカウント | 未確認 | 未確認 | Official Account Managerの権限管理 |
| Stripe | 未確認 | 未確認 | Teamの役割と本番／sandboxのアクセス |
| Slack | 未確認 | 未確認 | Manage membersのオーナー・管理者・メンバー |
| ドメイン登録会社 | 未確認 | 未確認 | 契約者・委任された管理権限 |
| DNS管理会社 | 未確認 | 未確認 | メンバーとドメインごとの権限 |

GitHubの確認日：2026-10-16。対象リポジトリのcollaborator permission APIでマサトさんのadminを確認した。ケンタさんは照会できず、権限なしとは判断していない。この確認はGitHub全体の権限や二段階認証の有無を示さない。

確認後は「オーナー」「管理者」「開発者」「閲覧のみ」「権限なし」など、画面にある役割名だけに置き換える。メールアドレス、個人のアカウントID、電話番号、請求情報は記録しない。確認日は表の下へ追記する。

必要な権限の決め方：ケンタさんは契約と公開判断、マサトさんは本番復旧・承認を担えるかを確認する。操作が不要なサービスへ一律に管理者を付けない。少なくとも、一方の端末がなくても、もう一方の正式な権限と保管した手順で仕事を引き継げるか確認する。

## 終わったかの確認（2人それぞれ）

| サービス | ケンタさん：有効・再ログイン・回復手段 | マサトさん：有効・再ログイン・回復手段 |
| --- | --- | --- |
| Google | 未確認 | 未確認 |
| GitHub | 未確認 | 未確認 |
| Cloudflare | 未確認 | 未確認 |
| LINE Developers | 未確認 | 未確認 |
| Stripe | 未確認 | 未確認 |
| Slack | 未確認 | 未確認 |
| ドメイン登録・DNS | 未確認 | 未確認 |

権限がないサービスは「権限なし・設定対象外」とし、そのサービスを復旧する担当が誰かを権限表で確認する。musubo自身の二段階認証は[点検表S09](SECURITY-CHECKLIST.md)でも担当者と確認する。完了の共有は「サービス・名前・設定済み・確認日」だけでよい。
