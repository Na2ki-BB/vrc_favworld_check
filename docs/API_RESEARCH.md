# VRChat API・ブラウザ拡張 調査記録と採用判断

## 1. 調査目的と注意

本書は `vrc_favworld_check` が安全に実装可能かを判断するため、2026-08-17 時点で参照した公開情報、そこから確実に言える事実、設計上の推論を分離して記録する。

VRChat は API を公式な公開仕様として保証していない。したがって、次の信頼順位を用いる。

1. **公式方針**: VRChat Creator Guidelines。API を使ってよい条件を決める最上位資料。
2. **公式プラットフォーム仕様**: Google Chrome / Microsoft Edge の拡張機能文書。
3. **コミュニティ記述**: VRChat.community の endpoint / schema。VRChat 公式が有用な非公式資料として案内しているが、正確性と将来互換性は保証されない。
4. **本製品の推論**: 上記から導いた検知方法、待機値、表示語。API の事実と混同しない。

認証済み実アカウントを開発者から受領する調査は行わない。endpoint の動作確認は偽 API と、最終利用者本人のブラウザでの受け入れ確認に分ける。

## 2. 参照 URL

### 2.1 VRChat 公式

- [VRChat Creator Guidelines](https://hello.vrchat.com/creator-guidelines)
- [VRChat 公式 Web ログイン](https://vrchat.com/home/login)
- [VRChat Community Guidelines](https://hello.vrchat.com/community-guidelines)

Creator Guidelines の「API Usage / Bots」が本製品に直接関係する。同ページは 2026-08-17 の閲覧時点で更新日を 2025-04-15 と表示していた。方針は変更され得るため、各リリース前に再確認する。

### 2.2 VRChat API の非公式資料

- [VRChat.community トップ](https://vrchat.community/)
- [Login and/or Get Current User Info](https://vrchat.community/reference/get-current-user)
- [CurrentUser schema](https://raw.githubusercontent.com/vrchatapi/specification/main/openapi/components/schemas/CurrentUser.yaml)
- [List Favorites](https://vrchat.community/reference/get-favorites)
- [List Favorite Groups](https://vrchat.community/reference/get-favorite-groups)
- [FavoriteGroup schema](https://raw.githubusercontent.com/vrchatapi/specification/main/openapi/components/schemas/FavoriteGroup.yaml)
- [List Favorited Worlds](https://vrchat.community/reference/get-favorited-worlds)
- [WorldID schema](https://raw.githubusercontent.com/vrchatapi/specification/main/openapi/components/schemas/WorldID.yaml)
- [FavoritedWorld schema](https://raw.githubusercontent.com/vrchatapi/specification/main/openapi/components/schemas/FavoritedWorld.yaml)
- [Get World by ID](https://vrchat.community/reference/get-world)
- [Websocket API / Pipeline](https://vrchat.community/websocket)
- [コミュニティ OpenAPI specification](https://github.com/vrchatapi/specification)
- [生成 SDK のブラウザ利用説明](https://github.com/vrchatapi/vrchatapi-dart/blob/main/vrchat_dart_generated/README.md)

これらは VRChat 公式 API ドキュメントではない。Creator Guidelines 自身が community の非公式ドキュメントに言及し、「正確で規則を尊重する傾向がある」が利用は自己責任である旨を説明している。

### 2.3 Chrome / Edge 公式

- [Manifest V3 の概要](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
- [Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
- [Declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- [Storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)
- [Chrome Extensions permissions / unlimitedStorage](https://developer.chrome.com/docs/extensions/reference/permissions-list)
- [Extension Service Worker への移行](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers)
- [chrome.alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [chrome.notifications](https://developer.chrome.com/docs/extensions/reference/api/notifications)
- [chrome.declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- [Microsoft Edge へ Chrome 拡張を移植する](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/port-chrome-extension)
- [Microsoft Edge の対応 Extension API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)

## 3. VRChat 公式資料から確認できた事実

以下は Creator Guidelines の記述から直接確認できる事実である。

### 3.1 API の位置付け

- VRChat は API を一般利用向けに公式文書化していない。
- endpoint は予告や通知なく追加、削除、形式変更、移動され得る。
- community が作成した非公式ドキュメントがあり、VRChat はそれを有用な情報源として案内しているが、公式に認可・保証してはいない。
- 規則を守る限り API と対話する application を作ること自体は禁止されていない。
- 非公式 application の API 利用について VRChat Support はサポートしない。

### 3.2 認証情報

- application は利用者へログイン情報を要求してはならない。
- VRChat credentials には username、password、login/auth token、session data が含まれ、要求・保存してはならない。
- Creator Guidelines の記述時点で OAuth は提供されていない。
- user account による API 操作は、その利用者の端末と IP から行われることが前提とされている。

### 3.3 負荷制御

- 繰り返し無制限に要求してはならない。
- 変化の少ないデータは適切に cache する必要がある。
- HTTP error を適切に処理し、429 後に要求を続けてはならない。
- rate limit と error 時の backoff が必要である。
- 定期 polling を毎時 0 分などの固定時刻に揃えてはならず、random offset または tool 開始時刻を基準にする必要がある。

### 3.4 識別

- application は User-Agent で明確に識別されなければならない。
- 指定形式は `applicationName/Version contactInfo` である。

本製品では `vrc_favworld_check/<manifest version> https://github.com/Na2ki-BB/vrc_favworld_check` を使用する。contactInfo は公開 repository とし、利用者の情報は含めない。

## 4. Chrome / Edge 公式資料から確認できた事実

### 4.1 Manifest V3

- Manifest V3 は background page を必要時だけ動く Service Worker に置き換える。
- Service Worker は終了し得るため、状態を global variable にだけ置けず、timer は `chrome.alarms` へ置き換える必要がある。
- Manifest V3 は remotely hosted code を許可せず、実行コードを package に含める必要がある。
- Microsoft Edge は Chrome の拡張 API と manifest key の多くに code compatibility を持つが、使用 API ごとの対応確認と Edge 実機テストは必要である。

### 4.2 Cross-origin fetch と host permission

- extension Service Worker と extension page は、manifest の host permission があれば extension origin 外へ `fetch` できる。
- content script は host permission があっても page origin の same-origin policy に従う。
- `https://vrchat.com/*` と `https://api.vrchat.cloud/*` のhost permissionは固定source Cookieの読取りとAPI fetchに使い、`https://vrchat.cloud/*` はAPIへ届き得る親domain Cookieを競合として検出するためだけに使う。`<all_urls>` は不要である。
- host permission は対象 host に対する fetch 能力を与えるため、最小 host に限定する必要がある。

### 4.3 Cookie

- host permission がある extension から第三者 origin への network request は、SameSite の扱いで同一 site とみなされ得る。
- この特例は network request に対するもので、`document.cookie` による値の読出しとは別である。
- third-party Cookie のブラウザ設定やポリシーの影響は残る。
- `chrome.cookies` API で Cookie を取得・変更する場合は `cookies` permission が必要である。
- `partitionKey` を指定しないCookie API操作は非partitioned Cookieだけを対象とし、任意partitionを一括列挙する指定はない。
- Promise版 `chrome.cookies.get` はCookie未検出時に `undefined` を返す。`auth` の未検出は認証不足、任意の `twoFactorAuth` の未検出は不在として扱い、API故障へ誤分類しない。

対象実機で確認した307→401により、host permissionと `credentials: "include"` だけでは `vrchat.com` のCookieを別domainのAPIへ送れないことが分かった。本製品は `cookies` permissionを追加し、固定名 `auth` と任意の `twoFactorAuth` だけを同期中の `api.vrchat.cloud/api/1/` 用Cookieへ一時複製する。全Cookie列挙、値の永続化、環境変数化、ログ出力は行わない。

2026-08-23の対象実機では、sourceの両Cookieは `vrchat.com` のhost-only、path `/`、HttpOnly、SameSite=Lax、非partitionedとして確認できた一方、Secure属性は付いていなかった。`0.1.2`はsourceにもSecureを必須として同期前に停止したため、`0.1.3`ではsourceを固定HTTPS URLから読むだけとし、API側の一時Cookieだけを常にSecure・HttpOnly・SameSite=Strictへ固定する。Cookie値は確認・記録していない。

### 4.4 保存

- extension の IndexedDB は extension origin の保存領域であり、通常の browsing history / cache 消去とは異なる永続性を持つ。
- IndexedDB は Service Worker から使用できる。
- 既定では quota 制限と storage pressure による eviction があり得る。
- `unlimitedStorage` permission は IndexedDB を quota 制限と eviction から除外する。消失後に再取得できない履歴を守るため、本製品では必須とする。

### 4.5 User-Agent

- Declarative Net Request の `modifyHeaders` rule は送信前の request header を変更できる。
- `user-agent` は request header の対応対象に含まれる。
- rule は request URL、domain、initiator、resource type、method で限定できる。

JavaScript `fetch` の任意 header として User-Agent を直接扱わず、拡張自身の GET API 要求だけに一致する動的 DNR rule を使う設計を採用する。

## 5. 非公式 API 資料から確認できた記述

ここでの「確認」は、VRChat.community がそう記述していることを意味し、VRChat が互換性を保証したという意味ではない。

### 5.1 API base

OpenAPI 資料の server base は `https://api.vrchat.cloud/api/1` である。一方、生成 SDK のブラウザ利用説明は、`https://vrchat.com/home` へログインしたブラウザでは `https://vrchat.com/api/1/auth/user` を開くよう案内している。

2026-08-23の対象Chrome実機では、公式Webログイン後の通常タブで `https://vrchat.com/api/1/auth/user` を開くとcurrent userが表示された一方、拡張Service Workerから同URLをGETすると `https://api.vrchat.cloud/api/1/auth/user` への307となった。`redirect: "manual"` を維持して追従しなかった場合も、API hostを直接GETした場合も401 `Missing Credentials` だった。Cookie値や利用者情報本文は記録していない。

この結果とOpenAPIのserver baseを合わせ、本製品はAPI baseを `https://api.vrchat.cloud/api/1` に戻し、origin差だけを限定Cookie Bridgeで埋める。CORSの失敗ではなく、ログインCookieのdomainが異なることによる資格情報欠落への対処である。

### 5.2 採用 endpoint

| 目的 | Request | 資料上の認証・応答 | 本製品で使うフィールド |
| --- | --- | --- | --- |
| 既存セッション確認 | `GET /auth/user` | 有効な `auth` Cookie があれば current user、401 の記述あり | `id`, `displayName` のみ |
| お気に入りリスト名 | `GET /favorite/groups?n=100&offset={n}&ownerId={本人ID}` | auth Cookie、200 array。type絞り込みparameterはない | `id`, `name`, `displayName`, `ownerId`, `type` |
| お気に入り関係 ID | `GET /favorites?type=world&n=100&offset={n}` | auth Cookie、200 array、401。`n` は 1〜100、offset は 0 以上 | `favoriteId`, `tags`, `type` |
| お気に入り world metadata | `GET /worlds/favorites?n=100&offset={n}&releaseStatus=all` | auth Cookie、200 array、401、403。`releaseStatus` は `all|hidden|private|public` | `id`, `name`, `authorName`, `favoriteGroup`, `releaseStatus` |
| 消失候補の再確認 | `GET /worlds/{worldId}` | 200 world、404。未認証でも動くが一部 field が 0 との記述 | `id`, `name`, `authorName`, `releaseStatus` |

### 5.3 `/auth/user`

非公式資料は、有効な `auth` Cookieがある場合は追加の認証操作をせずcurrent userを返すと説明し、生成SDKはCookie名 `auth` と `twoFactorAuth` を定義している。2026-08-23に再確認した機械可読OpenAPI `CurrentUser` schemaには、新規登録時だけとの説明がある任意の `authToken` と、真偽値の `usesGeneratedPassword` が定義されている。field名だけを見てtoken/passwordを拒否する方式は正常応答を停止させ、秘密値の一時的なJSON parseも防げない。

このため本製品は次を行う。

- `Authorization: Basic` を一切送らない。
- 応答をサイズ制限付きの `unknown` としてparseし、top-level objectと必要2fieldを検査して、新しいobjectへ `id` と `displayName` だけをallowlistでコピーする。その他のfieldは名前・値・階層を走査しない。
- raw response を直ちに破棄し、repository、logger、backup へ渡さない。
- 最新OpenAPI schemaで必要2fieldの契約と追加fieldを確認し、credential-like fieldを含むfixtureでもadapter外へ2field以外が出ないことをrelease gateとする。必要2fieldの契約変更はfail closedにする。
- 401 は公式 Web への再ログイン案内へ変換する。

### 5.4 `/favorites`

非公式資料では、Favorite object は `favoriteId`、favorite record の `id`、`tags`、`type` を持つ。`type=world` で world favorite を絞り、`n=100` が資料上の最大値である。

本製品では、この endpoint の `favoriteId` 集合を「お気に入り関係の観測値」とする。world metadata の取得可否と別に保持する。

### 5.5 `/worlds/favorites`

非公式資料では、お気に入り world の検索・一覧 endpoint であり、`n` は最大 100、`offset` を受ける。`releaseStatus` の既定値は `public` で、`all` を指定できる。

2026-08-24の対象実機では、`n=100&offset=0` に対して正常な200 JSON arrayが103件返った。`0.1.5`はこの103件を受け入れたが、必須5fieldのうちID形式だけ2件が従来のcanonicalな `wrld_` + UUID検査に一致せず、完全同期には到らなかった。同じ診断で、名称、作者名、お気に入りグループ、公開状態の不正は0件と確認した。利用者は実値を共有しておらず、ID、ワールド名、作者名、Cookie、raw応答はこの確認記録へ保存していない。

コミュニティOpenAPIの `WorldID` schemaは文字列と例を示すが、UUID形式の `pattern` は宣言していない。実機の2値の意味や長期的な安定性は公開資料から確定できないため、canonical検査を製品全体で緩めない。`0.1.6`はこのendpointに限って非canonical IDを安全な一時文字列として追加検査し、ページングの重複identityとfingerprintへ残したが、対象実機では `/auth/user`、グループ、お気に入り関係、`/worlds/favorites?offset=0` がすべて200になった後、`offset=103` を要求する前に再び `API_INCOMPATIBLE` となった。値を追加収集せずに判断できる原因候補は、この追加検査または非canonical値をidentityへ残す過剰防御である。実値、ID、ワールド名、作者名、Cookie、raw応答は記録していない。

`0.1.7`では `/worlds/favorites` に限り、IDがcanonical検査に一致しない行について、そのIDを追加で型・値分類せず、コピーもしない。ページング内部の明示的にopt-inした投影だけを `{ identity: null, metadata: null }` とし、raw行自体はoffsetと総数10,000件の上限に含める。ID以外の必須fieldは全行で厳格に検査し、canonical IDの重複は拒否する。canonical IDがあるpageのfingerprintはcanonical ID列と除外件数から作り、null identityはglobalな重複検査から除外する。全行がnull identityのpageは除外件数だけで同一pageと断定せず、raw offsetの単調増加、最大100非空要求と空終端確認1要求、総数10,000件上限で終了を保証する。非空snapshot全体にcanonical metadataが1件もなければ `API_INCOMPATIBLE` とし、空の正常snapshotと混同しない。

2026-08-24の対象実機では、`0.1.7`導入後の「今すぐお気に入りを確認」が成功し、`0.1.6`で `offset=0` の200応答後に発生していた `API_INCOMPATIBLE` は再現しなかった。**推論**: 同期成功までの実装経路から、103件raw pageを処理して `offset=103` 以降へ進む経路も通過したと判断できる。ただし、同期後の一時Cookie不在はこの結果だけでは確認していない。

除外したIDはadapter内でも投影せず、IndexedDB、UI、ログ、個別API URL、JSON backupへ渡さない。`/favorites` のお気に入り関係ID、`GET /worlds/{worldId}` のURL、JSON backupは引き続きcanonical World IDだけを受け入れ、IndexedDBへ渡すIDもcanonicalなadapter出力に限定する。

本製品は `releaseStatus=all` を明示し、資料上取得可能な hidden / private を意図せず public filter で落とす可能性を減らす。ただし `all` は利用者にアクセス権のない world まで必ず返すという保証ではない。

この endpoint は名称と作者をまとめて取得するために使い、通常時の全件個別 GET を避ける。

### 5.6 `/favorite/groups`

現行コミュニティOpenAPIの `FavoriteGroup` は安定ID `id`、relationタグに対応する内部名 `name`、利用者が変更できる `displayName`、`ownerId`、`type` を持つ。`type` は world以外も返り得るため、全レコードを検証して本人所有を確認した後、`world` と `vrcPlusWorld` だけを採用する。VRC+用の内部名は現行資料上 `vrcPlusWorlds1`〜`vrcPlusWorlds4` である。

本製品はリスト名表示のためだけに上記5フィールドを新しいobjectへコピーする。raw応答、ownerの表示名、説明、visibilityなどは保存しない。重複ID、重複内部名、owner不一致、未知typeはグループsnapshot不正として既存対応表を維持する。

この補助endpointだけの403、schema不正、ページング不整合は、既存リスト名を保持したままワールド同期を続ける。401、429、network、5xx、redirectは共通の安全・負荷境界なので同期全体を中止する。

### 5.7 `/worlds/{worldId}`

非公式資料では、成功時に world object、見つからない場合に 404 を返す。world object は `id`、`name`、`authorName`、`releaseStatus` などを持つ。

資料は 404 が「削除」「非公開」「利用者権限」「一時的不整合」のどれを意味するかを区別していない。したがって、本製品は 404 を「この認証状態で現在 world 情報を取得できない」という観測にだけ使う。

## 6. 確認できない事項

以下は公開資料だけでは確定できない。

- 実際の rate limit の request 数、時間窓、account / IP / endpoint ごとの差。
- `Retry-After` が常に返るか、単位や最大値が一定か。
- `/favorites` と `/worlds/favorites` が同じ時点の原子的 snapshot を返すか。
- `/favorite/groups` と2つのワールド一覧が同じ時点の原子的 snapshot を返すか。
- pagination 中にお気に入りが更新された場合の重複・欠落挙動。
- API が短い非空ページの後にもデータを返すか、および空ページ以外の明示的な終端表現。
- private / deleted / moderation / access control の各場合に、2 endpoint と個別 GET がそれぞれ何を返すか。
- Favorite relation が world 削除後も残る期間。
- 404 と 403 の厳密な意味、および今後追加される status。
- `vrchat.com` の `auth` / `twoFactorAuth` の名前、Secure、expiry、Partitioned属性が将来も限定Bridgeと両立するか。
- Chrome と Edge のすべての Cookie policy / enterprise policy で既存セッション送信が成功するか。
- endpoint / response schema の将来互換性。

不明点を推測で埋めず、schema 不正や未知の status では確定状態を更新しない。

## 7. 設計上の推論と採用判断

ここからは API が保証する事実ではなく、本製品が安全側に倒すための設計判断である。

### 7.1 Chrome / Edge 拡張を選ぶ

**推論**: 公式Webログインの固定Cookie名だけをブラウザ内で短時間橋渡しし、`unlimitedStorage`で保護したIndexedDB、alarm、通知、UI、JSON downloadを1 packageで実現できる。利用者へcredential入力、環境変数、別アプリ、開発者DBを要求しないため、本要件ではnative appやスマートフォンappより適する。

**限界**: ブラウザ終了中は動かず、Store 公開前の sideload は初心者に難しい。製品配布は Chrome Web Store / Edge Add-ons を第一経路にする。

### 7.2 2 endpoint を併用する

**推論**: `/favorites` は関係 ID、`/worlds/favorites` は表示 metadata の情報源として性質が異なる。両方を比較すれば「関係はあるが metadata がない」と「関係自体が一覧にない」を混同しにくい。

**限界**: どちらも非公式で、内部的に同じ filter を受ける可能性がある。差分は断定材料ではなく再確認候補にする。

### 7.3 2 回連続確認する

**推論**: snapshot token のない pagination、同期中の利用者操作、一時的な backend 不整合による 1 回限りの欠落を確定通知しないため、連続する完全スナップショット 2 回を条件にする。

**限界**: 誤検知確率は下がるがゼロにはならず、検知は最大で次回同期まで遅れる。

### 7.4 状態を 2 軸にする

**推論**: favorite relation の有無から分かるのは「一覧で観測できるか」であり、world GET から分かるのは「現在情報へアクセスできるか」である。所属状態とアクセス状態を分けることで、手動解除と削除・非公開の推測を避けられる。

採用する表示は次のとおりである。

| 観測 | 採用表示 | 表示しない語 |
| --- | --- | --- |
| relation が 2 回連続で不在、world GET 200 | お気に入り一覧にありません（ワールドは閲覧可能です） | 手動解除した |
| world GET 404 が 2 回連続 | 現在アクセスできません | 削除済み、非公開 |
| name が成功 metadata で変化 | 名前が変更されました | 変更理由 |
| 401 / 429 / 5xx / network error | 同期できませんでした。履歴は変更していません | world が消えた |

### 7.5 request 間隔と probe 上限

**推論**: 公式資料に具体的な制限値がないため、要求を直列化して開始間隔を約 2 秒、定期同期を 12 時間 + 0〜60 分 jitter、手動 cooldown を 5 分、個別 probe を 1 同期 20 件に制限する。通常は bulk 2 系統だけで数百件を処理できる。

これらは VRChat の公表 rate limit ではない。実運用で 429 が発生する場合は要求を減らす方向にだけ調整する。

Chrome 公式の [Migrate to a service worker: Keep the service worker alive](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers#keep-sw-alive) は、30 秒を超える長時間処理について、処理中だけ 25 秒ごとに `chrome.runtime.getPlatformInfo()` を呼び、promise 完了時に interval を解除する `waitUntil` 例を示している。本ツールは要求間隔を意図的に空けるため、同期イベントに限ってこの方法を使う。常時 keep-alive には使わない。

### 7.6 429 / error backoff

**推論**: 429 は inline retry せず同期全体を即時停止する。`consecutiveRateLimits` を 7 で飽和させ、30 秒開始・最大 30 分の指数 delay を計算する。妥当な `Retry-After` と比較して遅い方に jitter を加え、`backoffUntil` とともに永続化する。alarm 後は途中からではなく新しい完全同期を開始し、完全同期成功時だけ counter をリセットする。

`Retry-After` の異常に大きい値や過去日時はそのまま信用せず、安全な範囲で検証する。429 中に別 endpoint へ処理を続けない。5xx / network error だけは短い jitter 付きで最大 2 回再試行する。

### 7.7 次回 alarm を全終了結果で登録する

**推論**: Manifest V3 Service Worker は終了し得るため、繰り返し timer や成功時だけの再登録では自動同期が途切れる。自動同期が有効なら、同期のアプリケーション制御下にある全終了経路の `finally` で既存の固定名 one-shot alarm を次の 1 件へ置換する。

| 終了結果 | 次回時刻 |
| --- | --- |
| 完全同期成功 | 現在 + 12 時間 + 0〜60 分 jitter |
| 429 | 永続化した `backoffUntil` |
| offline / 5xx の最大再試行後 | 現在 + 30〜60 分 jitter |
| 401 / schema 不正 / その他の失敗 | 現在 + 12 時間 + 0〜60 分 jitter |

自動同期が無効なら同名 alarm を解除する。ブラウザ強制終了では `finally` 自体を保証できないため、install / startup handler が永続化した `nextSyncAt` を使って欠けた alarm を修復し、保存時刻が過去なら現在から 1〜10 分 jitter 後へ送る。これらは VRChat API の仕様ではなく、本製品の継続実行と要求抑制のための設計判断である。

### 7.8 raw auth response を保存しない

**推論**: `CurrentUser` にはcredential-like fieldが存在し得るため、汎用DTOの丸ごと保存やJSON debug logは漏えいにつながる。bounded parse後、認証adapter内で `id` と `displayName` だけをallowlist projectionし、その他を走査せず破棄する。JSON parse中のraw値はGCまでJavaScript heapへ一時的に存在し得るが、現行の後段denylistでもこれは防げない。

### 7.9 ページング終端

**推論**: 非公式資料は `n` と `offset` を定義するが、短い page が終端であることも、実APIが厳密に `n` 件以下を返すことも保証していない。したがって、100件未満でも、実機で確認した `/worlds/favorites` の100件超でも、非空ならoffsetをraw実取得件数だけ増やして継続し、空pageだけを終端とする。noncanonical ID行を投影せず除外しても、offsetには除外後の件数を使わない。

各endpointは最大10,000データ件、100非空要求、その後の空終端確認1要求を上限とする。`/worlds/favorites` の過剰返却は残り総数枠を投影前に検査し、他endpointは1ページ100件上限を維持する。最大101要求で空pageを確認できない場合、canonical IDを含む同一非空fingerprintが反復した場合、canonical IDが重複した場合、offsetが停滞した場合は完全snapshotとみなさない。全件が除外対象のpageは除外件数だけをfingerprintとして重複判定せず、raw offsetと上限で停止を保証する。

### 7.10 リスト表示名を安定IDと分離する

**推論**: `displayName` は利用者が自由に変更できるため、ワールド所属の正本やDB keyには使えない。`groupId`を安定key、`name`をrelationタグ対応、`displayName`を表示と履歴に使う。リスト名変更とワールド移動は別の変化として扱う。

**限界**: endpointは非公式で部分的に利用不能になり得る。表示名だけが取得できない場合は前回値または内部名へfallbackし、主要な消失検知を止めない。

### 7.11 通知を厳密な at-most-once にする

**推論**: `chrome.notifications` の呼出しと IndexedDB 更新を同一 transaction にできないため、OS 通知の exactly-once は保証できない。重複通知を避けるため、通知 API の前に event の `notificationClaimedAt` を確定し、成功、明示的失敗、crash のすべてで claim を永久に維持する。成功時は `notifiedAt`、明示的失敗時は秘密を含まない固定 `notificationError` を記録できるが、どちらも再 attempt の条件にしない。

**限界**: claim 後・通知表示前の crash や通知 API の明示的失敗では OS 通知が欠落し得る。履歴 event を正本として UI に残し、通知は補助経路と位置づける。

### 7.12 redirect を追従しない

**推論**: 非公式 endpoint が移動・侵害されたとき既存 Cookie 付き要求を別 URL へ自動追従させないため、全 fetch を `redirect: "manual"` に固定する。3xx または opaque redirect は同期失敗とし、移転先が同じ host でも自動追従しない。

## 8. WebSocket を採用しない理由

VRChat.community の Pipeline 文書は `wss://pipeline.vrchat.cloud/?authToken=...` の query parameter に auth Cookie 値を必要とすると説明している。また、掲載されている event は notification、friend、user update 等が中心で、お気に入り world 一覧の完全 snapshot や名称変更を保証するものではない。

採用しない理由は次のとおりである。

1. 接続には auth token 値の読出し・URL 埋込みが必要となり、本製品の「token を取得・保存しない」方針に反する。
2. 履歴の初回ベースラインと取りこぼし回復には結局 HTTP snapshot が必要である。
3. 12 時間程度の検知要件は HTTP polling で満たせる。
4. 常時接続は Manifest V3 Service Worker の lifecycle と相性が悪い。
5. favorite / world visibility の確実な event が公開資料から確認できない。

将来、VRChat が token を application に渡さない公式イベント API を提供し、HTTP では必須要件を満たせないことが確認された場合にだけ再評価する。

## 9. HTTP 応答の扱い

| 応答 | Adapter の分類 | ドメイン状態への影響 |
| --- | --- | --- |
| 200 + schema valid | success | 完全取得後に反映可能 |
| 200 + schema invalid | `API_INCOMPATIBLE` | 全体を中止、状態不変 |
| 401 | `AUTH_REQUIRED` | 中止、状態不変、公式ログイン案内 |
| 認証を示す 403 | `AUTH_REQUIRED` | 中止、状態不変 |
| その他 403 | `FORBIDDEN` | 中止、状態不変。アクセス不能断定に使わない |
| 個別 world の 404 | `WORLD_NOT_FOUND` | 有効な probe 観測。2 回連続で「現在アクセスできません」 |
| 一覧 endpoint の 404 | `API_INCOMPATIBLE` | 中止、状態不変 |
| 429 | `RATE_LIMITED` | 同期を即時停止。counter / backoffUntil を保存し、alarm 後に新しい完全同期。状態不変 |
| 5xx | `SERVER_ERROR` | 短い jitter 付きで最大2回再試行、上限後は状態不変 |
| timeout / DNS / offline | `NETWORK_ERROR` | 短い jitter 付きで最大2回再試行、上限後は状態不変 |
| 3xx / opaque redirect | `UNEXPECTED_REDIRECT` | `redirect: "manual"` で追従せず中止、状態不変 |

error body の文言は不安定で機密を含む可能性があるため、UI と永続 log の判定根拠にしない。認証を示す 403 の判定方法が安定しない場合は、403 全体を generic failure とし公式サイト確認を促す。

## 10. 実装前後の確認項目

### 10.1 資格情報なしで自動確認できる項目

- manifest に不要権限がないこと。
- manifest に履歴 IndexedDB 保護用 `unlimitedStorage` があること。
- `cookies` permissionとhost permissionが `vrchat.com` / `vrchat.cloud` / `api.vrchat.cloud` だけで、Cookie API利用が固定名2つと非秘密markerのBridge境界に隔離されていること。root `vrchat.cloud` は親domain競合検査だけに使われ、network fetch先ではないこと。
- source欠落、target競合、partitioned、set/remove失敗、古いmarker、並行呼出しをfake Cookie APIで検査し、値がerror、DB、backup、DNRに現れないこと。
- DNR rule が extension 自身の VRChat GET API にだけ一致すること。
- fake API による pagination、429、401、404、schema change の処理。
- `/worlds/favorites` の103件raw pageにnoncanonical IDを2件含むfixtureで、値を投影・分類せず2件をメタデータ出力から除外しつつ次を `offset=103` とすること。nullable identityは明示opt-inしたこのendpointだけで使い、nullをglobal重複検査から除外すること。canonical IDを含むpageはcanonical ID列と除外件数でfingerprintを作り、全件nullの同数pageは誤って反復判定せずraw offsetと上限で終了すること。除外IDが戻り値、DB、UI、log、backup、個別API URLに現れず、他の必須field不正、canonical ID重複、非空snapshot全体のcanonical metadata 0件はfail closedになること。
- 現行OpenAPIの `authToken`、`usesGeneratedPassword` とnestedのcredential-like fieldを含む `/auth/user` fixtureで同期が成功し、adapterの戻り値が `id` / `displayName` だけで、DB / log / backupに秘密値が残らないこと。必要2fieldの不正とbounded JSON境界はfail closedになること。
- 2 回確認、復帰、名称変更、transaction rollback。通知は成功、明示的失敗、claim 後 crash の各 fixture で claim を解除せず、Service Worker 再起動後も同一 event の attempt が最大 1 回であること。
- 短い非空 page の継続、空 page 終端、101要求上限、fingerprint 反復、offset 停滞を確認すること。
- 3xx fixture を `redirect: "manual"` で追従しないこと。
- 自動同期を有効にした success、429、offline / 5xx 上限、401 / schema / その他の終了 fixture ごとに、名前付き one-shot alarm が規定時刻の 1 件へ置換されること。無効時は解除されること。
- Chrome / Edge の unpacked extension で IndexedDB、alarm、notification、backup が動くこと。

### 10.2 利用者本人の環境でだけ確認する項目

- `0.1.5`で `/auth/user` 200、`/worlds/favorites` 103件の受信まで進み、ID形式だけ2件不一致で完全同期未達だったという匿名・集計の観測を維持すること。実値やraw応答は記録しない。
- `0.1.6`ではService Workerからの `/auth/user`、グループ、お気に入り関係、`/worlds/favorites?offset=0` はすべて200だったが、`offset=103` の要求前に `API_INCOMPATIBLE` となった匿名・集計の観測を維持すること。実値やraw応答は記録せず、`0.1.6`を完全同期候補にしないこと。
- 公式Webログイン後、`0.1.7`でService Workerから `https://api.vrchat.cloud/api/1/auth/user` が200となり、`/worlds/favorites` の103件raw pageとnoncanonical ID行の非投影を含む全ページを空終端まで取得して完全同期に成功すること。
- 同期中だけtargetの一時Cookieが存在し、同期後に認証Cookieとmarkerが残らないこと。Chrome完全終了後は認証Cookieを能動削除せず、設定時の期限切れ後に古いmarkerだけを回収できること。
- 実応答にcredential-like fieldがあっても値やraw bodyを撮影・記録せず、完全同期が成功し、adapter外、DB、backup、logへ `id` / `displayName` 以外が流れない設計と自動テストが維持されていること。
- `/favorites` と `/worlds/favorites?releaseStatus=all` が現在のお気に入り件数を取得できること。
- third-party Cookie を厳しく制限した Chrome / Edge での案内が適切か。
- 実データ数で同期が 5 分以内に終わり、429 を誘発しないこと。

この確認で token、Cookie、API response body を画面撮影、ログ採取、issue 添付しない。問題報告には固定 error code、app/browser version、発生時刻、件数だけを使用する。

## 11. 変更監視

各リリース前に次を再確認する。

- Creator Guidelines の更新日と「API Usage / Bots」の変更。
- community OpenAPI の `/auth/user`、`/favorite/groups`、`/favorites`、`/worlds/favorites`、`/worlds/{id}` の差分。
- 公式Webのsource Cookie名 `auth` / `twoFactorAuth` とAPI base `api.vrchat.cloud/api/1` が限定Bridgeで引き続き利用できること。
- Chrome の Cookie / partitioning、DNR header modification、Manifest V3 Service Worker lifecycle の変更。
- Edge の使用 API 対応状況。

互換性が確認できない変更では、古い推測で継続せず同期を fail closed にする。履歴閲覧と JSON export は API 障害中も利用可能に保つ。
