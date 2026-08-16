# vrc_favworld_check 基本・詳細設計

## 1. 設計方針

`vrc_favworld_check` は Chrome / Edge Manifest V3 拡張として動作し、VRChat API との通信、差分検知、履歴保存、表示、通知を利用者のブラウザ内だけで完結させる。

中心となる設計原則は次のとおりである。

1. **既存セッションを借りる**: 認証画面や資格情報保管を作らず、VRChat 公式 Web サイトで成立したブラウザセッションを HTTPS 要求に利用する。
2. **一覧をまとめて読む**: 通常同期は 2 種類のページング API を使い、全ワールドの個別取得を避ける。
3. **欠落を直ちに断定しない**: お気に入り所属とアクセス可否を別の軸として持ち、2 回連続した根拠で確定する。
4. **完全取得後に原子的に反映する**: ページング途中、認証切れ、レート制限、通信障害の結果を確定データへ混ぜない。
5. **Service Worker を常駐プロセスと考えない**: 実行予定、クールダウン、通知 claim を永続化し、再起動後に復元する。
6. **API 境界を狭くする**: API 応答から必要なフィールドだけを検証してドメイン型へ変換し、HTTP と UI を差分ロジックから分離する。

## 2. システム構成

```text
利用者
  │
  ├─ VRChat公式サイト ── ログイン・2FA ── VRChat
  │       │  ブラウザ管理の既存Cookie
  │       └────────────────────┐
  │                            │
  └─ 拡張UI ─ message ─ Service Worker ─ HTTPS GET ─ VRChat API
                         │      credentials: include
                         │
                         ├─ Sync Coordinator
                         ├─ Domain Reconciler
                         ├─ Notification Adapter
                         ├─ Alarm Scheduler
                         └─ IndexedDB
                              ├─ profiles / worlds
                              ├─ events / syncRuns
                              └─ settings / meta
```

拡張機能から開発者または第三者のサーバーへ向かう経路は存在しない。ワールド画像も API 呼び出し数と外部読込みを増やすため、MVP の必須表示には含めない。

## 3. 実行コンテキストと責務

### 3.1 Extension Service Worker

- 拡張機能の install / startup / alarm / UI message イベントを受ける。
- 同期を単一 flight（同時に 1 実行だけ）として調停する。
- VRChat API adapter、差分検知、IndexedDB transaction、通知を順に呼び、同期のアプリケーション制御下にある全終了経路の `finally` で次回 alarm を置換する。
- install / startup 時に User-Agent 用の動的 Declarative Net Request ルールを再登録する。
- install / startup 時に自動同期が有効なのに次回 alarm がなければ、永続化した `nextSyncAt` と直近結果から 1 件を修復登録する。
- 数十秒を超え得る同期イベントだけは、Chrome 公式資料の `waitUntil` 例に従い `chrome.runtime.getPlatformInfo()` を 25 秒間隔で呼んで idle timer を更新する。同期 promise の `finally` で interval を必ず破棄し、常時稼働には使わない。
- DOM や画面状態を持たない。プロセス内変数はキャッシュとしてだけ扱う。

### 3.2 Extension UI

主画面は拡張機能所有の HTML とし、次の領域を持つ。

- **ホーム**: ログイン案内、今すぐ確認、同期状態、最終成功、次回予定。
- **履歴**: 検索、状態フィルター、イベント一覧、各ワールドの詳細。
- **設定**: 定期同期、通知、エクスポート、復元。

UI は同期、外部ページを開く操作、通常設定を Service Worker の閉じた `chrome.runtime.sendMessage` command で行い、API を直接呼ばない。大量になり得る一覧照会とバックアップ入出力だけは共有 repository を直接使う。復元は全検証後の単一 transaction とし、profile 世代番号を増加させて進行中の古い同期 plan を必ず競合 abort させる。

### 3.3 API Adapter

- ベース URL を `https://api.vrchat.cloud/api/1` に固定する。
- `fetch` は `method: "GET"`、`credentials: "include"`、`cache: "no-store"`、`redirect: "manual"` を使用する。3xx を追従せず同期失敗へ変換する。
- 応答本文をログへ渡さず、endpoint ごとの allowlist schema で必要フィールドだけを抽出する。
- ページング、2 秒の要求間隔、タイムアウト、5xx / network error の短い再試行を実装する。429 は再試行せず同期全体を停止する。
- 現行 `CurrentUser` schema に credential / token / session field がないことを前提とし、`/auth/user` の raw 応答から禁止 field 名を検査した後、新しい object へ `id` と `displayName` だけをコピーして raw 応答を破棄する。
- HTTP の詳細を `AuthenticatedUser`、`FavoriteRelation`、`WorldMetadata`、`WorldProbe`、`ApiFailure` に変換する。

