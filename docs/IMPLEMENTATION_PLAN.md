# vrc_favworld_check 実装・検証計画

## 1. 完了定義

本製品は、利用者がVRChat公式サイトでログインした既存セッションを使い、最大8リスト・800ワールドの現在状態を端末内へ記録できることを完了条件とする。名称変更、リスト移動、一覧からの消失、アクセス不可と復帰を誤断定せず履歴化し、開発者サーバー、資格情報入力、利用者によるDB保守を必要としないことを必須とする。

公開候補は次のrelease gateをすべて満たす必要がある。

- VRChat Creator Guidelinesと現行コミュニティOpenAPIを再確認している。
- manifestの `cookies` 権限と3つのVRChat host permissionが、固定名Cookie Bridgeと親domain競合検査の用途だけに限定され、閲覧履歴や全URLへアクセスする権限がない。
- lint、strict typecheck、全テスト、coverage計測、build、公開物の秘密検査が成功し、未実行の主要分岐がないことをレビューする。
- 800ワールド、8リスト、DB v1移行、backup v1互換、削除失敗の各fixtureが成功する。
- 配布ZIPが複数タイムゾーンで同一になり、検証済み `dist/extension` から Inno Setup 6 の Windows インストーラーをコンパイルできる。
- installer configの静的検査と、対象の実PC・実Chromeで限定した導入・更新・同期・一時Cookie削除・正規削除確認が成功する。
- 実利用者のCookie、バックアップ、ログ、`.env`、ローカル専用文書がGit追跡対象にない。

## 2. 採用する構成

| 領域 | 採用 | 理由 |
| --- | --- | --- |
| 実行環境 | Windows版Google Chrome Manifest V3拡張 | 公式Webログインをブラウザへ委ね、常駐アプリなしでUI・定期実行・通知を提供できる |
| 永続DB | 拡張origin内のIndexedDB `vrc-favworld-check` | サーバー費用と利用者によるDB導入が不要。transactionとschema migrationを利用できる |
| 開発者DB | 使用しない | 利用者データと秘密を開発者が保持しない |
| 認証 | VRChat公式サイトの既存セッション + 短時間Cookie Bridge | パスワード・2FA入力を受けず、固定名2つだけをAPI用hostへ一時複製し、値を永続化しない |
| API | 読み取り専用GET | VRChat側の状態を変更しない |
| 通知 | OS通知 + 永続未読バッジ | OS通知欠落時も履歴を正本として確認できる |
| 配布 | Chrome用MV3 package + Inno Setup 6 | 検証済み拡張をユーザー単位の固定LocalAppDataへ配置し、Downloadsの展開フォルダー保持を不要にする |

## 3. 実装順序と各出口条件

### Phase 1: API・純粋ドメイン

1. `/favorite/groups`を既存の直列ページング・サイズ制限・redirect拒否へ統合する。
2. 本人所有、ID、内部名、表示名、type、一意性を境界で検証する。
3. グループ名履歴とワールド所属変更を純粋関数で計算する。
4. `unavailable_once`を個別確認の最優先にする。

出口条件は、混在するavatar/friendの安全な除外、owner不一致・重複・未知typeのfail closed、800件の先頭・中間・末尾差分、同一入力の冪等性が単体テストで証明されることである。

### Phase 2: IndexedDB v2・backup v2

1. `favoriteGroups` storeと同期記録保持indexをmigration transactionで追加する。
2. profile、worlds、groups、events、未読件数、同期結果を成功commitの同一transactionへ入れる。
3. 同期記録をprofile 100件、匿名20件へ同じtransaction内で整理する。
4. backup v2へgroupsを追加し、v1をgroupsなしとして正規化して取り込む。
5. 全storeの利用者記録を1 transactionで消去し、削除中gateとschema情報だけを残す。取消不能な`deleteDatabase` requestは使わない。

出口条件は、v1 DBの既存world/eventが移行後も同一であること、復元競合で古い同期を拒否すること、800world + 8groupのround-trip、未知field・秘密field・巨大入力の拒否である。

