# セキュリティ設計

この文書は、VRC Favorite World Historyの認証、通信、保存データを保守する開発者向けの説明です。利用者向けには[プライバシー方針](PRIVACY.md)、通信の詳細には[API連携仕様](API.md)を参照してください。

## 基本方針

- ログインはVRChat公式サイトで行います。拡張機能にユーザー名、パスワード、2FAコードを入力する機能はありません。
- 既存のログイン状態を利用するため、認証Cookieを限定的に読み取り、API向けの短命Cookieへ一時複製します。
- API通信は利用者のChromeからVRChatへ直接行い、開発者サーバー、分析サービス、クラッシュ収集サービスを経由しません。
- VRChat APIへの操作はGETだけです。お気に入りの追加・削除、ワールドの変更、ログアウトは行いません。
- API応答やバックアップは信頼しない入力として検証します。主要データの取得に失敗した場合は、保存済みのワールド状態を変更しません。

API利用の基準は[VRChat Creator Guidelines](https://hello.vrchat.com/creator-guidelines)です。VRChatは非公式アプリのAPI利用をサポートしておらず、APIや認証方法の互換性、個々の実装への承認を保証していません。

## 保存する情報と保存しない情報

IndexedDBには、VRChatのユーザーIDと表示名、ワールド情報・名称履歴、お気に入りリスト、縮小画像、確認時刻、通知状態、非表示・記録削除の状態、設定と処理の再開情報を保存します。別のVRChatアカウントの履歴はユーザーIDで分離します。

Cookie値、パスワード、2FAコード、認証トークン、APIの生の応答本文は、拡張のデータベース、設定、バックアップ、ログ、画面、通知へ渡しません。Cookie値は認証処理内のメモリとブラウザ管理の一時Cookieに限って扱います。`/auth/user` の応答は、2FA要求の判定後、必要な `id` と `displayName` だけを新しいオブジェクトへコピーします。未知のフィールドは保存用データへ引き継ぎません。ただし、JSON解析中の生の値は、メモリが回収されるまで一時的に存在し得ます。

ローカル履歴とJSONバックアップは暗号化していません。端末や同じOSアカウントへアクセスできる第三者からの保護は、OSとブラウザの保護に依存します。バックアップには利用者の好みを推測できる履歴が含まれます。

## Chromeの権限と接続先

宣言内容は [`manifest.json`](../extension/manifest.json) と [`manifest.test.js`](../tests/manifest.test.js) で管理します。

| 権限 | 用途 |
| --- | --- |
| `alarms` | 定期同期、失敗後の再開、未完の画像取得 |
| `cookies` | 公式Webセッションの一時的な橋渡しと競合検査 |
| `notifications` | ワールド名を含めない、件数と分類だけのOS通知 |
| `unlimitedStorage` | IndexedDBを通常の容量制限とストレージ逼迫時の削除から保護 |
| `declarativeNetRequestWithHostAccess` | 拡張自身のAPI要求に識別用User-Agentを設定 |

| ホスト権限 | 実装上の用途 |
| --- | --- |
| `https://vrchat.com/*` | 固定URLに対応する公式Webの認証Cookieを読む |
| `https://vrchat.cloud/*` | APIへ送られ得る親ドメインCookieの競合を検査する |
| `https://api.vrchat.cloud/*` | API用一時Cookieと、JSON・画像のGET |
| `https://files.vrchat.cloud/*` | 許可済み画像APIから転送された画像を読む |

`<all_urls>`、`webRequest`、`webRequestBlocking`、`tabs`、`history`、content script、外部拡張向けの接続設定は使いません。ページへのコード注入や、閲覧履歴の収集も行いません。

[ChromeのCookie API](https://developer.chrome.com/docs/extensions/reference/api/cookies)はCookie名ごとに権限を制限できません。上表のホスト権限と `cookies` を持つコードが侵害された場合、実装内の名前制限だけでは防げません。また、[unlimitedStorageの保護](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)は端末故障、拡張削除、プロファイル破損に対するバックアップの代わりにはなりません。

## 認証Cookieの橋渡し

実装: [`auth-cookie-bridge.js`](../extension/lib/auth-cookie-bridge.js)、[`auth-status.js`](../extension/lib/auth-status.js)、[`background.js`](../extension/background.js)

同期とログイン状態確認は同じ橋渡し処理を使い、起動時・全消去時の後処理も含めて直列化します。

1. 利用者が通常のタブで `https://vrchat.com/home/login` にログインします。拡張内へのログイン画面の埋め込みは行いません。
2. `https://vrchat.com/api/1/auth/user` に一致する `auth` と、存在する場合の `twoFactorAuth` だけを名前指定で取得します。元Cookieを変更・延命しません。
3. APIへ届き得る同名Cookieを、親ドメインと全パスを含めて検査します。既存の認証Cookieがあれば、上書きや削除をせず停止します。名前を指定しない全Cookie列挙は行いません。
4. 非秘密の所有マーカーを設定し、再度競合がないことを確認してから、一時Cookieを作成します。
5. API処理の成功・失敗にかかわらず、自分が設定した値と属性の一致を確認して認証Cookieを削除し、最後に所有マーカーを削除します。

### 一時Cookieの属性

| 項目 | 設定 |
| --- | --- |
| ドメイン | `api.vrchat.cloud`、host-only |
| パス | `/api/1/` |
| 属性 | `Secure`、`HttpOnly`、`SameSite=Strict` |
| 有効期限 | 設定時から15分と元Cookieの期限のうち早い方 |
| Cookieストア | 元の `auth` と同じストア |

所有マーカーは `__vrc_favworld_check_bridge=owned-v1`、専用パス `/.well-known/vrc-favworld-check-cookie-bridge/` に置き、設定時から20分で失効します。認証情報は含みません。

元Cookieに `Secure` がなくても、固定HTTPS URLからの取得は許容します。一時Cookieには必ず上記属性を設定します。Cookie APIがpartitioned Cookieを返した場合は停止しますが、任意のpartitionを一括列挙する設計ではないため、すべてのpartitioned Cookieを検出できる保証はありません。

### 中断・競合時の扱い

- Service Workerの再起動後は設定時のCookie値を失うため、認証Cookieを自分のものと推定して削除しません。失効して不在になったことを確認した後、残ったマーカーだけを削除します。
- 通常の削除でも、全対象の検査と各削除直前の再確認を行います。異なる値・属性へ変わっていれば後処理失敗として停止します。
- Chromeの確認と設定・削除は原子的な一操作ではありません。他の拡張やツールが同じCookieを同時に操作する場合、小さな競合窓が残ります。
- APIが一時Cookieを書き換えたり期限を延長したりすると、15分で必ず消えるとは限りません。実Chromeで、API応答後の属性・期限と処理後の不在を確認する必要があります。
- 履歴の保存後にCookieの後処理だけが失敗した場合は、保存済み履歴を保持したまま `AUTH_COOKIE_CLEANUP_FAILED` を返します。「エラーなら何も保存されていない」とは限りません。

Cookie値をUIへ返す、ログへ出す、バックアップする、URLに入れる、DNRへ埋め込む処理は禁止します。

## 通信と入力の検証

### JSON APIとUser-Agent

JSON APIは固定の `https://api.vrchat.cloud/api/1` を使い、`GET`、`credentials: "include"`、`cache: "no-store"`、`redirect: "manual"` で通信します。3xxへの追従は行いません。レスポンスは最大5MiB、JSONのmedia type、UTF-8、必要な型・ID・文字数・件数を検査してから利用します。エラー本文は解析・保存・表示しません。

[`dnr.js`](../extension/lib/dnr.js)は動的ルール `61001` だけを管理します。対象は現在の拡張IDを送信元とする、APIホストの `/api/1/` 以下へのGET・`xmlhttprequest` に限定します。User-Agentは `vrc_favworld_check/<manifest version> https://github.com/Na2ki-BB/vrc_favworld_check` です。登録後にルール全体の一致を検査し、失敗した場合はCookieの橋渡しとAPI通信を開始しません。[Chrome DNR仕様](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)

要求間隔、再試行、ページ分割、エラー分類は[API連携仕様](API.md)を参照してください。

### サムネイル

実装: [`api.js`](../extension/lib/api.js)、[`thumbnail.js`](../extension/lib/thumbnail.js)

- 元URLはHTTPSの `api.vrchat.cloud` にある既知の `/api/1/image/` または `/api/1/file/` 形式だけを採用します。userinfo、query、fragmentなどを拒否します。
- 画像のGETだけはリダイレクトを追跡します。`credentials: "omit"` と `referrerPolicy: "no-referrer"` を指定し、CookieとRefererを送りません。
- CSPの `connect-src` は自身とHTTPSのAPI・filesホストに限定します。転送先URLの検査は通信後の検査なので、これだけを外部通信の防止策とはしません。[Chromeのネットワーク制約](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、[CSP仕様](https://www.w3.org/TR/CSP3/)
- imageルートの転送先は、実際のリダイレクトで到達した `https://files.vrchat.cloud/thumbnails/` 直下の単一ファイル名に限定します。名前は英数字と `._~-` の1〜1,024文字です。階層、エンコードされた区切り、空白、制御文字、バックスラッシュ、userinfo、明示port、fragmentは拒否します。
- imageルートのファイル名は不透明な識別子として扱い、ID・版・サイズ・拡張子を解析しません。別画像や古い版への対応不一致を名前から検出することはできません。fileルートでは元のfile ID・版との一致を検査します。
- 転送先のqueryは通信中だけ使い、署名を独自に検証したとは扱いません。保存するのは元API URLと加工後の画像です。
- 入力はPNG・JPEG・WebP、最大5MiB、各辺8,192px以下、1,600万画素以下です。ヘッダーで寸法を検査してからデコードし、デコード後にも確認します。
- 出力は最大辺320px、48KiB以下のWebPへ再生成します。画面は保存済みBlobだけを表示し、外部画像URLを直接読み込みません。

画像処理は主要な履歴の保存後に行います。画像取得や保存が失敗しても、成功済みのワールド履歴は巻き戻しません。再開ジョブには元URL、試行回数、対象ユーザー、データ世代を保存し、復元・全消去・アカウント切替後に古いジョブが書き込まないよう検査します。ブラウザの画像デコーダー自体の未知の脆弱性は残余リスクです。

### 表示とバックアップ

ワールド名などは `textContent` 等で表示し、`innerHTML`、`eval`、リモートスクリプトを使いません。CSPは `script-src 'self'`、`object-src 'none'`、`base-uri 'none'`、`img-src 'self' blob:` を指定します。

[`backup.js`](../extension/lib/backup.js)は1アカウント分のJSONを対象とし、形式version 3を書き出し、version 1〜3を読み込みます。

| 検証項目 | 上限・条件 |
| --- | --- |
| UTF-8ファイルサイズ | 25MiB |
| ワールド／履歴イベント | 10,000件／100,000件 |
| お気に入りリスト／非表示・削除状態 | 100件／10,000件 |
| 通常の文字列 | 4,096コードポイント |
| 配列／オブジェクトの入れ子 | 4段／8段 |
| オブジェクトの項目数／全体の値の数 | 64項目／2,000,000個 |

許可したフィールドだけでデータを再構築し、認証情報らしいキー、`__proto__` 等、未知フィールド、重複ID、他ユーザーの混入、壊れた参照、不正な日時・状態を拒否します。サムネイル、画像取得ジョブ、認証情報はバックアップ対象外です。容量超過時に履歴を黙って切り捨てることはありません。

復元は対象ユーザーのデータを一つのIndexedDBトランザクションで置換し、他のユーザーの履歴を保持します。復元した過去イベントを新しいOS通知として再送しません。画像そのものはバックアップから復元できません。

## 履歴・削除・通知の安全性

- 完全な一覧取得と入力検証が終わってから、ユーザー情報、ワールド、履歴、お気に入りリスト、同期結果を一括保存します。世代番号と更新番号の検査で並行更新を検出します。
- お気に入り一覧からの不在と現在アクセスできるかを別々に扱います。不在・アクセス不可は連続する完全同期2回で確定し、404だけで「ワールドが削除された」と断定しません。
- 非表示は履歴を保持します。記録削除は対象ワールドの名称・履歴・画像を削除しますが、再取得を抑制するためのユーザーID、ワールドID、削除状態は残ります。
- 全データ消去では新規処理を止め、アラームとCookieの後処理を行い、全ストアの利用者データを消去した後に拡張の削除を求めます。消去に失敗したまま自己アンインストールはしません。書き出し済みJSONは別途削除が必要です。
- 通知は件数と固定分類だけで、ワールド名・作者名・ユーザー名を表示しません。通知前に処理済み印を永続化するため、重複通知を抑える一方、中断や通知APIの失敗では通知が届かない場合があります。画面の履歴が確認元です。

## 保守・配布時の確認

自動テストでは、権限、DNR、Cookie競合と後処理、API入力・ページング、画像上限、復元の整合性、通知と全消去の境界を確認します。主なテストは [`manifest.test.js`](../tests/manifest.test.js)、[`auth-cookie-bridge.test.js`](../tests/auth-cookie-bridge.test.js)、[`api.test.js`](../tests/api.test.js)、[`thumbnail.test.js`](../tests/thumbnail.test.js)、[`backup.test.js`](../tests/backup.test.js)、[`background.test.js`](../tests/background.test.js) です。

自動テストだけで実際のVRChat・Chromeとの互換性を保証することはできません。配布前には公式方針とAPI仕様の変更を確認し、実Chromeでログイン状態確認、完全同期、一時Cookieの後処理、画像の転送と表示、更新時の履歴保持、全消去を確認します。Cookieの期限が延長されるなど認証境界が崩れる場合は、そのまま配布せず設計を見直します。

依存関係は `package-lock.json` で固定し、更新時にはライセンス、インストールスクリプト、既知の脆弱性を確認します。配布前には、ソースと生成物に秘密情報、実利用者のデータ、不要なファイル、未確認の外部通信先が混入していないかを検査します。実行コードは配布物に同梱し、実行時に外部コードを取得しません。

Windowsインストーラーは管理者権限を要求せず、固定の利用者用フォルダーへ配置します。コード署名はありません。SHA-256は配布ファイルの一致確認用であり、発行者証明やSmartScreen警告の解消にはなりません。詳細は[インストーラー仕様](INSTALLER.md)を参照してください。

問題報告やテスト用データには、Cookie値、認証トークン、生のAPI応答、署名付き画像URL、実利用者の履歴を含めないでください。通常の診断には、固定エラーコード、拡張・Chromeのバージョン、発生時刻、件数を使います。