### 3.4 Domain Reconciler

- 現在の永続状態と完全スナップショットから、次の `WorldRecord` と `HistoryEvent` を純粋計算する。
- 認証、HTTP、IndexedDB、Chrome API を参照しない。
- 同じ入力と同じ現在状態から常に同じ結果を返す。
- 初回ベースライン、2 回連続確認、復帰、名称変更、イベント ID の決定を担当する。

### 3.5 Repository

- IndexedDB の schema migration、照会、単一 read-write transaction を隠蔽する。
- ワールド更新、イベント追加、通知 outbox、同期結果を同じ transaction で確定する。
- 検索用に正規化名と複合 index を管理する。
- 1 profile 単位のバックアップ読出しと、検証済み復元データによる対象 user の record だけの置換を担当する。他 profile を保持し、安全な global preferences だけを merge する。

### 3.6 Alarm / Notification Adapter

- 定期同期には繰り返し alarm ではなく、固定名 `sync-next` の 1 回限り alarm を使う。自動同期が有効なら同期の全終了経路の `finally` で既存 alarm を次の 1 件へ置換し、無効なら解除する。
- 次回時刻は、成功なら現在から 12 時間 + 0〜60 分 jitter、429 なら `backoffUntil`、offline または 5xx の最大再試行後なら 30〜60 分後、401・schema 不正・その他の失敗なら現在から 12 時間 + 0〜60 分 jitter とする。
- デスクトップ通知は transaction で生成された未 claim event を同期単位で集約する。
- OS 通知は exactly-once にできないため、通知 API の attempt を最大 1 回にする厳密な at-most-once とする。API 呼出し前の transaction で `notificationClaimedAt` を確定し、以後は成功、明示的失敗、crash のいずれでも claim を解除しない。成功時は `notifiedAt`、明示的失敗時は固定コード `notificationError` を記録し、結果不明時は claim だけを残す。通知の成否にかかわらず履歴 event を正本とする。

## 4. Manifest と権限設計

### 4.1 必要な宣言

| 宣言 | 用途 |
| --- | --- |
| `manifest_version: 3` | Manifest V3 Service Worker と権限制御 |
| `permissions: ["alarms", "notifications", "unlimitedStorage", "declarativeNetRequestWithHostAccess"]` | 定期起動、デスクトップ通知、IndexedDB の quota / eviction 保護、User-Agent の限定変更 |
| `host_permissions: ["https://api.vrchat.cloud/*"]` | 拡張コンテキストから API へ HTTPS fetch |
| `background.service_worker` | 同期と alarm のイベント処理 |
| `action` | 初心者向けの入口 |

`cookies`、`webRequest`、`tabs`、`scripting`、`activeTab`、`<all_urls>` は宣言しない。`chrome.tabs.create` で固定 URL を開く操作は `tabs` 権限なしで行える。

ブラウザ実装差で `declarativeNetRequestWithHostAccess` が利用できない対象版を支援する場合だけ、同等の限定ルールを保ったまま `declarativeNetRequest` を使う。必要最低ブラウザ版はビルド時に固定し、無条件に広い権限へフォールバックしない。

### 4.2 User-Agent 動的ルール

JavaScript の `fetch` から `User-Agent` を直接設定することはできない。そのため install / startup 時に拡張自身の情報から動的 DNR ルールを構築する。

```json
{
  "id": 1,
  "priority": 1,
  "action": {
    "type": "modifyHeaders",
    "requestHeaders": [{
      "header": "user-agent",
      "operation": "set",
      "value": "vrc_favworld_check/<manifest version> https://github.com/Na2ki-BB/vrc_favworld_check"
    }]
  },
  "condition": {
    "urlFilter": "|https://api.vrchat.cloud/api/1/",
    "requestDomains": ["api.vrchat.cloud"],
    "initiatorDomains": ["<chrome.runtime.id>"],
    "resourceTypes": ["xmlhttprequest"],
    "requestMethods": ["get"]
  }
}
```