### Phase 3: 同期・ライフサイクル

1. 固定名 `auth` と任意の `twoFactorAuth` だけをsourceから読み、targetへ最長15分だけ設定するAuth Cookie Bridgeを同期single-flight内へ置く。
2. 非秘密markerを使い、通常終了時は今回設定した値・属性が一致するCookieだけを削除する。startup、次回同期、正規削除時は中断残骸を誤削除せず、最長15分の失効後に孤立markerだけを回収する。親domain・別pathを含む既存target競合とCookie APIから返るpartitionedはfail closedにする。
3. グループAPIの部分障害と同期全体の障害境界を分離する。
4. commit後に未読バッジをDBから再構築する。
5. 36時間の同期停滞と個別確認待ち件数をstatusへ公開する。
6. 全消去では永続gate、alarm停止、Cookie残骸不在の確認、利用者recordの原子的消去、自己アンインストールを順序固定し、全repository書込みが同じtransaction内でgateを検査する。

出口条件は、bridgeの成功・source欠落・親domainを含むtarget競合・Cookie APIから返るpartitioned・setup/cleanup失敗・途中残骸・並行実行をCookie値なしで再現でき、今回設定した値・属性から変化したCookieと再起動後の認証Cookieを削除しないこと、401・429・network・5xx・redirectでDB不変、グループschemaまたはID同一性だけの不調では以前の名称を保持してworld同期成功、DNR不成立時fetch 0、Cookie cleanupまたは削除失敗時uninstall 0、既存の削除guardからの再試行でguardを解除せず自己アンインストールまで再実行できることである。

### Phase 4: UI・利用者保護

1. カード、検索、フィルターへ利用者設定のリスト名を表示する。
2. 800件を200件ずつ段階表示する。
3. 未読、同期停滞、グループ情報の鮮度、保存件数・概算容量を平易な日本語で示す。
4. 全消去前に対象件数、最終backup日時、外部JSONが残ることを確認する。

出口条件は、API文字列をHTMLとして解釈する経路がなく、キーボード操作とvisible focusを維持し、固定エラーコードごとに次の操作が表示されることである。

### Phase 5: 配布・実環境確認

1. 再現可能なmanifest直下ZIPとSHA-256を作る。
2. installer config の固定path、非昇格、禁止機能不在、単一世代rollback、app root限定削除を自動検査し、Inno Setup 6 compileを行う。
3. 対象の実PC・実Chromeでfresh install、Downloadsのinstaller削除後の動作、同版再インストール、`0.1.6`から`0.1.7`への上書き更新、103件raw pageを含む完全同期、`cookies`と3つのVRChat host権限、一時Cookieの同期後不在、extension ID・履歴保持を確認する。
4. 拡張UIの全消去・自己アンインストール後にWindows側を削除する正規順序を確認する。

Windows 10/11双方、Chrome/Edge双方、複数profile、全障害点、ProcMon、複数AV、コード署名、自動更新は今回のrelease gateに含めない。実アカウントでのAPI応答確認もローカル実装だけでは完了できないため、コードのrelease gateと分けて扱う。

2026-08-23時点で `0.1.0` のfresh installと公式Webログインまでは対象実機で完了した。`0.1.1`の同一origin案は拡張要求が307でAPI hostへ移り、401 `Missing Credentials`になるため不採用とした。`0.1.2`で限定Cookie Bridgeへ置き換えたが、対象実機のsource CookieがSecure属性なしであることを過剰な入力検査が拒否した。Cookie値を表示しない属性診断で、両固定名、`vrchat.com` host-only、path `/`、HttpOnly、SameSite=Lax、非partitioned、非Secureを確認した。

`0.1.3`ではPromise版Cookie APIの未検出値 `undefined` を仕様どおり扱い、sourceのSecure属性を必須にせず、targetだけを必ずSecure・HttpOnlyへ固定した。対象実機で `/auth/user` は200になり、Cookie BridgeとCORS境界は成立した。しかし正常な `CurrentUser` の必須field `usesGeneratedPassword` をfield名の `password` だけで拒否する過剰な再帰検査により、後続のお気に入りAPIへ進む前に `API_INCOMPATIBLE` となった。

