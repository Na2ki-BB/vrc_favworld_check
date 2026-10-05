# vrc_favworld_check セキュリティ・プライバシー設計

> この文書は開発者向けです。利用者向けの説明は[プライバシー方針](PRIVACY.md)を参照してください。

## 1. セキュリティ目標

本製品の最優先事項は、利用者のVRChat資格情報を入力・永続保存させず、VRChat公式通信以外へ送信しないことである。既存セッションの利用範囲は、同期中の固定APIへ限定する。次を必須のセキュリティ目標とする。

1. 利用者のユーザー名、パスワード、2FAコードを要求・読出し・保存しない。Cookie値は固定名2つを同期中だけ読み取り、拡張のDB、設定、ファイル、ログ、UI、通知、backup、開発者端末へ保存・表示・送信しない。
2. VRChat API への通信は利用者のブラウザ、端末、IP から直接行い、開発者サーバーを経由しない。
3. 履歴を利用者のブラウザ内に閉じ、利用者が明示的にエクスポートした場合だけファイルとして外へ出す。
4. 不正または不完全な API 応答で履歴を壊したり、ワールドを誤って「削除済み」と断定したりしない。
5. 拡張機能が侵害された場合の影響を、最小権限、読み取り専用 API、リモートコード禁止によって抑える。
6. VRChat Creator Guidelines の API 利用条件を守り、利用者アカウントと VRChat API に過剰な負荷を与えない。