登録時は本製品が所有する固定 rule ID だけを置換する。他拡張の通信、VRChat 公式サイト自身の通信、画像、WebSocket、POST には一致させない。

## 5. API 取得設計

### 5.1 1 回の同期手順

1. 単一 flight lock を取得する。すでに実行中ならその状態を返す。
2. 永続化された `backoffUntil` と手動クールダウンを検査する。
3. `GET /auth/user` でセッションを確認する。raw `CurrentUser` に credential / token / Cookie / session data の field がないことを検査し、新しい object へ `id` と `displayName` だけをコピーして raw 応答を破棄する。禁止 field があれば fail closed にする。
4. 同一 read-only transaction で profile、worlds、profile 世代番号を同期計画用 snapshot として読む。
5. `GET /favorites?type=world&n=100&offset=k` を空ページが返るまで取得する。短い非空ページでも止めず、`k` は直前ページの実取得件数だけ増やす。
6. `GET /worlds/favorites?n=100&offset=k&releaseStatus=all` を同じ終端規則で取得する。
7. 両一覧の ID、型、ページ進行、要求数、総データ件数を検証する。各 endpoint で 10,000 データ件または 100 非空要求を上限とし、その後の空終端確認 1 要求を含む最大 101 要求とする。不完全なら本体を更新しない。
8. 既知ワールドと今回一覧を比較し、個別再確認候補を優先度順に最大 20 件選ぶ。
9. 候補だけ `GET /worlds/{worldId}` で再確認する。20 件を超える候補は `probeState: "pending"` として次回へ送る。
10. Domain Reconciler を実行する。IndexedDB の 1 transaction で世代番号と world revision を再検査し、ワールド、イベント、同期結果、成功時の必須 settings を反映して世代番号を増やす。
11. 未 claim イベントを transaction で永久 claim してから集約通知を 1 回だけ attempt する。今回の event に加え、前回 commit 後に通知処理へ進めなかった event もここで回収する。成功した event に `notifiedAt`、明示的に失敗した event に固定 `notificationError` を設定する。いずれの結果でも claim は解除しない。
12. 成否や例外にかかわらず `finally` で lock を解放し、自動同期が有効なら終了結果に対応する次回の名前付き one-shot alarm へ置換する。無効なら既存 alarm を解除する。

ページング結果は手順 10 の commit 完了までメモリ上にだけ置く。Service Worker 中断時は結果を捨て、確定データは変更しない。同期中だけ25秒間隔の限定 keep-alive を使い、開始時には同じ名前の復旧用 one-shot alarm を先に登録する。正常終了時は通常の次回時刻へ置換し、中断時は復旧 alarm から認証確認を含む完全同期をやり直す。

### 5.2 ページングの完全性

- `offset` は 0 から直前ページの実取得件数だけ単調増加させる。request の `n=100` より少ない非空ページでも継続する。
- 空ページだけを正常終端とする。短いページは終端にせず、空ページでは offset を増やさない。
- 異なる offset で同一の非空ページ fingerprint が返る、または非空ページ後に offset が増えない場合は異常として同期を中止する。
- 各 endpoint はデータ 10,000 件、非空ページ 100 要求を安全上限とし、ちょうど上限に達した場合も空終端確認を 1 回だけ許可する。最大 101 要求で空ページを確認できなければ中止する。
- API に snapshot token はないため、ページング中のサーバー側更新による一時的な抜けは完全には防げない。2 回連続確認が誤判定を緩和する。

### 5.3 候補の優先順位

個別再確認の 20 件は次の順で選ぶ。同順位は `lastProbeAt` が古い順、次に world ID 順とし、毎回同じ先頭だけを処理しない。

1. 前回から `pending` の候補。
2. お気に入り関係には存在するが、メタデータ一覧に存在しない ID。
3. 既知ワールドのうち、お気に入り関係一覧から今回初めて消えた ID。
4. すでに 1 回欠落または 1 回 404 を確認し、2 回目の確認が必要な ID。

個別確認を行えなかった候補について、アクセス不能回数は増やさない。完全な関係一覧からの欠落回数は、個別確認と独立して更新できる。

### 5.4 再試行

要求開始は前の要求開始から 2 秒以上空ける。redirect と 429 は inline 再試行しない。