`0.1.4`では `CurrentUser` 全体のcredential-like field走査を廃止し、bounded JSONのtop-level objectから `id` と `displayName` だけを厳格検証して新objectへコピーする。仕様上存在する `authToken`、`usesGeneratedPassword`、nestedの未知fieldは名前も値も走査せず、DB、backup、log、UIへ渡さない。必要2fieldと応答境界の不正は従来どおりfail closedにする。

対象実機の `0.1.4` では `/auth/user`、グループ一覧、お気に入り関係一覧がすべて200となり、認証とCookie Bridgeは通過した。しかし `/worlds/favorites?n=100` の正常な最初のページが103件を返し、実装が要求件数100を応答上限と誤認して `API_INCOMPATIBLE` で停止した。応答値、ID、ワールド名、作者名、Cookieは調査記録へ保存していない。

`0.1.5`では過剰返却の受入れを実測したworld metadata endpointだけへ限定し、103件を切り捨てず次を `offset=103` とする。raw pageは投影前に総数10,000件の残枠を検査し、5 MiB応答上限、100非空要求、空終端確認、schema、ID重複、page fingerprintの防御を維持する。他の一覧endpointは1ページ100件上限を変えない。13テストファイルを含む `npm run verify` は失敗・skip 0件で、coverageはline 90.34%、branch 79.91%、function 93.92%、`dist/extension` のversionは `0.1.5` となった。`npm run package` とInno Setup 6.7.3の実コンパイルも完走し、v0.1.5のZIPとEXEを生成した。

対象実機の `0.1.5` は103件pageの受入れまで進んだが、必須5fieldのうちID形式だけ2件がcanonicalな `wrld_` + UUID検査に合わず完全同期を停止した。名称、作者名、お気に入りグループ、公開状態の不正は0件だった。利用者は該当IDの値を共有しておらず、raw応答、利用者情報、ワールド名、Cookieは記録していない。このため `0.1.5` は自動検証とパッケージ生成の履歴は有効だが、完全同期の配布候補ではない。

`0.1.6`は `/worlds/favorites` に限り、他必須fieldが正常で、IDが200コードポイント以下・前後空白なし・制御文字なしの非canonical文字列である行をページング用の一時identityにだけ使い、metadata出力前に除外する。raw 103件なら除外後件数にかかわらず次を `offset=103` とする。除外IDは保存、UI、ログ、個別API URL、backupへ渡さない。`/favorites` 関係IDと `GET /worlds/{worldId}` の入力検査、backupのID検査は緩めず、DBへはcanonicalなadapter出力だけを渡す。ID以外の必須field不正、安全でないID、重複は従来どおり失敗させる。

`0.1.6` の `npm run verify` はlint、型検査、13テストファイル、coverage、buildをすべて成功し、失敗・skipは0件だった。coverageはline 90.44%、branch 80.12%、function 93.95%で、`dist/extension` のversionは `0.1.6` となった。`npm run package` とInno Setup 6.7.3の実コンパイルも完走し、v0.1.6のZIPとEXEを生成した。一方、対象実機では `/auth/user`、グループ、お気に入り関係、`/worlds/favorites?offset=0` がすべて200だった後、`offset=103` を要求する前に `API_INCOMPATIBLE` となった。追加の値分類は求めず、非canonical IDを安全な文字列として解釈し、重複identityとfingerprintへ残した過剰防御を原因候補とする。このため `0.1.6` は検証・成果物の履歴として維持するが、完全同期の配布候補から外す。実ID、ワールド名、作者名、Cookie、raw応答は記録していない。

