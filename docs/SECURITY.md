# vrc_favworld_check セキュリティ・プライバシー設計

## 1. セキュリティ目標

本製品の最優先事項は、利用者の VRChat 資格情報と既存セッションを製品の管理対象にしないことである。次を必須のセキュリティ目標とする。

1. 利用者のユーザー名、パスワード、2FA コード、Cookie 値、auth token、session data を要求、読出し、保存、表示、送信しない。
2. VRChat API への通信は利用者のブラウザ、端末、IP から直接行い、開発者サーバーを経由しない。
3. 履歴を利用者のブラウザ内に閉じ、利用者が明示的にエクスポートした場合だけファイルとして外へ出す。
4. 不正または不完全な API 応答で履歴を壊したり、ワールドを誤って「削除済み」と断定したりしない。
5. 拡張機能が侵害された場合の影響を、最小権限、読み取り専用 API、リモートコード禁止によって抑える。
6. VRChat Creator Guidelines の API 利用条件を守り、利用者アカウントと VRChat API に過剰な負荷を与えない。

基準となる VRChat 公式文書は [VRChat Creator Guidelines](https://hello.vrchat.com/creator-guidelines) である。API は公式公開仕様ではないため、実装上の endpoint 情報は同 Guidelines から案内されている [VRChat.community](https://vrchat.community/) をリスク承知で参照する。

## 2. 保護対象

### 2.1 最重要: 製品が保持してはならない情報

- VRChat パスワードとユーザー名の組合せ
- 2FA コード、recovery code
- `auth` Cookie の名前と値の組合せ
- auth token、session token、Authorization header
- 将来の `/auth/user` 仕様変更で追加され得る認証関連フィールド

これらは「暗号化して保存する」のではなく、そもそも取得経路と保存フィールドを作らない。

### 2.2 製品がローカルに保持する利用者データ

- VRChat user ID と表示名
- お気に入り world ID、現在名、過去名、作者名、お気に入りグループ
- 初回・最終確認時刻、状態変更履歴
- 定期同期と通知の設定

これらは秘密鍵ではないが、利用者の嗜好と行動を推測できる個人データである。テレメトリ、クラッシュ送信、開発者端末、Git、第三者サービスへ送らない。

### 2.3 完全性と可用性

- 過去名と変更履歴が中断や復元失敗で消えないこと。
- 認証切れ、429、API 障害をワールド状態の変化として記録しないこと。
- API への不適切な連打により利用者が制限・モデレーションを受けないこと。

## 3. 信頼境界とデータフロー

```text
[信頼しない入力]
 VRChat API JSON ─────┐
 バックアップ JSON ──┼─> schema/length/ID validation ─> domain model
 UI操作 ─────────────┘                                  │
                                                         ▼
                                              IndexedDB transaction

[認証境界]
 VRChat公式Web ── ブラウザが管理するCookie ── HTTPS request
                         ▲                    （拡張は値を見ない）
                         └── credentials: include
```

信頼するものは、配布パッケージに同梱されたコード、Chrome / Edge の拡張分離機構、IndexedDB の transaction、HTTPS 証明書検証である。VRChat API の内容、ワールド名、作者名、インポートファイル、時計、ネットワークは検証なしに信頼しない。

## 4. 脅威モデル

| 脅威 | 想定経路 | 対策 | 残余リスク |
| --- | --- | --- | --- |
| 資格情報の窃取 | 偽ログイン UI、入力欄、Cookie API | ログイン UI を作らない。`cookies` 権限なし。公式サイトを固定 HTTPS URL で開く | 端末またはブラウザ自体が侵害された場合は防げない |
| 将来の token field 追加 | `/auth/user` schema / 実応答の変更 | 現行 `CurrentUser` に credential field がないことをリリースゲートで確認。禁止 field 名を検出したら fail closed。`id` と `displayName` だけを新 object へコピーし raw object を即時破棄 | JavaScript heap 上には parse 中の一時値が存在する |
| セッションの外部送信 | 開発者 API、分析 SDK、クラッシュ収集 | VRChat 以外のネットワーク endpoint を持たない。テレメトリなし | 悪意ある将来更新はストア審査と公開ソースの検証対象 |
| 保存型 XSS | ワールド名・作者名に HTML / script | `textContent` 等の安全な DOM API、CSP、URL allowlist、`innerHTML` 禁止 | ブラウザ実装の未知の脆弱性 |
| 悪意あるバックアップ | 巨大 JSON、prototype pollution、型偽装 | 1 profile に限定し、サイズ・深さ・件数・文字列長・ID・enum・日時を検証して plain data へ再構築 | 極端な入力による一時的メモリ負荷を上限で抑える |
| 履歴破損 | 中断、部分書込み、並行同期 | 単一 flight、revision 検査、1 IndexedDB transaction、復元は対象 user だけ全件成功か全件失敗 | ブラウザプロファイル自体の物理破損 |
| 誤った削除判定 | 一時的ページ欠落、429、404 の曖昧性 | 全ページ完走、2 回連続確認、所属とアクセスの 2 軸、断定しない UI | API が一貫して誤った 200/404 を返す場合 |
| API への過負荷 | 固定周期、個別全件 GET、再試行ループ | bulk API、2 秒間隔、12 時間+jitter、probe 最大20、429 即時停止、飽和 backoff | 非公式 API の未公開制限値は不明 |
| User-Agent の広域書換え | 広すぎる DNR 条件 | extension ID、API host/path、GET、XHR に限定した動的 rule | Chrome の rule matching 仕様変更 |
| 権限の過剰化 | `<all_urls>`、cookies、webRequest | manifest snapshot test と公開レビュー。必要 host を 1 つに固定 | host permission は対象 API 上の全 path への fetch 能力を持つ |
| 依存関係侵害 | npm package の悪意ある更新 | lockfile 固定、最小依存、監査、配布物へリモートコードなし | build 端末・registry の侵害 |
| 通知からの情報漏えい | OS ロック画面にワールド名表示 | 通知本文は既定で「お気に入りワールドに変化があります」と件数だけ。詳細は拡張画面 | OS 通知履歴に製品利用の事実は残り得る |
| バックアップの漏えい | 利用者が JSON を共有・クラウド同期 | エクスポート前に内容と保存先注意を表示。秘密情報は含めない | 嗜好履歴自体は平文なので、ファイル管理は利用者責任 |

## 5. 認証設計

### 5.1 許可するフロー

1. 利用者が拡張画面の「VRChat 公式サイトを開く」を押す。
2. 拡張は固定 URL `https://vrchat.com/home/login` を通常タブで開く。
3. 利用者は VRChat が提供する画面でログインと 2FA を完了する。
4. 拡張の Service Worker が `https://api.vrchat.cloud/api/1/auth/user` を `credentials: "include"`、`redirect: "manual"` で GET する。
5. ブラウザは対象 host の Cookie をネットワーク層で処理する。拡張は Cookie API を呼ばない。
6. 現行 `CurrentUser` 仕様に credential、token、Cookie、session data の field がないことを前提に、応答を `unknown` として禁止 field 名まで検査する。新しい object へ `id` と `displayName` だけをコピーし、未知 field の値を抽出せず raw 応答を直ちに破棄する。

Chrome の host permission 付き拡張要求における Cookie / SameSite の挙動は、[Storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) に従う。拡張は `document.cookie` も `chrome.cookies` も使用しない。

### 5.2 禁止するフロー

- Basic 認証、OAuth を模した独自 token exchange
- ユーザー名、パスワード、2FA、recovery code の入力欄
- auth Cookie / token のコピー、export、暗号化保存
- WebSocket URL の query へ auth token を埋め込むこと
- iframe や WebView に公式ログイン画面を埋め込むこと
- ログイン状態を保つ目的で Cookie を更新・延命すること
- ログアウト endpoint を呼ぶこと

### 5.3 認証失敗

401 または認証失敗と判定できる 403 では、raw error を表示せず `AUTH_REQUIRED` へ変換する。自動でログインを試さず、既存 DB を変更せず、公式サイトを開く操作だけを提示する。

別の VRChat user ID が返った場合、以前の user の DB と混ぜない。利用者に「別の VRChat アカウントでログインしています」と表示し、別 profile として初回同期する。表示名だけで同一人物と判断しない。

## 6. 最小権限

### 6.1 使用する権限

| 権限 | 必要性 | 制限 |
| --- | --- | --- |
| `alarms` | Service Worker の定期同期と backoff 再開 | 1 回限り alarm、固定時刻なし |
| `notifications` | 確定変化の OS 通知 | generic な本文、利用者が無効化可能 |
| `unlimitedStorage` | 履歴 IndexedDB の永続性 | IndexedDB を quota 制限と storage pressure による eviction から保護 |
| `declarativeNetRequestWithHostAccess` | VRChat 指定形式の User-Agent | 動的 rule 1 件、extension initiator + API GET XHR のみ |
| `https://api.vrchat.cloud/*` | API への cross-origin GET | API adapter で `/api/1/` と GET を再制限 |

IndexedDB の API 利用自体に `storage` 権限は不要だが、Chrome 公式文書では `unlimitedStorage` が IndexedDB を quota 制限と eviction から除外する。消失後に再取得できない名称履歴を守るため、本製品では必須権限とする。これは端末故障、拡張削除、ブラウザプロファイル破損のバックアップ代替にはならない。

### 6.2 使用しない権限

- `cookies`: Cookie 値へのアクセスを不要にする。
- `webRequest` / `webRequestBlocking`: 通信の広域監視をしない。MV3 の限定 DNR rule を使う。
- `tabs`: タブ URL や閲覧履歴を読む必要がない。
- `history`, `downloads`, `clipboardRead`, `clipboardWrite`: 本機能に不要。
- `scripting`, `activeTab`, content scripts: VRChat ページへコードを注入しない。
- `<all_urls>` または wildcard host: VRChat API 以外を読む必要がない。

## 7. User-Agent 付与の安全性

VRChat Creator Guidelines は `applicationName/Version contactInfo` 形式の User-Agent を要求する。一方、Web `fetch` では User-Agent を直接設定できないため、[chrome.declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest) の `modifyHeaders` を使う。

安全条件はすべて満たす必要がある。

- rule は hard-code せず、`chrome.runtime.id` と manifest version を取得して install / startup 時に生成する。
- `initiatorDomains` は現在の `chrome.runtime.id` だけとする。
- URL prefix は `|https://api.vrchat.cloud/api/1/`、request domain は `api.vrchat.cloud` だけとする。
- resource type は `xmlhttprequest`、method は `get` だけとする。
- value は `vrc_favworld_check/<version> https://github.com/Na2ki-BB/vrc_favworld_check` とし、利用者のメールアドレスや ID を入れない。
- 登録後に `getDynamicRules()` で完全一致を確認する。登録・検証に失敗した場合は API 同期を fail closed（送信せず失敗）とする。
- 本製品の予約 rule ID だけを置換し、他の rule ID を一括削除しない。

## 8. ネットワーク防御

### 8.1 送信制限

- HTTPS 以外を拒否する。
- URL は文字列連結ではなく固定 base URL と検証済み world ID から構築する。
- world ID は `^wrld_[0-9a-fA-F-]{36}$` 相当の UUID 形式を満たすものだけ path に入れる。
- すべての fetch を `redirect: "manual"` に固定する。3xx / opaque redirect は origin にかかわらず追従せず、同期を失敗させる。
- method は GET に固定し、request body を送らない。
- API が返した URL を自動 fetch しない。
- WebSocket、画像 CDN、分析 endpoint へ接続しない。

### 8.2 レート制限

- 通常データは bulk endpoint と IndexedDB cache を使う。
- 要求を並列化せず、開始間隔を 2 秒以上空ける。
- 個別 probe は 1 同期最大 20 件。
- 定期同期は 12 時間 + 0〜60 分 jitter。起動直後も 1〜10 分 jitter。
- 手動同期は 5 分 cooldown、実行中は単一 flight を共有する。
- 429 では同期全体を即時停止し、同じ同期内で再試行しない。`consecutiveRateLimits` を飽和増加させ、妥当な `Retry-After` と指数 delay の遅い方から `backoffUntil` を保存する。
- `backoffUntil` 後は認証確認から新しい完全同期を開始する。完全同期成功時だけ連続 429 カウンターをリセットする。
- 5xx / network error だけ短い jitter 付きで最大 2 回再試行し、上限後は既存ワールド状態を変えず停止する。
- 自動同期が有効なら、同期のアプリケーション制御下にある全終了経路の `finally` で固定名の one-shot alarm を置換する。成功は 12 時間 + 0〜60 分 jitter、429 は `backoffUntil`、offline / 5xx 上限後は 30〜60 分後、401 / schema 不正 / その他は 12 時間 + 0〜60 分 jitter とする。無効なら既存 alarm を解除する。
- ブラウザ強制終了で `finally` を実行できなかった場合に備え、install / startup 時は永続化した `nextSyncAt` と alarm の有無を照合して欠けた 1 件を修復する。保存時刻が過去なら現在から 1〜10 分 jitter 後とする。複数 alarm による要求増幅を避けるため、既存の同名 alarm は必ず置換する。

## 9. 入力検証と表示

### 9.1 API 応答

- HTTP status と Content-Type を先に検査する。
- JSON parse は応答サイズ上限内で行う。
- redirect response を JSON として parse しない。
- 配列要素は `unknown` から必要 DTO へ 1 件ずつ検証する。
- `id`、`favoriteId` の prefix と UUID 形式を検査する。
- 名前と作者名は制御文字を除外し、表示・保存長を合理的な上限にする。ただし空白や Unicode 名を不必要に破壊しない。
- 未知フィールドは無視する。必須フィールド欠落は page 全体を不正として同期を中止する。
- 現行 OpenAPI `CurrentUser` に credential / token / session field がないことを release ごとに schema test する。実応答に禁止 field 名があれば値を抽出せず fail closed にする。
- `/auth/user` raw object、未知 field、error body、header map を汎用 logger に渡さない。

### 9.2 DOM

- API / DB / backup 由来の文字列に `innerHTML`、`outerHTML`、`insertAdjacentHTML` を使用しない。
- 文字列は `textContent`、属性は型別の安全な setter を使う。
- 外部リンクはコードに固定した `https://vrchat.com/` と GitHub repository だけとする。
- `target="_blank"` の Web link には `rel="noopener noreferrer"` を付ける。
- inline script、inline event handler、`eval`、`new Function`、リモート script を禁止する。
- extension CSP は既定より緩めない。

### 9.3 バックアップ

復元入力の初期上限は、ファイル 25 MiB、profile ちょうど 1 件、worlds 10,000、events 100,000、文字列 4,096 code points、配列 nesting 4 とする。製品の実測により縮小できるが、無制限にしない。

- `__proto__` 等を特別扱いする merge を行わず、schema field を新規 object へコピーする。
- enum 外、非有限数、無効日時、重複 key、存在しない world への event を拒否する。
- HTML や JavaScript として解釈しない。
- 全検証完了前に IndexedDB を変更しない。
- 復元 transaction は対象 `userId` の profile/worlds/events だけを key range で置換し、他 user の record を削除しない。global settings は allowlist 済み preferences だけを同じ transaction で merge する。
- event の `notificationClaimedAt`、`notifiedAt`、固定 enum の `notificationError` を検証して復元し、未 claim の import event には `notificationClaimedAt = restoredAt` を設定して再通知しない。
- 復元 transaction が失敗した場合は対象 user、他 user、settings の処理前状態を保持する。

## 10. 保存とプライバシー

### 10.1 IndexedDB

Chrome 拡張の IndexedDB はブラウザプロファイル内に保存されるが、アプリケーションレベルで暗号化されない。暗号化パスワードを利用者に管理させることは、初心者向け要件と復旧性に反するため MVP では採用しない。

`unlimitedStorage` により quota と自動 eviction から保護するが、利用者による拡張削除、ブラウザプロファイル削除、端末故障は防げない。1 profile 単位の JSON バックアップを併用する。

端末を共有する場合は OS アカウント分離、画面ロック、ディスク暗号化を推奨する。ローカル管理者、端末 malware、ブラウザプロファイルを直接読める攻撃者からの保護は本製品単独では保証できない。

### 10.2 ログ

永続 `syncRuns` に保存できるのは固定 result code、開始・終了時刻、件数、再試行予定だけである。次を禁止する。

- request / response header
- URL query 全体
- Cookie、Authorization、token に見える値
- API response body
- `/auth/user` の raw object
- 利用者入力 JSON の raw dump
- stack trace の永続化または外部送信

開発 build の console log も同じ制限を受ける。秘密パターンの redact に依存して raw data を先に logger へ渡してはならない。

### 10.3 通知

OS 通知はロック画面へ表示され得るため、既定本文にワールド名と VRChat 表示名を入れない。「お気に入りワールドに 3 件の変化があります」のように件数だけを表示し、詳細は拡張画面を開いて確認する。

通知 API の attempt は event ごとに最大 1 回とする。呼出し前に `notificationClaimedAt` を transaction で確定し、成功、明示的失敗、crash のいずれでも解除しない。成功時は `notifiedAt`、明示的失敗時は応答本文や stack trace ではなく固定 `notificationError` だけを保存する。通知が欠落しても再 attempt せず、ローカル履歴を正本として常に確認可能にする。

## 11. ビルドと供給網

- package manager の lockfile を commit し、CI とローカルで frozen lockfile install を使う。
- runtime dependency は必要最小限にし、依存追加時はライセンス、maintainer、install script、既知脆弱性を確認する。
- postinstall script を必要なく許可しない。
- Manifest V3 のリモートコード禁止に従い、配布物の JavaScript / CSS / font / image を自己完結させる。
- source map にローカル絶対 path、環境変数、秘密を含めない。公開配布物に不要なら含めない。
- 配布 ZIP 作成前に `.env`、Cookie、token、実利用者 DB、ログ、テスト fixture の実データ、大容量生成物を検査する。
- 公開 repository の CI secret は製品 runtime へ埋め込まない。

## 12. セキュリティ検証

リリース前に少なくとも次を自動または手動で確認する。

1. manifest snapshot に `cookies`、`webRequest`、`<all_urls>`、不要 host がなく、`unlimitedStorage` がある。
2. DNR rule の host、path、initiator、resource type、method、User-Agent 形式が完全一致する。
3. DNR 登録失敗時に fetch が呼ばれない。
4. 最新 OpenAPI `CurrentUser` schema に credential、token、Cookie、session data の field がない。禁止 field を加えた `/auth/user` fixture では同期が fail closed し、IndexedDB、backup、log に値が残らない。
5. `<img onerror=...>`、`<script>`、双方向 Unicode を含む world 名を表示しても code execution されない。
6. 25 MiB 超、複数 profile、深い object、`__proto__`、重複 ID、壊れた参照の backup を拒否し、全 profile の旧 DB が残る。正常な復元では対象 user だけが置換される。
7. 401、429、5xx、timeout、schema 不正で state transition が生じない。
8. 429 後は同じ同期で要求せず、永続化した `backoffUntil` より前に新しい同期を開始しない。連続 429 で指数 delay と counter が上限に飽和する。
9. `redirect: "manual"` により 3xx を追従せず、初期 URL 以外へ request を送らない。
10. claim commit 後の crash または通知 API の明示的失敗を注入しても claim を解除せず、同じ event の通知 attempt が Service Worker 再起動後に増えない。明示的失敗では固定 `notificationError` が残り、いずれも履歴が表示できる。
11. 自動同期を有効にした成功、429、offline、5xx 上限、401、schema 不正、その他の各終了 fixture で、既存の名前付き alarm が正しい次回時刻の 1 件へ置換される。自動同期無効時は alarm が残らない。
12. ビルド成果物と Git 差分を秘密情報パターンで検査する。
13. 配布物のコードから許可 host 以外の `http://` / `https://` / `ws://` / `wss://` 文字列を列挙し、用途をレビューする。

## 13. 残余リスクと対応

- **非公式 API**: endpoint、schema、認証 Cookie の挙動は予告なく変わり得る。不明な応答は fail closed とし、ワールド状態を更新せず、拡張更新を案内する。
- **404 の曖昧性**: 削除と非公開を区別できない。「現在アクセスできません」とだけ表示し、HTTP 404 と観測時刻を履歴根拠に残す。
- **Cookie 制限設定**: ブラウザまたは企業ポリシーが第三者 Cookie を制限すると既存セッションを利用できない場合がある。制限を勝手に変更せず、公式サイト再ログインとブラウザ設定確認を案内する。
- **ローカル平文データ**: 同一 OS アカウントの攻撃者からは保護できない。秘密情報は保存せず、嗜好履歴については OS の保護に依存する。
- **OS 通知は exactly-once ではない**: 本製品は通知前の永久 claim による厳密な at-most-once を選ぶ。claim 後 crash の曖昧な窓や通知 API の明示的失敗では通知が欠落し得るが、結果にかかわらず再 attempt して重複させず、履歴を正本とする。固定 `notificationError` は診断表示用であり再試行条件ではない。
- **CurrentUser 仕様変更**: 現行 schema に credential / token / session field がないことが実装成立条件である。将来追加された場合は allowlist で値を捨てるだけで継続せず、同期を fail closed にして認証設計を再評価する。
- **API 利用方針の変更**: Creator Guidelines をリリースごとに再確認する。利用禁止または安全な認証が成立しなくなった場合は API 同期を停止する更新を優先する。