- 429: その時点で同期全体を停止する。`consecutiveRateLimits = min(previous + 1, 7)` を永続化し、`30 秒 × 2^(count-1)`、最大 30 分の飽和指数 delay を計算する。
- `Retry-After`: 1 秒〜24 時間の妥当な delta-seconds または HTTP-date なら、上記指数 delay と比較して遅い方を採用し、0〜10% jitter を加えて `backoffUntil` に保存する。
- 429 再開: `backoffUntil` の alarm で認証確認から新しい完全同期を開始する。途中ページや probe から再開しない。`consecutiveRateLimits` と `backoffUntil` は完全同期成功時だけリセットする。
- 5xx / 通信失敗: 2 秒、4 秒を基準に短い jitter を加え、最大 2 回だけ再試行する。
- 401 / 認証を示す 403: 再試行しない。
- 404: 個別 world probe に限り正常な観測結果として扱い、再試行しない。
- その他の 4xx / schema 不正: API 互換性エラーとして同期を中止する。

429 の待機は必ず `backoffUntil` と alarm に移す。長い `setTimeout` で Service Worker を維持しない。

### 5.5 次回 alarm の決定

同期のアプリケーション制御下にある全終了経路は、共通の `finally` で次回時刻を決める。固定名で `chrome.alarms.create("sync-next", { when })` し、既存の同名 alarm を置換して、自動同期中に複数の次回 alarm を残さない。

| 終了結果 | 次回 `when` |
| --- | --- |
| 完全同期成功 | 現在 + 12 時間 + 0〜60 分 jitter |
| 429 | 永続化した `backoffUntil` |
| offline / 5xx の最大再試行後 | 現在 + 30〜60 分 jitter |
| 401 / schema 不正 / その他の失敗 | 現在 + 12 時間 + 0〜60 分 jitter |

`nextSyncAt` は alarm と同じ値として保存し、UI 表示と install / startup 時の修復に使う。ブラウザの強制終了などで JavaScript の `finally` 自体が走らない場合は、次回 install / startup handler が自動同期設定と `nextSyncAt` を確認し、欠けた `sync-next` を修復する。保存時刻が過去なら現在から 1〜10 分の jitter 後へ置き換え、起動直後の集中を避ける。alarm 登録 API 自体の失敗は固定診断コードだけを保存し、同じ call stack で登録を無限再試行しない。

## 6. ドメインモデル

### 6.1 状態を 2 軸に分ける理由

「お気に入りに含まれるか」と「ワールド情報へアクセスできるか」は別の事実である。1 つの `deleted` フラグへまとめると、非公開、API のフィルター、手動解除、障害を誤って断定する。そのため、所属状態とアクセス状態を独立して保持する。

#### お気に入り所属状態

```text
FAVORITED
   │  完全一覧から1回欠落
   ▼
MISSING_ONCE ── 一覧に再出現 ──> FAVORITED
   │  次の完全一覧でも欠落
   ▼
NOT_IN_FAVORITES ── 一覧に再出現 ──> FAVORITED + RESTORED event
```

#### アクセス状態

```text
ACCESSIBLE
   │  個別GET 404を1回確認
   ▼
UNAVAILABLE_ONCE ── metadata/個別GET 200 ──> ACCESSIBLE
   │  次の有効なprobeも404
   ▼
UNAVAILABLE ── metadata/個別GET 200 ──> ACCESSIBLE + ACCESS_RESTORED event
```

`UNKNOWN` は初回にメタデータが得られない場合と、まだ probe していない場合に使う。401、429、5xx、通信失敗で矢印を進めない。

### 6.2 型の概念定義

```ts
type MembershipState = "favorited" | "missing_once" | "not_in_favorites";
type AvailabilityState =
  | "unknown"
  | "accessible"
  | "unavailable_once"
  | "unavailable";

type EventKind =
  | "name_changed"
  | "favorite_missing_confirmed"
  | "favorite_restored"
  | "access_unavailable_confirmed"
  | "access_restored";
```

API adapter の外側で `any` を使用しない。境界入力は `unknown` として検証し、ドメイン型へ変換する。

## 7. 差分アルゴリズム

### 7.1 ベースライン

- DB に対象 user のワールドが 0 件ならベースライン同期とする。
- 関係一覧の ID をすべて `favorited` として作成する。
- メタデータがあれば `accessible`、名前、作者名、グループを保存する。
- メタデータがなく未 probe なら `unknown` と `pending` を保存する。
- `HistoryEvent` と通知 outbox は作らない。