`0.1.7`では `/worlds/favorites` だけがnullable identityを明示的にopt-inする。canonicalでないIDは追加の型・値分類もコピーも行わず `{ identity: null, metadata: null }` とし、raw行数はoffsetと総数10,000件上限へ含める。nullはglobal重複検査から除外する。canonical IDがあるpageのfingerprintはcanonical ID列と除外件数から作り、全件nullのpageは同数だけで誤って反復判定せず、raw offset、最大100非空要求と空終端確認1要求、総数上限で終了を保証する。非空snapshot全体のcanonical metadataが0件なら `API_INCOMPATIBLE` とする。ID以外の必須fieldとcanonical ID重複は厳格に拒否し、`/favorites`、`GET /worlds/{worldId}`、backupのcanonical検査は維持する。除外IDはstorage、UI、log、API URL、backupへ渡さない。

`0.1.7` の `npm run verify` はlint、型検査、13テストファイル、coverage、buildをすべて成功し、失敗・skipは0件だった。coverageはline 90.44%、branch 80.17%、function 93.95%で、`dist/extension` のversionは `0.1.7` となった。`npm run package` とInno Setup 6.7.3の実コンパイルも完走し、v0.1.7のZIPとEXEを生成した。対象実機では `0.1.7` 導入後の「今すぐお気に入りを確認」が成功し、`0.1.6` の `offset=0` 後に発生していた `API_INCOMPATIBLE` は解消した。**推論**: 同期成功までの実装経路から、103件raw pageを処理して `offset=103` 以降へ進む経路も通過したと判断できる。残る実機作業は、同期後の一時Cookie不在、更新前後のextension ID・既存履歴保持、同版再インストール、正規順序のアンインストール、`0.1.7` のfresh install、Downloads内のinstaller削除後の動作、SmartScreen実表示の確認である。

## 4. リスクの判断

| リスク | 判断 | 実装上の扱い |
| --- | --- | --- |
| 800件の一覧比較 | 保有 | bulkページングと全ID比較を維持し、専用回帰テストを追加 |
| 個別GET最大20件 | 保有・軽減 | API保護のため上限維持。2回目404を優先し待ち件数を表示 |
| 非公式API変更 | 保有・軽減 | strict schema、部分障害境界、固定エラー、releaseごとの仕様確認 |
| world metadataの非canonical ID | 保有・軽減 | 実測endpointだけがnullable identityを明示opt-inし、値を投影せず除外。canonicalな関係IDを正本とし、不明IDを保存・表示・probeしない |
| ブラウザ終了中に同期不可 | 保有 | 次回起動時にalarm修復。OS設定や常駐アプリを追加しない |
| OS通知欠落 | 軽減 | IndexedDB履歴と未読バッジを正本にする |
| 履歴の長期増加 | 保有・軽減 | core履歴は消さず、同期記録だけ整理し、容量警告と全消去を提供 |
| ローカルDBが平文 | 保有 | 認証情報を保存せず、OSアカウント・ディスク保護を前提にする |
| `cookies`権限と一時転送 | 保有・軽減 | 固定名2つ、固定3host（source、親domain競合検査、API target）、設定時最長15分、Secure/HttpOnly/SameSite=Strict、非秘密marker、値非永続、Cookie APIから返るpartitionedのfail closed、削除直前の値・属性一致確認で範囲を限定 |
| 手動配布の導入・更新 | 軽減 | Inno Setupで固定pathへ配置し、同版再導入、downgrade拒否、単一世代rollbackを行う。自動更新はしない |
| アンインストール後の残存 | 軽減 | DB論理削除とChrome側自己削除の後にWindows固定ファイルを削除。外部JSON・物理痕跡は保証外と明示 |

## 5. 変更管理

- schema、backup、message、event kindはversioned contractとしてテストする。
- API raw objectをrepositoryやloggerへ渡さない。
- 依存追加、権限追加、通信先追加は個別の脅威レビューなしに行わない。
- 修正は関連テストから始め、最後に全検証を一度通す。
- push、GitHub Release、外部配布・外部サービス送信は、ローカル検証と公開対象監査の後に明示承認を得て実行する。