基準となる VRChat 公式文書は [VRChat Creator Guidelines](https://hello.vrchat.com/creator-guidelines) である。API は公式公開仕様ではないため、実装上の endpoint 情報は同 Guidelines から案内されている [VRChat.community](https://vrchat.community/) をリスク承知で参照する。

## 2. 保護対象

### 2.1 最重要: 永続保持またはVRChat API以外へ送信してはならない情報

- VRChat パスワードとユーザー名の組合せ
- 2FA コード、recovery code
- `auth` Cookie の名前と値の組合せ
- auth token、session token、Authorization header
- 将来の `/auth/user` 仕様変更で追加され得る認証関連フィールド

これらの保存フィールド、export、ログ経路は作らない。`auth` と任意の `twoFactorAuth` だけは、公式WebセッションをAPIへ橋渡しする関数ローカル値および期限付き一時Cookieとして扱い、同期終了時と復旧時に削除する。

### 2.2 製品がローカルに保持する利用者データ

- VRChat user ID と表示名
- お気に入り world ID、現在名、過去名、作者名、お気に入りリストの内部名・表示名・表示名履歴
- 最大辺320px・1件48KiB以下へ縮小したワールドサムネイルと、そのVRChat API上の取得元URL
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
 VRChat公式Web ─ ブラウザ管理Cookie ─ Auth Cookie Bridge ─ API用一時Cookie
                                      │ 固定名2つだけ      │ 最大15分
                                      └─ 値は保存・表示せず ─ HTTPS GET
```

信頼するものは、配布パッケージに同梱されたコード、Chrome の拡張分離機構、IndexedDB の transaction、HTTPS 証明書検証である。VRChat API の内容、ワールド名、作者名、インポートファイル、時計、ネットワークは検証なしに信頼しない。

## 4. 脅威モデル

| 脅威 | 想定経路 | 対策 | 残余リスク |
| --- | --- | --- | --- |
| 資格情報の窃取 | 偽ログインUI、入力欄、広いCookie列挙・保存 | ログインUIを作らない。Cookie Bridgeを固定2名称・固定3host・短時間・非永続経路へ限定し、root hostは親domain競合検査だけに使い、値を呼出し元やloggerへ返さない | 拡張コード、端末、ブラウザ自体が侵害された場合、`cookies`権限によりVRChatセッションを盗まれ得る |
| API側Cookieの衝突 | 既存APIセッションの上書き・誤削除 | root host permissionを含め、targetへ送信され得る固定名Cookieを親domain・全pathまで検査し、非秘密の所有マーカーがないものは上書きも削除もしない。削除直前にも値・属性を再確認し、partitioned Cookieも取得できた場合はfail closed | Chrome Cookie APIに原子的compare-and-deleteがないため、最終確認と削除の間の小さな競合窓は残る |
| 一時Cookieの残留 | Service Worker・Chromeの強制終了、API応答による更新 | Secure/HttpOnly/SameSite=Strict、path `/api/1/`、設定時最大15分。通常終了は全対象と各削除直前に本処理が設定した値・属性の一致を確認し、中断後は誤削除せず失効を待つ | APIが同名Cookieを長い期限へ更新して直後にChromeが終了した場合は15分を超えて残り得るため、実機で更新不在をrelease gateにする |
| CurrentUserに含まれるcredential-like field | `/auth/user` の `authToken` や将来field | bounded JSONから `id` と `displayName` だけを新objectへコピーし、その他は名前・値・階層を走査せずraw objectごと破棄。戻り値・DB・log・backupをallowlistで固定 | raw値はJSON parse後、GCされるまでJavaScript heap上へ一時的に存在し得る |
| world metadataの非canonical ID | `/worlds/favorites` が従来の `wrld_` + UUID形式でないIDを返す | 実測endpointだけがnullable identityを明示opt-inし、非canonical IDを追加解釈・コピーせずmetadata出力前に除外。raw件数、他必須field、canonical ID重複、非空snapshot全体のcanonical metadata存在を検査する。除外IDは保存、UI、log、API URL、backupへ渡さず、canonicalな関係IDだけを正本にする | 除外行の名称metadataはその同期で利用できない。全件がnoncanonicalならsnapshotを拒否するため、API変更時は同期できない |
| 悪意ある・巨大な画像 | 改変された`thumbnailImageUrl`、画像爆弾、redirect | API originとfile/image pathのallowlist、Cookie・Refererなし、CSPによるAPI/files以外への転送遮断、最終CDN path検査、5MiB上限、PNG・JPEG・WebP headerのdecode前寸法検査、8192px・1600万画素上限、decode後再検査、WebP再encode、48KiB出力上限。画面は保存済みBlobだけを読む | 対応外形式や一時障害では画像が保存されないが、名前・状態の同期は維持する |
| セッションの外部送信 | 開発者 API、分析 SDK、クラッシュ収集 | VRChat 以外のネットワーク endpoint を持たない。テレメトリ、自動更新、実行時ダウンロードなし | 悪意ある配布物を利用者が手動実行した場合は防げない |
| 保存型 XSS | ワールド名・作者名に HTML / script | `textContent` 等の安全な DOM API、CSP、URL allowlist、`innerHTML` 禁止 | ブラウザ実装の未知の脆弱性 |
| 悪意あるバックアップ | 巨大 JSON、prototype pollution、型偽装 | 1 profile に限定し、サイズ・深さ・件数・文字列長・ID・enum・日時を検証して plain data へ再構築 | 極端な入力による一時的メモリ負荷を上限で抑える |
| 履歴破損 | 中断、部分書込み、並行同期 | 単一 flight、revision 検査、1 IndexedDB transaction、復元は対象 user だけ全件成功か全件失敗 | ブラウザプロファイル自体の物理破損 |
| 誤った削除判定 | 一時的ページ欠落、429、404 の曖昧性 | 全ページ完走、2 回連続確認、所属とアクセスの 2 軸、断定しない UI | API が一貫して誤った 200/404 を返す場合 |
| API への過負荷 | 固定周期、個別全件 GET、再試行ループ | bulk API、2 秒間隔、12 時間+jitter、probe 最大20、429 即時停止、飽和 backoff | 非公式 API の未公開制限値は不明 |
| User-Agent の広域書換え | 広すぎる DNR 条件 | extension ID、API host/path、GET、XHR に限定した動的 rule | Chrome の rule matching 仕様変更 |
| 権限の過剰化 | `<all_urls>`、広いcookies利用、webRequest | manifest snapshot testと公開レビュー。必要hostを `vrchat.com` / `vrchat.cloud` / `api.vrchat.cloud` に固定し、rootは親domain競合検査だけ、Cookie API使用箇所・名前・URLも静的検査 | `cookies` とhost permissionは侵害時に対象hostのCookieへ広くアクセスできるため、コード境界だけではChromeの権限自体を狭められない |
| 依存関係侵害 | npm package の悪意ある更新 | lockfile 固定、最小依存、監査、配布物へリモートコードなし | build 端末・registry の侵害 |
| 通知からの情報漏えい | OS ロック画面にワールド名表示 | 通知本文は件数と固定分類だけ。要確認時も名称は出さず、詳細は拡張画面 | OS 通知履歴に製品利用の事実は残り得る |
| バックアップの漏えい | 利用者が JSON を共有・クラウド同期 | エクスポート前に内容と保存先注意を表示。秘密情報は含めない | 嗜好履歴自体は平文なので、ファイル管理は利用者責任 |
| グループAPIの部分破損 | owner不一致、重複ID、未知type、空応答 | 全要素を検証し、異常時は既存対応表を保持。主要ワールド同期と失敗境界を分離 | 前回名または内部名表示になる |
| 消去前のアンインストール | IndexedDB transactionの失敗・中断、Windows側だけの削除 | 永続purge gate、alarm停止、全storeの原子的clear成功後だけ自己アンインストールし、その後にWindows側を削除するよう案内 | Windows側はChrome内の削除完了を判定せず、書き出し済みJSONとブラウザ内DBは自動削除しない |
| 未署名インストーラーの改ざん | 配布途中の実行ファイル差替え | ビルド時の内容検査、配布時のファイル名・バージョン表示、任意のSHA-256照合、公開ソースのレビュー | コード署名による発行者確認はなく、配布場所自体の侵害とSmartScreen警告は残る |
| 更新中の配置失敗 | 部分展開、file move失敗 | `extension.new`で先に検証し、現行版を`extension.old`へ1世代だけ退避、失敗時だけ復元 | 電源断の全状態や複数世代rollbackは扱わない |
| 過剰なアンインストール | 広いwildcard、profile探索 | 削除対象を固定app root内の既知ファイルに限定 | 利用者がapp root外へ手動コピーしたファイルは残る |

## 5. 認証設計

### 5.1 許可するフロー

1. 利用者が拡張画面の「VRChat 公式サイトを開く」を押す。
2. 拡張は固定 URL `https://vrchat.com/home/login` を通常タブで開く。
3. 利用者は VRChat が提供する画面でログインと 2FA を完了する。
4. Service Workerは `https://vrchat.com/api/1/auth/user` に一致する `auth` と任意の `twoFactorAuth` を `chrome.cookies.get` で名前ごとに取得する。Promise版APIの未検出値 `undefined` を認証不足または任意Cookie不在として扱う。VRChatがsourceへSecure属性を付けていなくても、固定HTTPS URLからCookie APIで読むだけとし、値は関数ローカルから外へ返さない。
5. API targetへ送信され得る既存の非partitioned同名Cookieが親domain・pathを問わずないことを検査する。値を含まない所有マーカーを先に作り、source属性を引き継がず、認証Cookieを `api.vrchat.cloud` のhost-only、path `/api/1/`、Secure、HttpOnly、SameSite=Strict、最長15分として一時設定する。
6. 拡張自身のAPI GETだけに一致するUser-Agent用DNR ruleが完全な期待値で登録済みであることを検証する。不成立ならCookie Bridgeもfetchも開始しない。
7. `https://api.vrchat.cloud/api/1/auth/user` を `credentials: "include"`、`redirect: "manual"` でGETする。応答のサイズ・media type・UTF-8・JSON・top-level object・必要2fieldを検査し、新しいobjectへ `id` と `displayName` だけをコピーする。現行仕様の `authToken`、`usesGeneratedPassword` を含むその他のfieldは列挙・再帰走査せずraw応答ごと破棄する。
8. 以後の読み取り専用APIを同じ一時セッションで実行し、成功・API失敗・例外のすべてで本処理が設定した値・属性が一致する一時認証Cookieを先、所有マーカーを最後に削除する。途中終了後は認証Cookieを能動削除せず、失効による不在を確認してから孤立マーカーを削除する。

ChromeのCookie APIとhost permissionは [chrome.cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies) に従う。host permission付き拡張要求のSameSite挙動は [Storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) に従う。`document.cookie`、content script、全Cookie列挙は使用しない。

### 5.2 禁止するフロー

次の方式は、資格情報を拡張へ入力させる、認証値の利用範囲を広げる、または利用者の公式セッションを変更するため、認証境界の外とする。

- Basic 認証、OAuth を模した独自 token exchange
- ユーザー名、パスワード、2FA、recovery code の入力欄
- allowlist外Cookieの読取り・コピー、Cookie値のmessage受渡し、export、ログ、DB・設定・ファイルへの保存
- WebSocket URL の query へ auth token を埋め込むこと
- iframe や WebView に公式ログイン画面を埋め込むこと
- ログイン状態を保つ目的でsource Cookieを更新・延命すること
- ログアウト endpoint を呼ぶこと

### 5.3 認証失敗

401 または認証失敗と判定できる 403 では、raw error を表示せず `AUTH_REQUIRED` へ変換する。自動でログインを試さず、既存 DB を変更せず、公式サイトを開く操作だけを提示する。

source `auth` 欠落（Promise版APIの `undefined` を含む）も `AUTH_REQUIRED` とする。任意の `twoFactorAuth` が `undefined` なら不在として続行する。API側の既存Cookie競合は `AUTH_COOKIE_CONFLICT`、Cookie APIから返るpartitioned・権限・Cookie API・setup失敗は `AUTH_COOKIE_UNAVAILABLE`、終了後の残存は `AUTH_COOKIE_CLEANUP_FAILED` とし、Cookie値やブラウザ例外本文を表示・記録しない。cleanup失敗前に同期commitが完了している場合は履歴と最終成功時刻を正本として保持しつつ、Chromeの完全終了、15分待機、再起動を案内する。

別の VRChat user ID が返った場合、以前の user の DB と混ぜない。利用者に「別の VRChat アカウントでログインしています」と表示し、別 profile として初回同期する。表示名だけで同一人物と判断しない。

## 6. 最小権限

### 6.1 使用する権限

| 権限 | 必要性 | 制限 |
| --- | --- | --- |
| `alarms` | Service Worker の定期同期、画像の自動継続と backoff 再開 | 1 回限り alarm、固定時刻なし |
| `notifications` | 確定変化の OS 通知 | 件数と固定分類だけの本文、利用者が無効化可能 |
| `unlimitedStorage` | 履歴 IndexedDB の永続性 | IndexedDB を quota 制限と storage pressure による eviction から保護 |
| `declarativeNetRequestWithHostAccess` | VRChat 指定形式の User-Agent | 動的 rule 1 件、extension initiator + API GET XHR のみ |
| `cookies` | 公式WebセッションをAPIへ一時橋渡し | Auth Cookie Bridge内の固定名2つと非秘密markerだけ。値を返却・永続化しない |
| `https://vrchat.com/*` | source Cookie読取りと固定ログイン画面 | Cookie APIは固定source URLと名前へ再制限し、ページへcodeを注入しない |
| `https://vrchat.cloud/*` | APIへ届き得る親domain Cookieの競合検査 | 固定名だけを列挙し、network fetch先にはしない |
| `https://api.vrchat.cloud/*` | target一時CookieとAPI GET | Cookieは固定host/path、API adapterは `/api/1/` とGETへ再制限 |

IndexedDB の API 利用自体に `storage` 権限は不要だが、Chrome 公式文書では `unlimitedStorage` が IndexedDB を quota 制限と eviction から除外する。消失後に再取得できない名称履歴を守るため、本製品では必須権限とする。これは端末故障、拡張削除、ブラウザプロファイル破損のバックアップ代替にはならない。

### 6.2 使用しない権限

現在の機能に必要な権限だけをmanifestへ宣言する。次の権限は、閲覧履歴や他サイトへ影響範囲を広げる一方で、ワールド履歴の取得には必要ない。

- `webRequest` / `webRequestBlocking`: 通信の広域監視をしない。MV3 の限定 DNR rule を使う。
- `tabs`: タブ URL や閲覧履歴を読む必要がない。
- `history`, `downloads`, `clipboardRead`, `clipboardWrite`: 本機能に不要。
- `scripting`, `activeTab`, content scripts: VRChat ページへコードを注入しない。
- `<all_urls>` またはVRChat以外のwildcard host: 設計で列挙したVRChat host以外を読む必要がない。

自己アンインストールは `chrome.management.uninstallSelf` だけを利用し、他拡張の管理を可能にする `management` 権限は追加しない。

### 6.3 Windows インストーラーの権限

Inno Setup 6 は `PrivilegesRequired=lowest` で現在の Windows ユーザーだけを対象とし、管理者権限と UAC を要求しない。書込み・削除対象は `%LOCALAPPDATA%\Programs\VRCFavoriteWorldHistory` の app root 内に固定する。

Inno Setup 標準の HKCU アンインストール登録以外に registry を変更せず、custom `[Registry]` section、browser policy、force install、service、scheduled task、startup を使わない。Chrome のプロフィール、Cookie、IndexedDBを探索せず、インストーラーから認証、API、同期、DB、backup 処理を呼ばない。

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
- JSON APIのfetchは `redirect: "manual"` に固定し、3xx / opaque redirectでは同期を停止する。画像fetchだけは `redirect: "follow"` とし、CSP `connect-src`をself・HTTPSの`api.vrchat.cloud`・`files.vrchat.cloud`に限定して各転送の送信前に接続先を制限する。画像にはCookieとRefererを付けず、本文読出し前に最終URLの既知pathを検査し、file IDを含む形式は画像ID・版・サイズを照合する。数値形式は実測した9桁・1桁・256 PNGのパスだけを、元画像APIからのredirectかつ要求size 256の場合に許可する。この形式では画像ID・版をURL上で照合できず、公式APIの転送結果を信頼する。転送回数はブラウザ上限とtimeoutで制限し、厳密な1回限定とはしない。
- method は GET に固定し、request body を送らない。
- APIが返したURLは、検証済みの `thumbnailImageUrl` だけを画像取得に使う。host、path、scheme、port、query、fragmentを検査し、認証Cookieを付けない。
- 通信先はVRChatの固定API、画像配信先files、固定ログイン画面に限定する。WebSocket、分析サービス、開発者サーバーへは接続しない。

### 8.2 レート制限

- 通常データは bulk endpoint と IndexedDB cache を使う。
- 要求を並列化せず、開始間隔を 2 秒以上空ける。
- 個別 probe は 1 同期最大 20 件。
- 定期同期は 12 時間 + 0〜60 分 jitter。起動直後も 1〜10 分 jitter。
- 手動同期は 5 分 cooldown、実行中は単一 flight を共有する。
- 同期中だけ 25 秒間隔の限定 keep-alive を使い、同期 promise の `finally` で必ず解除する。常時 keep-alive やバックグラウンド常駐には使わない。
- 429 では同期全体を即時停止し、同じ同期内で再試行しない。`consecutiveRateLimits` を飽和増加させ、妥当な `Retry-After` と指数 delay の遅い方から `backoffUntil` を保存する。
- `backoffUntil` 後は認証確認から新しい完全同期を開始する。完全同期成功時だけ連続 429 カウンターをリセットする。
- 5xx / network error だけ短い jitter 付きで最大 2 回再試行し、上限後は既存ワールド状態を変えず停止する。
- 自動同期が有効なら、同期のアプリケーション制御下にある全終了経路の `finally` で固定名の one-shot alarm を置換する。成功は 12 時間 + 0〜60 分 jitter、429 は `backoffUntil`、offline / 5xx 上限後は 30〜60 分後、401 / schema 不正 / その他は 12 時間 + 0〜60 分 jitter とする。無効なら既存 alarm を解除する。
- 自動同期中は同じ固定名 alarm を復旧 watchdog として先に登録する。正常終了時は通常の次回時刻へ置換し、Service Worker が強制終了した場合は watchdog から認証確認を含む完全同期を再開する。
- ブラウザ強制終了で `finally` を実行できなかった場合に備え、install / startup 時は永続化した `nextSyncAt` と alarm の有無を照合して欠けた 1 件を修復する。保存時刻が過去なら現在から 1〜10 分 jitter 後とする。複数 alarm による要求増幅を避けるため、既存の同名 alarm は必ず置換する。

### 8.3 画像の自動継続

画像用の固定名`thumbnail-next`アラームは通常60秒以上の間隔で未完ジョブだけを処理する。定期確認が無効でも開始済みジョブは完遂する。画像元URL・試行回数・profile・generationを端末内に保持し、ジョブの形式・件数・URLを検証する。試行前checkpointと画像保存でpurge・世代・activeProfileを確認し、途中復元や別profileへの切替で古い画像を書き込まない。各画像最大3回とし、同じジョブの再起動で回数を戻さない。Chrome起動時は未完ジョブのアラームを修復し、全消去で両アラームとジョブを消去する。

画像ジョブのcheckpointもbatchの30秒期限に含め、期限後に追加画像通信を開始しない。画像DBの読出しだけが失敗しても主要同期状態と既存履歴を表示する。ジョブ初期化の一過性保存失敗は同じ世代・profileのcheckpointを1回だけ再試行し、永続化できる前には画像通信しない。保存領域が継続して書込不能な場合は画像処理を開始せず、主要履歴の直前commitを保持する。

## 9. 入力検証と表示

### 9.1 API 応答

- HTTP status と Content-Type を先に検査する。
- JSON parse は応答サイズ上限内で行う。
- redirect response を JSON として parse しない。
- 配列要素は `unknown` から必要 DTO へ 1 件ずつ検証する。
- `id`、`favoriteId` の prefix と UUID 形式を検査する。例外は `/worlds/favorites` のページング境界だけが明示的にopt-inするnullable identityとする。canonical検査に一致しないIDは追加解釈・コピーせず `{ identity: null, metadata: null }` とし、raw件数だけをoffsetと総数上限へ含めてmetadata出力前に除外する。
- favorite group は `fvgrp_` ID、本人 `ownerId`、一意な内部名、`world|vrcPlusWorld` type を検査する。avatar/friend groupは検証後に破棄し、raw objectを保存しない。
- 任意の`thumbnailImageUrl`はHTTPSの`api.vrchat.cloud`、port・userinfo・query・fragmentなし、既知の`/api/1/file/`または`/api/1/image/` pathに一致する値だけを画像候補として受理する。不正な任意値は主要world metadataを止めず破棄する。取得後も最終URLの限定形式（数値形式の条件と残余リスクは上記参照）、MIME、byte数、PNG・JPEG・WebP header寸法をdecode前に検査し、decode後にも寸法を再検査する。Cookie・Refererを送信しない。画像APIからfilesへの転送はCSPと最終URL検証の下で許可し、署名付き転送先は保存・ログ出力せず、元API URLだけを保存版の識別に使う。画面はCSP img-src self/blobで外部画像の直接表示も防ぐ。画像処理は1回最大100件・共通deadline 30秒とし、fetch timeoutは5秒と残り時間の短い方、期限時はAbortSignalで後続処理も中止する。通信断・5xx・429では残りを止める。429では待機期限を保存し、期限前は主要APIも含めて追加通信しない。
- 名前と作者名は制御文字を除外し、表示・保存長を合理的な上限にする。ただし空白や Unicode 名を不必要に破壊しない。
- 未知フィールドは無視する。必須フィールド欠落はpage全体を不正として同期を中止する。noncanonical ID行もID以外の必須fieldをすべて検査する。null identityはglobal重複検査から除外し、canonical ID重複は中止する。canonical IDがあるpageのfingerprintはcanonical ID列と除外件数から作り、全件nullのpageを除外件数だけで反復判定しない。非空snapshot全体のcanonical metadataが0件なら中止する。
- `/worlds/favorites` の `n=100` は要求件数であり、応答上限には使わない。100件超のraw pageは総数10,000件の残枠を投影前に検査し、他の一覧endpointは1ページ100件上限を維持する。
- 現行OpenAPI `CurrentUser` の必要2fieldと追加fieldをreleaseごとに確認する。credential-like fieldを含むfixtureでも戻り値を `id` / `displayName` だけに固定し、必要2fieldの不正とbounded JSON境界だけをfail closedにする。
- `/auth/user` raw object、未知 field、error body、header map を汎用 logger に渡さない。

### 9.2 DOM

- API / DB / backup 由来の文字列に `innerHTML`、`outerHTML`、`insertAdjacentHTML` を使用しない。
- 文字列は `textContent`、属性は型別の安全な setter を使う。
- 外部リンクはコードに固定した `https://vrchat.com/` と GitHub repository だけとする。
- `target="_blank"` の Web link には `rel="noopener noreferrer"` を付ける。
- inline script、inline event handler、`eval`、`new Function`、リモート script を禁止する。
- extension CSP は既定より緩めない。

### 9.3 バックアップ

復元入力の初期上限は、ファイル 25 MiB、profile ちょうど 1 件、worlds 10,000、favoriteGroups 100、events 100,000、表示名履歴はグループごと100、文字列 4,096 code points、配列 nesting 4 とする。製品の実測により縮小できるが、無制限にしない。

- `__proto__` 等を特別扱いする merge を行わず、schema field を新規 object へコピーする。
- enum 外、非有限数、無効日時、重複 key、存在しない world への event を拒否する。
- HTML や JavaScript として解釈しない。
- 全検証完了前に IndexedDB を変更しない。
- 復元 transaction は対象 `userId` の profile/worlds/favoriteGroups/events だけを key range で置換し、他 user の record を削除しない。global settings は allowlist 済み preferences だけを同じ transaction で merge する。
- profile ごとの単調増加 generation を復元 transaction で更新し、復元前の snapshot から作られた同期 plan が同じ world revision を偶然持っていても commit できないようにする。generation は端末内の競合検知専用で export しない。
- event作成時に固定した`notificationEligible`と、`notificationClaimedAt`、`notifiedAt`、固定enumの`notificationError`を検証して復元する。通知対象かつ未claimのimport eventだけ`notificationClaimedAt = max(restoredAt, observedAt)`を設定し、時計ずれで日時順序を壊さず再通知しない。通知対象外eventにdelivery stateがあれば拒否する。
- 復元 transaction が失敗した場合は対象 user、他 user、settings の処理前状態を保持する。

## 10. 保存とプライバシー

### 10.1 IndexedDB

Chrome 拡張の IndexedDB はブラウザプロファイル内に保存されるが、アプリケーションレベルで暗号化されない。現行仕様は、利用者が別の暗号化パスワードを管理する方式を採用せず、OSアカウント、画面ロック、端末のディスク暗号化でローカルデータを保護する。

`unlimitedStorage` により quota と自動 eviction から保護するが、利用者による拡張削除、ブラウザプロファイル削除、端末故障は防げない。1 profile 単位の JSON バックアップを併用する。

`syncRuns` はプロフィールごと100件、認証前は20件へ自動整理する。過去world、変更event、保存済みthumbnailは製品の正本なので自動削除せず、8,000world、80,000event、概算250MiBで事前警告する。800件のthumbnailがすべて48KiBでも約38MiBである。

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

OS 通知はロック画面へ表示され得るため、既定本文にワールド名と VRChat 表示名を入れない。「お気に入りワールドに 3 件の変化があります」のように件数だけを表示し、詳細は拡張画面を開いて確認する。通知対象は名称変更、確定したお気に入り消失・復帰、アクセス不可・復帰だけとし、リスト移動は履歴と未読件数には残してもOS通知しない。一覧欠落またはアクセス不可を含む場合も、world IDで重複を除いた件数と固定分類だけを通知する。通知IDは本拡張が生成するgeneric用または要確認用の固定prefixだけを受け付け、genericは固定の`dashboard.html#events`、要確認は保存済み名称と画像を直接確認できる固定の`dashboard.html#attention`を開く。通知IDや外部値をURLへ連結しない。

通知 API の attempt は event ごとに最大 1 回とする。呼出し前に `notificationClaimedAt` を transaction で確定し、成功、明示的失敗、crash のいずれでも解除しない。成功時は `notifiedAt`、明示的失敗時は応答本文や stack trace ではなく固定 `notificationError` だけを保存する。通知が欠落しても再 attempt せず、ローカル履歴を正本として常に確認可能にする。

未読件数はイベントcommitと同じtransactionで増やし、履歴画面を開いた操作でだけ0にする。バッジAPI失敗は同期結果を巻き戻さず、次回起動または同期後にDBから再構築する。

### 10.4 全消去

全消去開始時に冪等な`beginPurge`で `purgePending` を先に保存して手動・自動同期をfail closedにし、`sync-next` alarmを止める。消去処理が所有を証明できる一時API Cookieの削除、または中断後の対象Cookie不在を確認してから、全storeを1 read-write transactionでclearし、同じtransactionで`purgePending`とschema情報だけを再作成する。repositoryの全書込みtransactionもsettings storeから同じguardを読み、別タブ・別DB connectionによる復元や設定変更を消去開始後は拒否する。Cookie cleanupまたはtransactionが失敗すれば利用者recordを処理前のまま維持し、自己アンインストールしない。成功時だけ`uninstallSelf`へ進むため、確認ダイアログ中の終了や取消後もguardが残り、同期もDB書込みも再開しない。再起動後の再試行は有効なguardを解除せずcleanup、消去、自己アンインストールをやり直し、新規guardを設定した消去処理がデータ削除前に失敗した場合だけ専用recoveryを許可する。

この論理削除はSSD上の物理ブロック消去を保証しない。また、ダウンロード済みJSON、Downloads内のインストーラー、Windowsの固定配置ファイルを拡張側から探索・削除しない。認証情報を保存しないこと、OSアカウント保護、ブラウザプロファイル暗号化により残余リスクを軽減する。

正規の削除順序は、必要なJSONバックアップの保存、拡張UIによる一時Cookie不在確認・全消去・自己アンインストール、Windows側アンインストールの順とする。Windows側は固定app root内の `extension`、一時的な `extension.new` / `extension.old`、Inno Setup自身の固定ファイルだけを削除する。Chrome側の削除完了をプロフィールから判定せず、Chromeのプロフィール、公式Web側や他ソフトのCookie、IndexedDB、JSONバックアップを削除しない。

## 11. ビルドと供給網

- package manager の lockfile を commit し、CI とローカルで frozen lockfile install を使う。
- runtime dependency は必要最小限にし、依存追加時はライセンス、maintainer、install script、既知脆弱性を確認する。
- postinstall script を必要なく許可しない。
- Manifest V3 のリモートコード禁止に従い、配布物の JavaScript / CSS / font / image を自己完結させる。
- source map にローカル絶対 path、環境変数、秘密を含めない。公開配布物に不要なら含めない。
- 配布 ZIP 作成前に `.env`、Cookie、token、実利用者 DB、ログ、テスト fixture の実データ、大容量生成物を検査する。
- 公開 repository の CI secret は製品 runtime へ埋め込まない。
- `npm run package` は検証済み `dist/extension` からChrome用ZIPとWindowsインストーラーを生成する。manifestと`package.json`のversion一致、manifestの`key`不在、同梱内容をインストーラー作成直前にも検査する。
- WindowsインストーラーはInno Setup 6でコンパイルし、compilerの自動取得やruntime downloadを行わない。
- インストーラーはコード署名しない。生成EXEのSHA-256を任意の照合情報として配布案内へ載せ、署名済みに見せる表現をしない。

## 12. セキュリティ検証

リリース前に少なくとも次を自動または手動で確認する。

1. manifest snapshotに必要な `cookies` と `unlimitedStorage` があり、`webRequest`、`<all_urls>`、不要hostがない。host permissionは `vrchat.com`、`vrchat.cloud`、`api.vrchat.cloud`、`files.vrchat.cloud` の4つだけで、rootは親domain競合検査だけに使う。
2. DNR rule の host、path、initiator、resource type、method、User-Agent 形式が API base と完全一致する。
3. DNR登録失敗時にCookie bridgeとfetchが呼ばれない。
4. Cookie bridgeがsourceの固定名2つだけを個別取得し、Promise版APIの未検出値とsourceの非Secure属性を実Chrome同様に扱いながら、targetのhost-only/path/Secure/HttpOnly/SameSite/TTL/storeIdを固定する。成功・401・429・例外で認証Cookie→markerの順に削除し、値をerror、DB、backup、DNRへ渡さない。
5. source欠落、Chrome同等のhost権限フィルター、親domain・別pathを含むtarget競合、Cookie APIから返るpartitioned、set/remove失敗、古いmarker、並行呼出し、初回確認後の差替えを注入し、fetch 0または削除直前にも本処理が設定した値・属性が一致する場合だけ削除になる。異なる値・属性と再起動後の認証Cookieは削除せずcleanup失敗とする。
6. 最新OpenAPI `CurrentUser` の `authToken`、`usesGeneratedPassword` とnestedのcredential-like fieldを加えた `/auth/user` fixtureでも同期でき、adapterの戻り値が `id` / `displayName` だけで、IndexedDB、backup、logに秘密値が残らない。必要2fieldの不正、top-level非object、誤Content-Type、巨大・不正JSONはfail closedになる。
7. `<img onerror=...>`、`<script>`、双方向 Unicode を含む world 名を表示しても code execution されない。
8. 25 MiB 超、複数 profile、深い object、`__proto__`、重複 ID、壊れた参照の backup を拒否し、全 profile の旧 DB が残る。正常な復元では対象 user だけが置換される。
9. 401、429、5xx、timeout、schema 不正で state transition が生じない。
10. 429 後は同じ同期で要求せず、永続化した `backoffUntil` より前に新しい同期を開始しない。連続 429 で指数 delay と counter が上限に飽和する。
11. JSON APIは`redirect: "manual"`で3xxを追従しない。画像のAPI→files転送は実Chromeで取得・保存・表示まで成功し、未知originへの転送はCSPで通信前に遮断される。画像取得にCookie・Refererが付かず、署名付きURLが保存結果へ混入しないことを検査する。
12. claim commit 後の crash または通知 API の明示的失敗を注入しても claim を解除せず、同じ event の通知 attempt が Service Worker 再起動後に増えない。明示的失敗では固定 `notificationError` が残り、いずれも履歴が表示できる。
13. 自動同期を有効にした成功、429、offline、5xx 上限、401、schema 不正、その他の各終了 fixture で、既存の名前付き alarm が正しい次回時刻の 1 件へ置換される。自動同期無効時は alarm が残らない。
14. ビルド成果物と Git 差分を秘密情報パターンで検査する。
15. 配布物のコードから許可 host 以外の `http://` / `https://` / `ws://` / `wss://` 文字列を列挙し、用途をレビューする。
16. installer config に `PrivilegesRequired=lowest` と固定 `%LOCALAPPDATA%` path があり、install path変更UI、custom `[Registry]`、policy、force install、service、scheduled task、startup、telemetry、runtime download がないことを静的テストする。
17. installer入力と `dist/extension` が一致し、manifestに`key`がなく、version一致、downgrade拒否、同版許可、単一`extension.old` rollback、app root限定削除が構成とテストで確認できる。
18. Windows上のInno Setup 6 compileを完走し、生成EXEとSHA-256を確認する。
19. `/worlds/favorites` が要求件数を超えるpageやnoncanonical IDを含むfixtureで、offsetがraw件数だけ進み、IDを追加解釈せずmetadata出力前に除外する。nullable identityがこのendpointだけの明示opt-inであること、canonical ID列と除外件数によるfingerprint、全件nullのpage、非空snapshot全体のcanonical metadata 0件を検査する。除外IDがadapter戻り値、DB、UI、log、backup、個別API URLに現れず、ID以外の不正とcanonical ID重複ではfail closedになる。
20. サムネイル取得で、許可外URL、不正な転送、Cookie送信、巨大入力、巨大寸法、未対応形式、破損画像、出力上限超過を拒否する。正常画像は最大辺320px・48KiB以下のWebPだけが保存され、画像処理の失敗で主要なワールド履歴を巻き戻さない。
21. 対象の実PCと実Chromeでfresh install、インストーラー削除後の起動、同版再インストール、対応する旧版からの上書き更新、必要権限の承認、Service Workerからの `/auth/user` 200、お気に入りの完全同期、同期後の一時Cookie不在、更新前後のextension ID・履歴保持、正規順序のアンインストールを確認する。

## 13. 残余リスクと対応

- **非公式 API**: endpoint、schema、認証 Cookie の挙動は予告なく変わり得る。不明な応答は fail closed とし、ワールド状態を更新せず、拡張更新を案内する。
- **world metadataの非canonical ID**: `/worlds/favorites` にはcanonical形式でないIDが混在し得る。該当IDを追加解釈・コピーせず行を除外するため、その行の名称とサムネイルは同期できない。非空snapshotの全件が該当する場合はfail closedとし、canonicalな `/favorites` の関係IDと保存済み履歴を守る。
- **source Cookieの属性**: VRChat側の `auth` と `twoFactorAuth` にはSecure属性が付かない場合があり、この属性は本拡張から管理できない。本拡張は固定HTTPS URLからだけ値を読み、sourceを変更・延命・HTTP送信せず、API側の一時Cookieには必ずSecureを付ける。
- **404 の曖昧性**: 削除と非公開を区別できない。「現在アクセスできません」とだけ表示し、HTTP 404 と観測時刻を履歴根拠に残す。
- **Cookie制限・partitioning**: Bridgeはpartition keyを指定せず非partitioned Cookieだけを扱う。sourceがpartitionedだけなら通常は未ログインとして停止する一方、任意partitionを一括列挙するAPIは使わないため、すべてのpartitioned targetを事前検出する保証はない。設定を勝手に変更せず、対象実機で `/auth/user` 200と同期後のtarget Cookie不在をrelease gateにする。
- **Cookie設定・削除の競合窓**: target不在の再確認と `cookies.set`、値・属性の最終確認と `cookies.remove` は、いずれも原子的なcompare-and-write/deleteではない。同じChrome profileの別拡張・別ツールが同じhost/name/pathへ同時操作した場合は競合が残る。対象利用者が同種ツールを併用しない前提とし、設定直前の再確認、設定結果の完全一致検査、全対象の事前検査、各削除直前の再比較で窓を縮め、異常はcleanup失敗にする。
- **一時Cookie残留**: 通常終了では本処理が設定した値・属性の一致時だけ削除し、途中終了後は認証Cookieを誤削除せず、設定時点の最長15分の失効を待つ。APIが同名Cookieを長期更新する可能性はコードだけで排除できないため、対象実機で各API応答後も値・属性・期限が変わらず、同期後に不在となることをrelease gateにする。変化を検出した場合は配布せず認証設計を見直す。
- **広いブラウザ権限**: Chromeは `cookies` 権限をCookie名単位に制限できない。実装と自動テストで固定名・固定hostへ狭め、公開ソースのレビューと配布物監査を行う。悪意ある更新や拡張コード侵害時の影響は権限自体では防げない。
- **必須権限の再承認**: 現行manifestは `cookies` と `vrchat.com` / `vrchat.cloud` / `api.vrchat.cloud` のhost権限を使う。更新で権限が変わるとChromeが拡張を一時停止し、再承認を求める場合がある。更新後は管理画面で拡張の有効状態と表示versionを確認する。インストーラーはブラウザ権限を自動承認しない。
- **ローカル平文データ**: 同一 OS アカウントの攻撃者からは保護できない。秘密情報は保存せず、嗜好履歴については OS の保護に依存する。
- **OS 通知は exactly-once ではない**: 本製品は通知前の永久 claim による厳密な at-most-once を選ぶ。claim 後 crash の曖昧な窓や通知 API の明示的失敗では通知が欠落し得るが、結果にかかわらず再 attempt して重複させず、履歴を正本とする。固定 `notificationError` は診断表示用であり再試行条件ではない。
- **CurrentUserのcredential-like field**: 現行schemaには任意の `authToken` と必須の `usesGeneratedPassword` がある。これらを含む未知fieldはbounded parse中に一時的にheapへ存在し得るが、名前・値・階層を走査せず、`id` / `displayName` 以外をadapter外へ渡さない。必要2fieldの契約が変わった場合はfail closedにして再評価する。
- **API 利用方針の変更**: Creator Guidelines をリリースごとに再確認する。利用禁止または安全な認証が成立しなくなった場合は API 同期を停止する更新を優先する。
- **未署名インストーラー**: コード署名を行わないため、真正なビルドでもWindows SmartScreenが未認知の実行ファイルとして警告する可能性がある。READMEで警告画面の進み方を案内し、希望する利用者向けにSHA-256を提供する。SHA-256はファイルの一致確認に使えるが、発行者証明とSmartScreen警告の解消にはならない。
- **限定した実機範囲**: リリース実機確認は対象PCとGoogle Chromeを基準とする。Microsoft Edge、複数profile、複数のウイルス対策製品、すべての障害点の組合せはサポート判断の根拠にしない。