### 7.2 更新同期

各既知・新規 ID について、次の順で pure transition を計算する。

1. **所属**
   - relation に存在: `membershipMissCount = 0`。以前が `not_in_favorites` なら `favorite_restored` を作る。
   - relation に不在: 完全スナップショットごとに count を 1 増やす。1 なら `missing_once`、2 以上なら `not_in_favorites`。2 へ変わる瞬間だけ `favorite_missing_confirmed` を作る。
2. **アクセス**
   - bulk metadata または probe 200: unavailable count を 0 にし `accessible`。以前が `unavailable` なら `access_restored` を作る。
   - probe 404: 有効な probe ごとに count を 1 増やす。1 なら `unavailable_once`、2 以上なら `unavailable`。2 へ変わる瞬間だけ `access_unavailable_confirmed` を作る。
   - probe 未実施または失敗: 変更しない。
3. **名称**
   - 成功メタデータの trim 後の名前が保存名と異なるときだけ、旧名と新名を持つ `name_changed` を作る。
   - 空文字や schema 不正を名称変更として採用しない。
4. **時刻**
   - API が返す時刻ではなく、端末の同期観測時刻を UTC ISO 8601 で保存する。
   - `lastSeenFavoriteAt` は relation に存在したときだけ更新する。
   - `lastMetadataAt` は有効な metadata / probe 200 のときだけ更新する。

### 7.3 イベントの冪等性

`WorldRecord.revision` を状態遷移ごとに単調増加させ、`eventId = <userId>:<worldId>:<revision>:<kind>` とする。同じ transaction 内で world revision と event を更新する。

- transaction が commit した後の再処理では現在状態と同じため、新しい遷移は生じない。
- transaction が abort した場合は revision と event の両方が残らない。
- A → B → A の名称変更は別 revision となるため、正しい 2 イベントとして残る。

1 同期で同じ world に複数 kind が発生する場合は、kind の固定順で revision を割り当てる。通知は複数 event を 1 件へ集約できるが、履歴根拠は個別に残す。

## 8. IndexedDB データモデル

DB 名は `vrc-favworld-check`、schema version は整数で管理する。全 user-owned record は VRChat user ID で分離する。

### 8.1 `profiles`

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `userId` | string, key | `usr_` 形式の VRChat user ID |
| `displayName` | string | 最後に確認した表示名。認証用途には使わない |
| `firstSeenAt` | ISO string | 初回同期時刻 |
| `lastSuccessfulSyncAt` | ISO string / null | 完全同期の最終成功 |
| `createdBySchemaVersion` | number | 移行判定 |

### 8.2 `worlds`

key は `[userId, worldId]`。

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `userId`, `worldId` | string | 所有 user と `wrld_` ID |
| `currentName`, `normalizedName` | string / null | 最新の取得成功名と検索用文字列 |
| `authorName`, `normalizedAuthorName` | string / null | 最新作者名と検索用文字列 |
| `favoriteTags` | string[] | `worlds1` など。重複除去済み |
| `firstSeenAt` | ISO string | 初回発見 |
| `lastSeenFavoriteAt` | ISO string / null | 関係一覧で最後に確認 |
| `lastMetadataAt` | ISO string / null | 200 metadata の最終確認 |
| `membershipState` | MembershipState | 所属状態 |
| `membershipMissCount` | 0 \| 1 \| 2 | 2 で飽和 |
| `availabilityState` | AvailabilityState | アクセス状態 |
| `unavailableCount` | 0 \| 1 \| 2 | 404 連続回数。2 で飽和 |
| `probeState` | `none` \| `pending` | 個別再確認待ち |
| `lastProbeAt` | ISO string / null | 公平な候補選択用 |
| `lastEvidenceStatus` | 200 \| 404 \| null | UI の技術根拠。本文は保存しない |
| `revision` | non-negative integer | event 冪等性 |
| `updatedAt` | ISO string | ローカル更新時刻 |

index は `[userId, updatedAt]`、`[userId, membershipState]`、`[userId, availabilityState]`、`[userId, probeState, lastProbeAt]` を持つ。部分一致検索は正規化した現在名・作者名と event の旧名・新名を user 単位で走査し、件数増加時に token index へ移行できる repository interface とする。

