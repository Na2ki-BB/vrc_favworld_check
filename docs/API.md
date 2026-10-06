# API連携仕様

VRC Favorite World Historyが使うAPIと、取得した情報の扱いを説明します。本書の上限やエラー分類は本製品の実装仕様です。VRChatが保証するAPI契約やレート制限値ではありません。

実装の中心は [`api.js`](../extension/lib/api.js)、[`sync-service.js`](../extension/lib/sync-service.js)、[`schedule.js`](../extension/lib/schedule.js) です。Cookieと権限の詳細は[セキュリティ設計](SECURITY.md)を参照してください。

## 利用方針

[VRChat Creator GuidelinesのAPI Usage / Bots](https://hello.vrchat.com/creator-guidelines)は、資格情報を利用者に求めないこと、利用者自身の端末・IPからの通信、キャッシュ、要求間隔の制御、429での停止、ランダムな実行時刻、識別可能なUser-Agentを求めています。APIは一般向けの公式公開仕様ではなく、予告なく変更される可能性があります。

エンドポイントの参考資料は、同Guidelinesから案内されている非公式の [VRChat.community](https://vrchat.community/) と [コミュニティOpenAPI仕様](https://github.com/vrchatapi/specification)です。本製品は既存の公式Webセッションを使った低頻度のHTTP取得を行います。独自ログイン、Basic認証、ログアウト、書き込みAPI、WebSocketは使いません。

## 通信の共通設定

| 項目 | 設定 |
| --- | --- |
| APIベースURL | `https://api.vrchat.cloud/api/1` |
| メソッド | `GET`のみ、リクエスト本文なし |
| 認証 | `credentials: "include"`。処理中だけAPI用一時Cookieを使用 |
| キャッシュ／リダイレクト | `cache: "no-store"`／`redirect: "manual"` |
| 応答形式 | JSON。media type、UTF-8、サイズ、必要フィールドを検証 |
| 応答上限 | 1要求5MiB、通常の文字列4,096コードポイント、タグ100件 |
| タイムアウト | 通常15秒。画面のログイン状態確認は5秒 |
| User-Agent | `vrc_favworld_check/<manifest version> https://github.com/Na2ki-BB/vrc_favworld_check` |

User-AgentはChromeのDNRで拡張自身のAPI GETだけに設定します。ルールを登録・検証できなければ、Cookieの橋渡しもAPI取得も開始しません。

## 使用するエンドポイント

| 目的 | GETパス | 採用する情報 |
| --- | --- | --- |
| 本人確認 | `/auth/user` | `id`、`displayName`。別途 `requiresTwoFactorAuth` の有無を判定 |
| お気に入りリスト | `/favorite/groups?n=100&offset={offset}&ownerId={userId}` | `id`、`name`、`displayName`、`ownerId`、`type` |
| お気に入り関係 | `/favorites?type=world&n=100&offset={offset}` | `favoriteId`、`tags`、`type` |
| ワールド情報の一括取得 | `/worlds/favorites?n=100&offset={offset}&releaseStatus=all` | `id`、`name`、`authorName`、`favoriteGroup`、`releaseStatus`、任意の `thumbnailImageUrl` |
| 個別ワールドの確認 | `/worlds/{worldId}` | `id`、`name`、`authorName`、`releaseStatus`、任意の `thumbnailImageUrl` |

### 本人確認と画面のログイン状態

`/auth/user` は、必要なユーザーIDと表示名だけを後続処理へ返します。応答に認証関連情報が含まれても、未知フィールドを列挙・保存しません。妥当な `requiresTwoFactorAuth` があれば、追加認証が必要な状態として扱います。利用者は公式サイトで認証を完了します。[参考: CurrentUser schema](https://raw.githubusercontent.com/vrchatapi/specification/main/openapi/components/schemas/CurrentUser.yaml)

画面のログイン状態確認は履歴同期とは別の観測です。再試行なし・5秒の要求を使い、結果を通常60秒間キャッシュします。ユーザーIDやワールド履歴、最終同期成功時刻を書き換えません。同期・消去と競合する場合は確認を開始せず、429の待機時間は同期と共有します。

表示用の状態は、確認済み、ログインが必要、2FAが必要、確認不能、処理中、待機中を区別します。Cookie欠落と401はログインが必要な根拠に使いますが、403、通信障害、Cookie競合、後処理失敗をログアウトの証拠にはしません。

### お気に入り関係とワールド情報

`/favorites` の `favoriteId` を「お気に入りに含まれているか」の情報源とし、`/worlds/favorites` を名称・作者・リスト・画像などの情報源にします。これにより、関係だけが残り、ワールド情報を取得できない状態も記録できます。

ワールドIDは `wrld_` とUUIDの形式を基本とします。ただし、`/worlds/favorites` だけはこの形式に合わない行を除外して処理を続けます。そのIDを解釈し直したり、保存・表示・ログ出力・個別要求に使ったりしません。他の必須フィールドは除外行でも検証し、生の行数はページングの件数に含めます。非空の全応答から利用可能なワールド情報が1件も残らない場合は同期を止めます。

`releaseStatus` は `public`、`private`、`hidden` のいずれかを検査します。`releaseStatus=all` は、権限のないワールドまで必ず取得できるという意味には扱いません。サムネイルURLは任意情報で、不正・欠落の場合も名称や状態の同期は続けます。

### お気に入りリスト

グループは全行のID、本人の `ownerId`、内部名、表示名、typeを検証し、`world` と `vrcPlusWorld` だけを採用します。`avatar` と `friend` は検証後に除外し、未知type、重複ID・内部名、別ユーザー所有の行は拒否します。

`id` を安定した識別子、`name` をワールドのタグとの対応、`displayName` を表示と名称履歴に使います。所属タグは `/favorites` の関係情報を優先し、`/worlds/favorites` のタグと矛盾する場合は以前のタグを保持して、その同期では移動履歴を作りません。主要な2つの一覧が参照するリスト名を取得結果が網羅しない場合も、不完全な取得として以前のリスト情報を保持します。

この補助APIだけの403、不正な形式、ページング異常では、主要なワールド同期を続けられます。401、429、通信・サーバー障害、リダイレクトでは同期全体を止めます。

画面用のリスト枠はAPIの返却数だけで決めません。通常4枠を用意し、保存済みグループまたはワールドのタグに `vrcPlusWorlds1`〜`vrcPlusWorlds4` があれば8枠を表示します。これは [`favorite-groups.js`](../extension/lib/favorite-groups.js) による表示上の補完です。

### 個別取得と状態の確定

一覧で確認できない候補などに対し、個別取得を1同期最大20件行います。空き枠は、お気に入り一覧の外にある保存済み・閲覧可能なワールドの画像補完にも使います。

404は「この認証状態では現在情報を取得できない」という観測です。削除、非公開、権限制限、一時的な不整合の区別には使いません。お気に入り一覧からの不在とアクセス不可は別の状態として保持し、連続する完全同期2回で確定します。名称の変更は正常に取得できた情報で記録します。

初回同期は比較の基準を保存します。最初の記録より前の名称や、確認と確認の間に起きて元に戻った変化は復元できません。判定の実装は [`domain.js`](../extension/lib/domain.js) を参照してください。

## ページング

一覧は `n=100` で要求し、空配列が返るまで取得します。短い非空ページだけでは終了と判断しません。

- offsetは採用件数ではなく、返却された生の行数だけ進めます。
- `/worlds/favorites` だけは100件を超えるページを許容します。他の一覧では拒否します。
- 各一覧は合計10,000件、非空ページ100回と終端確認1回を上限とします。HTTP再試行回数は別枠です。
- 重複ID、識別可能な同一ページの反復、進まないoffset、上限超過は拒否します。除外された非標準IDは重複検査に使いませんが、総件数と要求回数の上限には含めます。

主要一覧を完全取得できなければ、ワールド状態を更新しません。ただし、複数ページや別エンドポイントの結果が同時点のスナップショットである保証はなく、取得中の変更を完全には排除できません。

## 要求間隔と再開

| 処理 | 本製品の制限 |
| --- | --- |
| JSON API要求 | 直列実行、開始間隔2秒以上 |
| 手動同期 | 通常5分の再実行待ち |
| 定期同期 | 前回処理後12〜13時間 |
| 起動時の期限切れ・欠落予定の修復 | 1〜10分後に分散 |
| 通信障害・5xxの要求再試行 | 遅延を入れて最大2回追加 |
| 通信障害・5xxで同期失敗後 | 自動同期が有効なら30〜60分後 |
| 429 | その処理の追加要求を止め、待機期限を保存 |

429の待機は30秒から最大30分まで増やす指数的な遅延と、妥当な `Retry-After` のうち長い方に0〜10%を追加します。`Retry-After` は1〜86,400秒、または1秒〜24時間先の日付を受理します。待機中は手動同期やログイン確認でもAPIを呼びません。

次回時刻はIndexedDBへ保存し、固定名の単発アラームで再開します。自動同期が有効な処理中には10分後の復旧用アラームを置き、通常終了時に次回予定へ置換します。Service WorkerやChromeが止まった場合は、起動時に予定を修復します。アラームは指定時刻ちょうどの実行を保証するものではありません。

## HTTP応答とエラー

以下はAPI層の分類です。画面向けには同期サービスが固定の表示用エラーへ変換します。エラー本文を状態判定やログに使いません。

| 応答 | API層の扱い |
| --- | --- |
| 200・妥当なJSON | 必要な情報だけを返す |
| 200・2FA要求 | `TwoFactorRequiredError`（`AUTH_REQUIRED`） |
| 200・不正な形式、未知の応答 | `API_INCOMPATIBLE` |
| 401 | `AUTH_REQUIRED` |
| `/auth/user` の403 | `AUTH_REQUIRED`。画面の独立したログイン確認では「確認不能」 |
| その他の403 | `FORBIDDEN`。補助リストAPI以外では同期停止 |
| 個別ワールドの404 | `{ status: 404, world: null }` を返し、連続確認の観測に使う |
| 一覧APIの404 | `API_INCOMPATIBLE` |
| 429 | `RATE_LIMITED`。同じ処理で再試行しない |
| 5xx | `SERVER_ERROR`。上限付きで再試行 |
| タイムアウト・通信失敗 | `NETWORK_ERROR`。上限付きで再試行 |
| 3xx・不透明な転送応答 | `UNEXPECTED_REDIRECT`。追従しない |
| ページ重複・取得上限超過 | `PAGINATION_INVALID` |

失敗時も待機時刻や診断用の固定状態は更新されます。「状態を変更しない」は、正常取得できていないワールドの名称や所属・アクセス状態を上書きしないという意味です。履歴保存後のCookie後処理失敗や任意の画像処理失敗は、保存済み履歴を巻き戻しません。

## 画像取得

画像はJSON APIと別の取得処理を使います。許可する元URLは、HTTPSの `api.vrchat.cloud` にある次の形式です。

- `/api/1/image/{file_UUID}/{正の整数}/{64|128|256|512|1024|2048}`
- `/api/1/file/{file_UUID}/{正の整数}/file`

CookieとRefererを付けず、APIから `files.vrchat.cloud` への転送をCSPと最終URL検査の範囲内で許容します。imageルートは `/thumbnails/` 直下の制限された単一ファイル名、fileルートは元のID・版が一致する画像パスを受理します。CDNの命名規則を公開仕様とはみなさず、署名付き転送先URLは保存しません。詳しいURL・画像の検証条件は[セキュリティ設計](SECURITY.md)を参照してください。

画像は最大辺320px、48KiB以下のWebPとして保存します。元URLが同じ保存版は再取得を省きます。画像取得の失敗で主要な履歴の保存を取り消すことはありません。

取得ジョブは1回の処理につき30秒・最大100回の試行を上限とし、画像間を250ms空けます。未完分は通常60秒以上後に続け、同じジョブの各画像は最大3回試します。定期同期を無効にしても開始済み画像ジョブは継続します。画像の429では有効な `Retry-After`、なければ30分を目安に待機します。

## 参照資料と検証範囲

- API資料: [本人確認](https://vrchat.community/reference/get-current-user)、[お気に入り](https://vrchat.community/reference/get-favorites)、[お気に入りリスト](https://vrchat.community/reference/get-favorite-groups)、[お気に入りワールド](https://vrchat.community/reference/get-favorited-worlds)、[個別ワールド](https://vrchat.community/reference/get-world)
- ブラウザ仕様: [Cookie API](https://developer.chrome.com/docs/extensions/reference/api/cookies)、[ストレージとCookie](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)、[クロスオリジン通信](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)、[DNR](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
- 実装テスト: [`api.test.js`](../tests/api.test.js)、[`auth-status.test.js`](../tests/auth-status.test.js)、[`auth-cookie-bridge.test.js`](../tests/auth-cookie-bridge.test.js)、[`schedule.test.js`](../tests/schedule.test.js)、[`thumbnail.test.js`](../tests/thumbnail.test.js)、[`background.test.js`](../tests/background.test.js)

レート制限の具体値、ページ間の一貫性、403・404の背景、Cookieの将来の属性、すべてのChrome設定での動作は保証できません。公開資料と模擬応答のテストに加え、配布前には実Chromeで認証、完全同期、Cookieの後処理、画像取得を確認します。実データの認証値・応答本文・署名付きURLをテスト用データや問題報告へ転載しないでください。
