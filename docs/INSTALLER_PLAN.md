# Windows 簡易インストーラー計画

## 目的と対象

- PC操作に詳しくない1名が実際に使うGoogle Chromeだけを対象にする。
- 検証済みの `dist/extension` を、Windows ユーザー単位の固定場所
  `%LOCALAPPDATA%\Programs\VRCFavoriteWorldHistory\extension` へ配置する。
- Inno Setup 6 を使い、`PrivilegesRequired=lowest` として管理者権限や UAC を要求しない。
- インストール先は変更不可とし、Inno Setup 標準の HKCU アンインストール登録だけを使う。
- コード署名、自動更新、実行時ダウンロードは行わない。

## 初回導入

1. ビルド時に `extension/` を検査して `dist/extension` を作り、両者の内容と
   `package.json` / manifest のバージョン一致を再確認してからインストーラーへ同梱する。
2. 固定場所へ拡張ファイルを配置する。
3. 完了時に Chrome の `chrome://extensions/` と固定 `extension` フォルダーを開く。
4. 「デベロッパー モード」「パッケージ化されていない拡張機能を読み込む」
   「開いた `extension` フォルダーを選択」の順で日本語案内する。
5. Chromeが権限を表示した場合は、Cookie利用の対象が `vrchat.com` / `vrchat.cloud` / `api.vrchat.cloud` だけであることを確認するよう案内する。root `vrchat.cloud` は親domain Cookieの競合検査だけに使う。
6. Downloads 内のインストーラーは導入後に削除できると案内する。

manifest に `key` は追加しない。同じ Windows ユーザー、Chrome プロフィール、固定パスを
維持することで、上書き更新時に同じ unpacked 拡張として読み込まれる前提とする。

## 更新

- 更新開始前に Chrome の全ウィンドウを閉じるよう表示する。プロセス検出や強制終了はしない。
- インストール済み manifest の `x.y.z` バージョンを比較し、downgrade は拒否し、同版再インストールは許可する。
- 新版全体を同じ app root の `extension.new` へ先に展開する。
- 展開成功後だけ、既存 `extension` を `extension.old` へ退避し、`extension.new` を
  `extension` へ切り替える。
- 切替または検証に失敗した場合だけ、新版を除去して `extension.old` を元へ戻す。
- 新版の固定配置を確認後に `extension.old` を削除する。保持する退避は 1 世代だけとする。
- 前回失敗で `extension` がなく `extension.old` だけが残った場合の単純復元は行うが、
  電源断を網羅する状態機械、複数世代 rollback、複雑な fault injection は作らない。

## アンインストール

- Windows 側の削除前に、拡張の設定画面で必要なら JSON バックアップを保存し、
  「記録をすべて削除してアンインストール」を先に行うよう日本語で案内する。
- ブラウザ側の削除完了は Chrome profile から自動判定しない。
- Windows アンインストーラーが削除するのは、固定 app root 内の `extension`、
  一時的な `extension.new` / `extension.old`、Inno Setup 自身の固定ファイルだけとする。
- Chrome の profile、Cookie、IndexedDB と、利用者が書き出した JSON backup は探索も削除もしない。

## 明示的に行わないこと

- browser policy、force install、custom `[Registry]`、service、scheduled task、startup、telemetry
- インストーラーからの Cookie、profile、IndexedDB の探索・変更、および拡張の認証、API、同期、DB、backup 処理の呼出し
- Windows 10/11 両方、Chrome/Edge 両方、複数 profile、全障害点、ProcMon、複数 AV の網羅
- push、GitHub Release、外部配布

## 検証

- 自動: installer 設定の静的テスト、manifest の `key` 不在、lint、型検査、全テスト、
  `npm run verify`、`npm run package`、Inno Setup compile。
- 対象の実PC / 実Chrome: fresh install、Downloadsのinstaller削除後の動作、同版再インストール、
  `0.1.6`から`0.1.7`への上書き更新、103件raw pageを含む完全同期、`cookies`と `vrchat.com` / `vrchat.cloud` / `api.vrchat.cloud` 権限、同期後の一時Cookie不在、更新前後のextension IDと履歴保持、
  正規順序のアンインストール。
- コード署名をしないため、SmartScreen が未認知の実行ファイルとして警告する残余リスクを受容し、
  配布時にファイル名と SHA-256 を別経路で確認する。

## 実装状況と残作業（2026-08-24）

`0.1.0`の初回導入と公式サイトへのログインは実PC / 実Chromeで完了したが、拡張要求の
`https://api.vrchat.cloud/api/1/auth/user` は401 `Missing Credentials`になった。`0.1.1`でAPI baseを
`https://vrchat.com/api/1`へ変更しても、拡張要求はAPI hostへ307 redirectされ、その先は同じ401になった。