### 8.3 `events`

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `eventId` | string, key | revision と kind から決まる一意 ID |
| `userId`, `worldId` | string | 所有 user と対象 world |
| `kind` | EventKind | 変更種別 |
| `observedAt` | ISO string | 観測時刻 |
| `before`, `after` | 文字列または列挙値 | 必要最小限の遷移値 |
| `evidence` | object | `source: bulk|probe` と `httpStatus: 200|404|null`。本文なし |
| `syncId` | string | 同期との関連 |
| `notificationClaimedAt` | ISO string / null | 通知 API 呼出し前に確定する at-most-once claim |
| `notifiedAt` | ISO string / null | 通知 API が成功を返した時刻 |
| `notificationError` | `api_rejected` \| `permission_denied` \| `unavailable` \| null | 通知 API の明示的失敗を示す秘密を含まない固定コード。再試行可否には使わない |

index は `[userId, observedAt]`、`[userId, kind, observedAt]`、`[userId, worldId, observedAt]`。

### 8.4 `syncRuns`

成功と利用者向け障害診断に必要な最小情報だけを保持する。

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `syncId` | string, key | ランダム ID。秘密ではない |
| `userId` | string / null | 認証確認前の失敗では null |
| `trigger` | `manual` \| `alarm` \| `resume` | 起動理由 |
| `startedAt`, `finishedAt` | ISO string | 実行時刻 |
| `result` | `success` \| `auth_required` \| `rate_limited` \| `offline` \| `api_incompatible` \| `failed` | 固定コード |
| `favoriteCount`, `metadataCount`, `probeCount`, `changeCount` | number | 個人データを含まない集計 |
| `retryAt` | ISO string / null | 再開予定 |

URL、ヘッダー、Cookie、応答本文、stack trace は保存しない。保存件数には上限を設け、古い成功 run は削除できるが `events` は削除しない。

### 8.5 `settings` と `meta`

- `settings`: 定期同期、通知、直近手動同期時刻、`nextSyncAt`、`backoffUntil`、飽和カウンター `consecutiveRateLimits`、最後に選択した profile。
- `meta`: schema version、最終 migration、バックアップ形式 version、profile ごとの単調増加 `dataGeneration`。`dataGeneration` は端末内の競合検知専用でバックアップへ含めない。

同期 lock は Service Worker の単一 flight promise で管理する。イベントが重なった場合は既存 promise を共有する。Service Worker 終了で lock も消えるため、永続データの commit は短い 1 transaction に限定し、未完了 fetch は状態を変えない。

## 9. 原子性と障害回復

### 9.1 同期 commit

1. ページングと probe を transaction 外で完了する。
2. read-only snapshot を読み、pure transition plan を作る。
3. `worlds`、`events`、`profiles`、`syncRuns`、成功に必須の `settings`、profile 世代を 1 read-write transaction で再読込・検証して更新する。
4. profile 世代または world revision が計画時と異なる場合は競合として abort する。取得済みの完全 API snapshot を使って新しい DB snapshot から計画・commit だけを最大1回やり直し、再競合時は利用者の復元等を優先して同期状態を変更しない。
5. commit 後、未 claim event を別の短い transaction で永久 claim してから通知 API を 1 回だけ呼ぶ。成功時は `notifiedAt`、明示的失敗時は allowlist 済みの固定 `notificationError` を更新する。結果不明を含む全結果で claim を解除せず、履歴 commit は通知結果にかかわらず戻さない。

### 9.2 Service Worker 中断

- API 途中: メモリ結果が消えるだけで、本体状態は不変。
- DB transaction 途中: IndexedDB が全体を abort する。
- DB commit 後・claim 前: 未 claim event が残り、次回起動で claim して通知できる。
- claim commit 後・通知 API 前: 再起動後も claim を維持するため通知は欠落し得るが、同じ event を再 attempt せず、履歴は残る。
- 通知 API 成功後・`notifiedAt` 前: claim が残るため再通知しない。UI では履歴を正とし、OS 通知の exactly-once を主張しない。
- 通知 API の明示的失敗: claim を維持して再 attempt しない。書込み可能なら固定 `notificationError` を残す。失敗コード保存前に中断しても claim だけが残り、履歴 event は UI で確認できる。
- alarm 再登録前の強制終了: 同期開始時に先置きした復旧 alarm が完全同期を再開する。ブラウザ自体の終了などでそれも失われた場合は、次回 install / startup handler が永続状態から名前付き alarm を修復する。

