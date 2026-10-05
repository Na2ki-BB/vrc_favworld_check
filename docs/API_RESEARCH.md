# VRChat API利用の前提と設計判断

## 1. この文書の役割

本書は、`vrc_favworld_check` の同期機能が依拠する資料と、現在の設計判断を保守担当者向けにまとめたものである。情報を次の区分に分け、資料から確認できる事実と製品側の判断を混同しない。

1. **VRChat公式方針**: API利用の可否と守るべき条件を決める資料。
2. **ブラウザ公式仕様**: Chrome拡張で利用できる機能と制約を示す資料。
3. **コミュニティAPI資料**: endpointとschemaの参考資料。公開資料と実ブラウザで継続確認する。
4. **実装上の判断**: 不確実なAPIを安全に利用するため、本製品が採用する処理。

APIの動作確認に利用者の認証情報や応答本文を収集しない。自動テストは偽APIで行い、実環境の確認は利用者本人のブラウザ内で、秘密値を記録せずに行う。

## 2. 参照資料

### 2.1 VRChat公式

- [VRChat Creator Guidelines](https://hello.vrchat.com/creator-guidelines)
- [VRChat公式Webログイン](https://vrchat.com/home/login)
- [VRChat Community Guidelines](https://hello.vrchat.com/community-guidelines)
- [VRChat 2026.1.1 リリースノート](https://docs.vrchat.com/docs/vrchat-202611)

Creator Guidelinesの「API Usage / Bots」を最上位の判断基準とする。内容は変更され得るため、配布前に更新を確認する。

### 2.2 VRChat APIのコミュニティ資料

- [VRChat.community](https://vrchat.community/)
- [Login and/or Get Current User Info](https://vrchat.community/reference/get-current-user)
- [List Favorites](https://vrchat.community/reference/get-favorites)
- [List Favorite Groups](https://vrchat.community/reference/get-favorite-groups)
- [List Favorited Worlds](https://vrchat.community/reference/get-favorited-worlds)
- [Get World by ID](https://vrchat.community/reference/get-world)
- [Websocket API / Pipeline](https://vrchat.community/websocket)
- [コミュニティOpenAPI specification](https://github.com/vrchatapi/specification)
- [CurrentUser schema](https://raw.githubusercontent.com/vrchatapi/specification/main/openapi/components/schemas/CurrentUser.yaml)
- [FavoriteGroup schema](https://raw.githubusercontent.com/vrchatapi/specification/main/openapi/components/schemas/FavoriteGroup.yaml)
- [WorldID schema](https://raw.githubusercontent.com/vrchatapi/specification/main/openapi/components/schemas/WorldID.yaml)
- [FavoritedWorld schema](https://raw.githubusercontent.com/vrchatapi/specification/main/openapi/components/schemas/FavoritedWorld.yaml)

### 2.3 Chrome公式

- [Manifest V3の概要](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
- [Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)
- [chrome.cookies](https://developer.chrome.com/docs/extensions/reference/api/cookies)
- [chrome.alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [chrome.notifications](https://developer.chrome.com/docs/extensions/reference/api/notifications)
- [chrome.declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Extension Service Workerへの移行](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers)

## 3. 公式資料から確認できること

### 3.1 VRChat APIの利用条件

- VRChat APIは一般利用向けの公式公開仕様ではなく、endpointは追加、削除、形式変更、移動され得る。
- 規則に従う非公式アプリケーションはAPIを利用できるが、VRChat Supportによる動作支援は受けられない。
- アプリケーションは利用者へユーザー名、パスワード、2FAコード、認証token、session dataを要求または保存してはならない。
- 利用者アカウントによるAPI通信は、その利用者の端末とIPから行う。
- 変化の少ない情報はcacheし、429では要求を止め、error時はbackoffする。
- 定期要求を固定時刻へ集中させず、開始時刻やrandom offsetで分散する。
- User-Agentは `applicationName/Version contactInfo` 形式で明確に識別する。

本製品のUser-Agentは `vrc_favworld_check/<manifest version> https://github.com/Na2ki-BB/vrc_favworld_check` とし、利用者の情報を付加しない。

### 3.2 ブラウザ拡張の制約

- Manifest V3のService Workerは終了し得る。継続状態はIndexedDBへ保存し、定期処理は `chrome.alarms` で再開する。
- 拡張ページとService Workerは、manifestで許可したhostへcross-origin fetchできる。
- `chrome.cookies` の利用には `cookies` permissionと対象host permissionが必要である。
- Cookie未検出時、Promise版 `chrome.cookies.get` は `undefined` を返す。
- Manifest V3はremote codeを許可しないため、実行コードは配布物に同梱する。
- DNRの `modifyHeaders` は、条件を限定したrequestのUser-Agentを送信前に変更できる。
- `unlimitedStorage` は、消失後に再取得できないIndexedDB履歴をquotaとstorage pressureによる削除から守るために使用する。

## 4. コミュニティ資料に基づくAPI契約

ここでは、コミュニティ資料で確認した現在のendpointとschemaを示す。配布前に公開資料と実ブラウザで再確認する。

API baseは `https://api.vrchat.cloud/api/1` とする。すべてHTTPSのGETに限定し、自動redirectは追従しない。

| 目的 | Request | 利用するフィールド |
| --- | --- | --- |
| 既存セッションの確認 | `GET /auth/user` | `id`, `displayName` |
| お気に入りリスト名 | `GET /favorite/groups?n=100&offset={n}&ownerId={本人ID}` | `id`, `name`, `displayName`, `ownerId`, `type` |
| お気に入り関係 | `GET /favorites?type=world&n=100&offset={n}` | `favoriteId`, `tags`, `type` |
| お気に入りワールド情報 | `GET /worlds/favorites?n=100&offset={n}&releaseStatus=all` | `id`, `name`, `authorName`, `favoriteGroup`, `releaseStatus`, `thumbnailImageUrl` |
| 消失候補の再確認 | `GET /worlds/{worldId}` | `id`, `name`, `authorName`, `releaseStatus`, `thumbnailImageUrl` |

### 4.1 `/auth/user`

有効な公式Webセッションを使って本人を確認する。応答には認証に関係し得る追加フィールドが含まれる可能性があるため、サイズ制限付きでJSONを解析し、新しいobjectへ `id` と `displayName` だけをコピーする。raw応答とその他のフィールドはadapter内で破棄し、DB、ログ、バックアップへ渡さない。

公式WebのCookieとAPI hostのdomainが異なるため、host permissionと `credentials: "include"` だけでは認証情報がAPIへ届かない環境がある。本製品は `auth` と任意の `twoFactorAuth` だけをAPI用の短命Cookieへ一時複製し、同期終了時に削除する。Cookie値の永続化、全Cookie列挙、ログ出力は行わない。詳しい境界は [SECURITY.md](SECURITY.md) を参照する。

### 4.2 `/favorites` と `/worlds/favorites`

`/favorites` の `favoriteId` 集合をお気に入り関係の観測値、`/worlds/favorites` を名称、作者、所属リスト、公開状態、サムネイルURLの情報源として扱う。2つを分けることで、関係は観測できるがワールド情報を取得できない場合を区別する。

`/worlds/favorites` では、要求した `n` より多い行が返る場合と、従来の `wrld_` + UUID形式に一致しないIDが混在する場合が確認されている。現行実装は次のように処理する。

- offsetは採用件数ではなく、APIから受け取ったraw行数だけ進める。
- 非canonical IDは意味を推測せず、値をコピー、保存、表示、ログ出力、個別取得に利用しない。
- それ以外の必須フィールド、canonical IDの重複、総件数、要求回数は厳格に検査する。
- 非空snapshotに採用可能なmetadataが1件もなければ、正常な空一覧と区別して同期を停止する。
- `releaseStatus=all` を明示するが、利用者に権限のないワールドまで必ず返る保証とは解釈しない。

### 4.3 `/favorite/groups`

本人所有を確認した `world` と `vrcPlusWorld` のグループだけを採用する。`id` を安定key、`name` をrelation tagとの対応、`displayName` を画面表示と履歴に使う。

VRChat公式リリースノートは、VRC+のworld favoritesに4枠が追加され、通常4枠と合わせて最大8枠になったことを示している。空の未使用グループがAPIから常に返る保証はないため、通常4枠を既知slotとして扱い、保存済みグループまたはworld tagに `vrcPlusWorlds1`〜`vrcPlusWorlds4` があれば、未使用枠を含む8枠を画面用に合成する。

この補助endpointだけが403、schema不正、ページング不整合になった場合は、前回のリスト名を保持して主要なワールド同期を続ける。認証、rate limit、network、server、redirectの問題では同期全体を中止する。

### 4.4 `/worlds/{worldId}`

個別取得の404は、「この認証状態では現在ワールド情報を取得できない」という観測にだけ使う。公開資料から削除、非公開、権限制限、一時的不整合を区別できないため、画面では「現在アクセスできません」と表示する。

### 4.5 サムネイル画像

コミュニティschemaでは `thumbnailImageUrl` が必須フィールドに含まれる。本製品では、画像の不備で名前と状態の記録まで失わないよう、ワールド本体の必須情報とは分けて扱う。値がない、または安全なURLとして検証できない場合は画像取得だけを延期する。

受理するURLは `api.vrchat.cloud` の既知image/file pathに限定する。認証Cookie・Refererを付けずに取得し、画像APIからfilesへの転送をCSPと最終URL検査の下で許可する。media type、入力サイズ、画像寸法を検査したうえで、最大辺320px・48KiB以下のWebPへ再encodeしてIndexedDBへ保存する。署名付き転送先URLは保存せず、元のAPI URLを保存版の識別に使う。画面は外部URLではなく保存済みBlobだけを表示する。

2026-09-09、公開画像のimage経路はCookieなしで302を返し、filesの`/thumbnails/`へ転送後200 PNGを返すことを確認した。file経路も302だがfiles直下の画像名・file ID・版を含むpathへ転送される。Chrome拡張からCDN本文を読むためfilesのhost permissionを追加する。接続先制限は[Chromeの拡張CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)と[W3C CSP3](https://www.w3.org/TR/CSP3/)に基づき、Service Workerを含むconnect-srcで各転送の送信前に適用する。

## 5. 公開資料だけでは確認できないこと

- rate limitの具体的な要求数、時間窓、account・IP・endpointごとの差。
- `Retry-After` の有無、単位、最大値の一貫性。
- 複数endpointやpaginationが同じ時点の原子的snapshotを返すか。
- pagination中にお気に入りが変化した場合の重複・欠落挙動。
- 短い非空pageの後に追加データが返るか、および空page以外の終端表現。
- private、deleted、moderation、access controlの各場合に各endpointが返す値。
- Favorite relationがワールド情報の取得不能後も残る期間。
- 403と404の厳密な意味、および将来追加されるstatus。
- 認証Cookieの名前、属性、domain、期限が将来も現在の橋渡し方式と両立するか。
- ChromeのすべてのCookie設定とenterprise policyで同期できるか。
- endpointとresponse schemaの将来互換性。

不明点は推測で補わない。schema不正、未知status、完全取得できないpaginationでは、保存済みのワールド状態を変更しない。

## 6. 現行の設計判断

### 6.1 変化の確定

- `/favorites` と `/worlds/favorites` を完全取得し、関係とmetadataを別々に観測する。
- 一覧欠落と個別取得結果を、所属状態とアクセス状態の2軸で保持する。
- 一覧欠落とアクセス不可は、連続する完全同期2回で確定する。
- 401、429、5xx、network error、schema不正では状態を更新しない。

| 観測 | 画面表示 |
| --- | --- |
| 関係が2回連続で不在、個別取得は成功 | お気に入り一覧にありません（ワールドは閲覧可能です） |
| 個別取得が2回連続で404 | 現在アクセスできません |
| 成功したmetadataで名称が変化 | 名前が変更されました |
| 同期を完了できない | 同期できませんでした。履歴は変更していません |

### 6.2 要求間隔と再試行

- API要求を直列化し、開始間隔を約2秒にする。
- 定期同期は12時間に0〜60分のjitterを加える。
- 手動同期には5分のcooldownを設ける。
- 消失候補の個別取得は1同期20件までとする。
- 429では同期を直ちに停止し、妥当な `Retry-After` と指数backoffの遅い方を採用する。
- 5xxとnetwork errorだけを短いjitter付きで最大2回再試行する。
- Service Worker終了後も再開できるよう、次回時刻とbackoffを永続化してone-shot alarmを再登録する。

これらはVRChatが公表したrate limit値ではなく、負荷を抑えるための製品側の上限である。

### 6.3 ページング

非空pageはraw取得件数だけoffsetを進め、空pageを終端とする。短いpageや100件を超えるpageだけでは終了と判断しない。各endpointはデータ10,000件、非空要求100回、終端確認1回を上限とし、offset停滞、canonical ID重複、同一page反復ではsnapshotを拒否する。

### 6.4 通知

OS通知とIndexedDBを同じtransactionへ含められないため、exactly-onceは保証できない。本製品は重複通知を避けることを優先し、通知前にeventを永久claimする。通知表示前のcrashや通知APIの失敗では通知が欠落し得るため、画面の履歴と未読表示を正本とする。

### 6.5 WebSocket

コミュニティのPipeline資料は、接続URLへauth token値を含める方式を示している。また、お気に入り一覧の完全snapshotや名称変更を保証する資料は確認できない。認証値をURLへ展開せず、初回記録と取りこぼし回復を同じ仕組みで行うため、現行仕様は低頻度のHTTP同期を使用する。

公式イベントAPIが認証値をアプリケーションへ渡さず、HTTP同期では製品要件を満たせない状況になった場合に再評価する。

## 7. HTTP応答の扱い

| 応答 | 分類 | 保存済み状態への影響 |
| --- | --- | --- |
| 200 + schema valid | `success` | 全endpointの完全取得後に反映可能 |
| 200 + schema invalid | `API_INCOMPATIBLE` | 同期中止、状態不変 |
| 401 | `AUTH_REQUIRED` | 同期中止、状態不変、公式ログイン案内 |
| 認証を示す403 | `AUTH_REQUIRED` | 同期中止、状態不変 |
| その他403 | `FORBIDDEN` | 同期中止、状態不変 |
| 個別ワールドの404 | `WORLD_NOT_FOUND` | 連続確認に使う観測値 |
| 一覧endpointの404 | `API_INCOMPATIBLE` | 同期中止、状態不変 |
| 429 | `RATE_LIMITED` | 即時停止、backoffを保存、状態不変 |
| 5xx | `SERVER_ERROR` | 上限付き再試行後も失敗なら状態不変 |
| timeout / DNS / offline | `NETWORK_ERROR` | 上限付き再試行後も失敗なら状態不変 |
| 3xx / opaque redirect | `UNEXPECTED_REDIRECT` | 追従せず同期中止、状態不変 |

error bodyは不安定で秘密情報を含む可能性があるため、画面表示、状態判定、永続ログに利用しない。

## 8. 保守時の確認項目

### 8.1 自動テスト

- manifestの権限とhostが設計どおりに限定されていること。
- Cookie Bridgeが固定名だけを扱い、値をerror、DB、ログ、バックアップ、DNRへ渡さないこと。
- User-Agent用DNR ruleが拡張自身のVRChat GET APIだけに一致すること。
- `/auth/user` の追加フィールドをadapter外へ渡さず、必要2フィールドの不正では停止すること。
- pagination、短いpage、過剰返却、非canonical ID、重複、要求上限、空page終端をfixtureで確認すること。
- 401、403、404、429、5xx、network error、schema変更、redirectで保存済み状態を誤更新しないこと。
- 2回確認、復帰、名称変更、transaction rollback、通知claimを確認すること。
- thumbnail URL、入力サイズ、画像寸法、media type、redirect、出力サイズの境界を確認すること。
- successと各失敗経路で次回alarmが正しく置換されること。

### 8.2 実ブラウザ

- 公式Webログイン後、Service Workerから `/auth/user` とお気に入りendpointを取得し、完全同期できること。
- 同期中だけAPI用一時Cookieが存在し、同期終了後に認証Cookieと所有markerが残らないこと。
- 現在のお気に入り件数、リスト名、状態、サムネイルが画面へ反映されること。
- ChromeのCookie制限下で、失敗時の案内が利用者に次の操作を示すこと。
- 実データ数で同期が5分以内に完了し、429を誘発しないこと。

実機確認ではCookie値、token、API応答本文、ワールドID、名称、作者名を撮影、ログ保存、issue添付しない。問題報告には固定error code、製品・ブラウザのversion、発生時刻、件数だけを使う。

### 8.3 配布前の変更監視

- Creator Guidelinesの「API Usage / Bots」。
- コミュニティOpenAPIの採用endpointとschema。
- 公式Webの認証Cookie名・属性とAPI base。
- ChromeのCookie、partitioning、DNR、Manifest V3 Service Worker lifecycle。

互換性を確認できない変更では同期を停止し、履歴閲覧とJSONエクスポートは利用可能なまま保つ。


### 8.4 数値形式の画像CDNパス（0.1.13）

2026-10-05の実ブラウザ確認で、許可済みの `/api/1/image/<file ID>/<version>/256` から、HTTPSの `files.vrchat.cloud` 上の `/thumbnails/<9桁の数字>.<1桁の数字>.thumbnail-256.png` へ転送され、HTTP 200が返る例を確認した。実URL、数字の値、署名queryは保守記録やfixtureへ残さず、テストは合成値だけを使う。

[公式Creator GuidelinesのAPI Usage / Bots](https://hello.vrchat.com/creator-guidelines) は、APIが公開仕様として提供されず、形式などが予告なく変わり得ると説明している。公式資料およびコミュニティ仕様元の [paths.yaml](https://github.com/vrchatapi/specification/blob/main/openapi/components/paths.yaml)・[files.yaml](https://github.com/vrchatapi/specification/blob/main/openapi/components/paths/files.yaml) を確認した範囲では、この数値パスの意味や許容範囲を保証する記載は見つからなかった。上記は公開仕様ではなく実測した互換形式であり、桁数・size・拡張子を推測して広げない。

数値2ブロックは不透明な識別子として扱う。元のfile ID・versionとの対応はURLだけでは照合できないため、この形式だけは元画像APIからの実際のredirect、固定HTTPS host、厳密なパス、要求size 256を条件として受理する。従来のfile IDを含む形式ではfile ID・version・sizeの一致検査を維持する。署名queryの扱い、CSP、Cookie・Referer抑止、画像のサイズ・形式・再encode検査は変更しない。未知の桁数や形式は引き続き拒否し、必要があれば新たな観測とレビューで対応を判断する。