`0.1.2`ではAPI baseを `api.vrchat.cloud` に戻し、拡張側の同期中だけ固定名 `auth` と任意の
`twoFactorAuth` を一時複製する。値はDB・設定・ログ・UI・backupへ渡さず、通常終了時は今回設定した
値・属性の一致時だけ削除する。途中終了後は同名Cookieを誤削除せず、設定時の期限切れによる不在を確認してから
次回同期や正規アンインストールへ進む。これはインストーラーがChrome profileやCookieを操作する変更ではなく、
配置された拡張が利用者承認済みの `cookies` 権限で行う認証境界の変更である。

対象実機で `0.1.2` を確認したところ、権限は正常だったが、VRChatのsource `auth` / `twoFactorAuth` に
Secure属性が付いていないため過剰な入力検査で同期前に停止した。Cookie値を表示・記録せず属性だけを確認して原因を特定した。
`0.1.3`ではPromise版Cookie APIの未検出値 `undefined` を仕様どおり扱い、sourceのSecure属性を必須とせず、
API側の一時CookieだけをSecure・HttpOnly・SameSite=Strictへ固定する。sourceは変更・延命しない。

対象実機の `0.1.3` で `/auth/user` は200となり、Cookie BridgeとCORS境界が成立することを確認した。しかし
正常な `CurrentUser` の必須field `usesGeneratedPassword` をfield名の `password` だけで拒否する再帰検査により、
後続のお気に入りAPIへ進む前に `API_INCOMPATIBLE` となった。`0.1.4`ではbounded JSONから `id` と
`displayName` だけを検証・コピーし、`authToken`を含むその他のfieldは名前・値・階層を走査せず破棄する。

対象実機の `0.1.4` では `/auth/user`、グループ一覧、お気に入り関係一覧がすべて200となった。しかし
`/worlds/favorites?n=100&offset=0` が正常なJSON配列を103件返し、実装が要求件数100を応答上限と誤認して
完全同期を停止した。`0.1.5`ではこのendpointだけ過剰返却を受け入れ、総数10,000件の残枠を投影前に検査し、
offsetを実取得件数だけ進める。他endpointの100件上限、5 MiB応答上限、要求回数、schema、重複検査は維持する。
応答値、ID、ワールド名、作者名、Cookieは調査記録へ保存していない。

対象実機の `0.1.5` は103件raw pageを受け入れたが、必須5fieldのうちID形式だけ2件がcanonicalな `wrld_` + UUID検査に一致せず完全同期を停止した。名称、作者名、お気に入りグループ、公開状態の不正は0件だった。利用者は該当IDの値を共有しておらず、raw応答やCookieも記録していない。

`0.1.6`は `/worlds/favorites` に限り、他必須fieldが正常で、IDが200コードポイント以下・前後空白なし・制御文字なしの非canonical文字列である行をページング検査にだけ含め、metadata出力前に除外した。しかし対象実機では `/auth/user`、グループ一覧、お気に入り関係一覧、`/worlds/favorites?offset=0` がすべて200だった後、`offset=103` を要求する前に `API_INCOMPATIBLE` となった。追加の値分類は求めず、noncanonical IDを安全な一時文字列として解釈し、重複identityとfingerprintへ残した過剰防御を原因候補とする。実ID、ワールド名、作者名、Cookie、raw応答は記録していない。

`0.1.7`ではこのendpointだけがnullable identityを明示的にopt-inする。canonicalでないIDは追加の型・値分類もコピーも行わず `{ identity: null, metadata: null }` とし、raw行数はoffsetと総数10,000件上限へ含める。nullはglobal重複検査から除外する。canonical IDがあるpageのfingerprintはcanonical ID列と除外件数から作り、全件nullのpageは同数だけで反復と断定せずraw offset、最大100非空要求と空終端確認1要求、総数上限で終了を保証する。非空snapshot全体のcanonical metadataが0件なら `API_INCOMPATIBLE` とする。ID以外の必須field、canonical ID重複、`/favorites`、`GET /worlds/{worldId}`、backupのcanonical検査は厳格なまま維持し、除外IDは保存、UI、ログ、API URL、backupへ渡さない。

`0.1.2`、`0.1.3`、`0.1.4`、`0.1.5`、`0.1.6`は上記の実機不適合により完全同期の配布候補から外す。各成果物は後述のビルド履歴としてのみ扱う。