## 10. バックアップ形式

トップレベルは次の形とする。

```json
{
  "format": "vrc_favworld_check-backup",
  "version": 1,
  "exportedAt": "2026-08-17T00:00:00.000Z",
  "appVersion": "1.0.0",
  "profile": {},
  "worlds": [],
  "events": [],
  "preferences": {}
}
```

- 1 ファイルは `profile` 1 件と、その `userId` に属する `worlds`、`events` だけを含む。複数 profile を含めない。
- `syncRuns`、lock、backoff、認証応答は含めない。event の `notificationClaimedAt`、`notifiedAt`、`notificationError` は at-most-once 状態を保つため event とともに含める。未 claim の import event は復元時に `notificationClaimedAt = restoredAt` とし、復元を過去通知の起点にしない。
- `preferences` は定期同期と通知の有効・無効など明示した安全な利用者設定だけを含め、端末固有時刻、選択 profile、`backoffUntil`、`consecutiveRateLimits` は除外する。
- エクスポートは profile、worlds、events、安全な preferences を同一 read-only transaction で snapshot として読み、安定した key 順、world ID / event ID 順に並べる。
- 復元は JSON parse 後に prototype を持たない値へ正規化し、件数、文字列長、ID、日時、enum、参照を検証する。
- 対応 schema だけを新しい object graph として作る。1 read-write transaction 内で対象 `userId` の `profiles` 1 件、`worlds` key range、`events` key range だけを削除・再作成し、profile 世代番号を増やす。他 user の record を触らず、同じ transaction で allowlist 済み global preferences だけを既存 settings へ merge する。失敗時は全 profile、世代、settings の処理前状態を維持する。

## 11. UI 状態設計

### 11.1 ホーム

| 内部状態 | 主メッセージ | 主ボタン |
| --- | --- | --- |
| 未同期 | 最初のお気に入り記録を作ります | 今すぐ確認 |
| 認証切れ | VRChat へのログインが必要です | VRChat 公式サイトを開く |
| 同期中 | お気に入りを確認しています | 無効化して進捗表示 |
| 成功 | 確認が終わりました。変化 N 件 | 履歴を見る |
| オフライン | インターネットに接続してから再試行してください | もう一度試す |
| 429 | VRChat が混み合っています。次回は HH:MM 以降です | 履歴を見る |
| API 互換性 | VRChat 側の変更に対応する更新が必要です | 更新情報を見る |

### 11.2 履歴カード

- 最上段: 保存済みの最新名称。取得不能でも空にしない。
- 補助: 過去名、作者、world ID、最終確認時刻。
- 状態 badge: 「お気に入り」「確認中」「お気に入り一覧にありません」「現在アクセスできません」。色と文言を併用する。
- 展開部: 時系列 event と「この表示は削除・非公開を区別するものではありません」の注記。
- API 文字列は `textContent` で表示し、HTML として解釈しない。

## 12. テスト可能性

境界ごとに次の差し替え点を定義する。

- `VrchatApi`: fixture を返す fake、429 / 401 / 404 / pagination failure を注入可能。
- `Clock` / `RandomSource`: 時刻、jitter、backoff を固定可能。
- `WorldRepository`: fake と fake-indexeddb 相当の結合実装。
- `BrowserAlarm` / `BrowserNotification`: alarm の置換と通知 attempt を記録し、各同期終了結果、明示的通知失敗、claim 後 crash を注入できる spy。
- `Reconciler`: HTTP なしの表形式単体テスト。

主要 invariant は property test または反復テストで確認する。

- miss count / unavailable count は 0〜2 の範囲を越えない。
- 不成功同期は domain state を変えない。
- 同じ snapshot の 2 回処理で event 数が増えない。
- claim 後に Service Worker を再起動しても同一 event の通知 API attempt が増えず、履歴 event は残る。
- 通知 API が明示的失敗を返しても claim と固定 `notificationError` が残り、Service Worker 再起動後の attempt 数は増えない。
- 自動同期が有効な全終了結果で `sync-next` がちょうど 1 件に置換され、成功、429、offline / 5xx 上限、401 / schema / その他の各時刻規則に一致する。無効時は残らない。
- event の before と直前 state、after と直後 state が一致する。
- どの例外点で transaction を abort しても world と event の revision が食い違わない。