- Inno Setup 6.7.3 を Windows ユーザー単位で導入し、`.iss` の実コンパイルに成功した。
- `0.1.5` の `npm run verify` はlint、型検査、13テストファイル、coverage、buildをすべて成功し、失敗・skipは0件だった。coverageはline 90.34%、branch 79.91%、function 93.92%だった。
- `0.1.5` でCookie APIの実Chrome準拠、正常な `CurrentUser` の必要2fieldだけを投影する回帰に加え、world metadataの103件ページ、実取得件数によるoffset、投影前の10,000件上限、他endpointの100件上限を自動テストした。
- `0.1.5` の `npm run package` は検証済み `dist/extension` から次の履歴用成果物を生成した。これらは現行の完全同期候補ではない。
  - `artifacts/vrc_favworld_check-v0.1.5.zip`（102,487 bytes）
    SHA-256: `58f7f1fa61866722debc732e4ecbcb468f21c729060b5d8182fc4e241d4aa74c`
  - `artifacts/vrc_favworld_check-installer-v0.1.5.exe`（2,179,474 bytes）
    SHA-256: `de8786c68f949b688d4dca90b44a5166197737290589af79815e7e1d630d3fa9`
- installer config test は固定 path、非昇格、`SetupMutex`、禁止機能不在、manifest `key` 不在、
  downgrade 拒否、単一世代 rollback、app root 限定削除、初回・更新後の管理画面導線を固定した。
- 最終レビューで見つかったインストーラー二重起動の競合は、製品固有 `SetupMutex` を追加して解消した。
- `0.1.6` の `npm run verify` はlint、型検査、13テストファイル、coverage、buildをすべて成功し、失敗・skipは0件だった。coverageはline 90.44%、branch 80.12%、function 93.95%で、`dist/extension` のversionは `0.1.6` となった。
- `0.1.6` の `npm run package` とInno Setup 6.7.3 compileは成功し、次の履歴用成果物を生成した。これらは現行の完全同期候補ではない。
  - `artifacts/vrc_favworld_check-v0.1.6.zip`（102,894 bytes）
    SHA-256: `bcdd3668b9ca0be6c1145230a14bdeb2e914c30203fc5f2c6f17cc303995ec34`
  - `artifacts/vrc_favworld_check-installer-v0.1.6.exe`（2,179,799 bytes）
    SHA-256: `435e1c02349b085f39ffc5cd11f4ca7bba17eed64fbbadf62c070b02cfd15ddc`

- `0.1.7` の `npm run verify` はlint、型検査、13テストファイル、coverage、buildをすべて成功し、失敗・skipは0件だった。coverageはline 90.44%、branch 80.17%、function 93.95%で、`dist/extension` のversionは `0.1.7` となった。
- `0.1.7` の `npm run package` とInno Setup 6.7.3 compileは成功し、次の現行実機確認用成果物を生成した。
  - `artifacts/vrc_favworld_check-v0.1.7.zip`（103,095 bytes）
    SHA-256: `4312d640c4724b18edbb27101971059432a1502e872466fd75d0853dc945c120`
  - `artifacts/vrc_favworld_check-installer-v0.1.7.exe`（2,179,969 bytes）
    SHA-256: `be60ce23ba62590d8b34c38ad166cc4940029043807df8a87ec499f45aca1aaa`

2026-08-24の対象実機では、`0.1.7`導入後の「今すぐお気に入りを確認」が成功し、`0.1.6`で `offset=0` の200応答後に発生していた `API_INCOMPATIBLE` は解消した。**推論**: 同期成功までの実装経路から、103件raw pageを処理して `offset=103` 以降へ進む経路も通過したと判断できる。

`0.1.7`を利用可能と判断する前に、残る次の実機受け入れ試験を行う。

1. 同期終了後にAPI hostの一時 `auth` / `twoFactorAuth` と所有markerが残っていないことを確認する。Cookie値は表示・撮影・記録しない。`AUTH_COOKIE_CLEANUP_FAILED` または残存が確認された場合は配布せず、API応答によるCookie更新の有無を再調査する。
2. 更新前後のextension IDと既存履歴が同一であることを確認する。
3. Chromeを閉じた状態で `0.1.7` の同版再インストールを1回行い、extension IDと履歴が変わらないことを確認する。
4. 必要ならJSON backupを保存し、拡張UIの全消去・自己アンインストール、Windows側アンインストールの順で削除する。app root外、Chrome profile / Cookie / IndexedDB、JSON backupがWindows側から削除されないことを確認する。
5. 正規削除後に検証済みの `0.1.7` installerでfresh installし、3hostの権限を確認してunpacked拡張を固定pathから読み込み、完全同期する。Downloads内の `0.1.7` installerを削除してChromeを再起動した後も同じ固定pathから動作することを確認する。
6. 実機で表示されたSmartScreen警告を利用者向け案内へ反映し、配布ファイルのSHA-256を別経路で伝える。

push、GitHub Release、外部配布は、それぞれ明示承認を得るまで行わない。
