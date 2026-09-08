# Windows 簡易インストーラー設計

この文書は、Windowsインストーラーが行うことと、導入・更新・削除を安全に確認する基準をまとめた開発者向け資料である。利用者向けの手順は[README](../README.md)を参照する。対象は、Windows版Google Chromeの画面操作で拡張機能を導入する利用者である。

## 1. インストーラーの役割

インストーラーは、検証済みの拡張ファイルをWindowsユーザーごとの固定場所へ配置し、Chromeへ追加する画面を開く。

- 固定場所: `%LOCALAPPDATA%\Programs\VRCFavoriteWorldHistory\extension`
- 作成方式: Inno Setup 6
- 権限: 現在のWindowsユーザーだけで実行し、管理者権限やUACを要求しない
- 登録: Windows標準の「インストールされているアプリ」から削除できるよう、Inno Setup標準のユーザー単位アンインストール情報を登録する
- 同梱内容: ビルド時に検証した `dist/extension` 一式

Chromeの通常の画面からローカル拡張を登録するため、初回だけ利用者が「パッケージ化されていない拡張機能を読み込む」を選ぶ。インストーラーは必要な画面とフォルダーを自動で開き、日本語の手順を表示する。

## 2. 配布物の作成

`npm run package` は次の順で配布物を作成する。

1. `extension/` を検査して `dist/extension` を作る。
2. `package.json`、source manifest、built manifestのバージョンが一致することを確認する。
3. sourceとbuildのファイル一覧および各ファイル内容が一致することを確認する。
4. 再現可能なChrome用ZIPを `artifacts/vrc_favworld_check-v<version>.zip` として作る。
5. 検証済みの `dist/extension` をInno Setupへ渡し、`artifacts/vrc_favworld_check-installer-v<version>.exe` を作る。
6. ZIPとインストーラーのSHA-256を出力する。

manifestへ固定の `key` を埋め込まず、同じWindowsユーザー、同じChromeプロフィール、同じ固定場所を使うことで、更新時も同じローカル拡張として扱われる構成にする。extension IDと履歴が実際に保持されることは、配布前の実機更新試験で確認する。

## 3. 初回導入

1. 利用者がインストーラーを実行する。
2. インストーラーが拡張ファイルを固定場所へ配置する。
3. 完了時にChromeの `chrome://extensions/` と、選択する `extension` フォルダーを開く。
4. 利用者はChromeで「デベロッパー モード」をオンにする。
5. 「パッケージ化されていない拡張機能を読み込む」を押し、開いている `extension` フォルダーを選ぶ。
6. Chromeが権限を表示した場合は、Cookie利用と接続先が `vrchat.com`、`vrchat.cloud`、`api.vrchat.cloud`、画像配信先 `files.vrchat.cloud` であることを確認して許可する。
7. 拡張の案内に従い、VRChat公式サイトでログインしてから「今すぐ確認」を押す。

`vrchat.com` は公式Webログインのセッション確認、`api.vrchat.cloud` はVRChat API通信、`vrchat.cloud` は親domainに同名Cookieがないことを確認するために使う。`files.vrchat.cloud` は画像APIから転送されるサムネイルだけをCookieなしで取得する。権限の理由を初回案内とREADMEから確認できるようにする。

## 4. 更新

更新時は既存のChrome登録とブラウザ内の履歴を維持するため、次の手順で同じ固定場所だけを切り替える。

1. 利用者へChromeの全ウィンドウを閉じるよう表示する。ブラウザの作業を失わせないため、インストーラーからChromeを強制終了しない。
2. インストール済みmanifestの `x.y.z` バージョンを検査する。新しい版から古い版への置換はDBや設定の互換性を壊す可能性があるため拒否し、同じ版の再インストールは修復用途として許可する。
3. 新版全体を同じapp rootの `extension.new` へ先に展開する。
4. manifest、バージョン、主要ファイルを検証できた場合だけ、既存 `extension` を `extension.old` へ移し、`extension.new` を `extension` へ切り替える。
5. 切替または新版の検証に失敗した場合は `extension.old` を元へ戻す。
6. 新版の固定配置を確認した後に `extension.old` を削除する。復旧用の退避は1世代に限定する。
7. 更新完了後にChromeの拡張機能画面を開き、有効状態、表示バージョン、権限を確認する。古い版が表示される場合だけ、同じ拡張の「再読み込み」を1回押す。

前回の中断で `extension` がなく `extension.old` だけが残っている場合は、更新を始める前に旧版を元へ戻す。両方が残っている場合は古い退避を片付けてから新版を配置する。安全な状態を確認できない場合は既存ファイルを上書きせず、Chromeを閉じて再実行するよう案内する。

## 5. アンインストール

記録を端末から消したい場合は、次の順序を利用者へ案内する。

1. 必要な履歴があれば、拡張の設定画面からJSONバックアップを保存する。
2. 拡張の「記録をすべて削除して拡張を削除」を実行する。
3. 拡張が一時Cookieの不在を確認し、Chrome内の記録と画像を原子的に消去してから自分自身をChromeから削除する。
4. Windowsの「インストールされているアプリ」から VRC Favorite World History を削除する。

Windowsアンインストーラーが削除するのは、固定app root内の `extension`、一時的な `extension.new` と `extension.old`、Inno Setup自身の固定ファイルだけである。Chromeプロフィールを探索すると他の閲覧データを誤って扱う危険があるため、Chrome内の記録消去は拡張自身が担当する。

書き出したJSONバックアップは利用者が再利用できる記録なので、Windowsアンインストーラーの削除対象にしない。不要になったバックアップは、内容と保存先を利用者が確認してから通常のファイル操作で削除する。

JSONバックアップには名前や変更履歴が入るが、容量の大きいサムネイル画像は入らない。拡張の全消去ではChrome内の保存画像も削除され、アクセスできなくなったワールドの画像は後から再取得できない。この影響を確認画面とREADMEで説明してから削除を実行する。

## 6. Windows側で扱う範囲

インストーラーは拡張ファイルの配置・更新・削除だけを担当し、ChromeとVRChatに関わる処理はインストールされた拡張と公式サイトへ分離する。

- Chromeプロフィール、Cookie、IndexedDBをインストーラーから探索・変更しない。これは利用者のブラウザデータを固定app rootの外で扱わないためである。
- 認証、API通信、同期、履歴保存、バックアップは拡張内で行う。インストーラーはVRChatへ通信しない。
- browser policyやforce installを使わず、利用者がChromeの標準画面で拡張を確認して追加する。
- service、scheduled task、startupを登録せず、定期確認はChrome拡張のalarmで行う。
- telemetryや実行時ダウンロードを使わず、配布物に同梱した検証済みファイルだけを配置する。
- Windows設定の変更は、Inno Setup標準のユーザー単位アンインストール登録に限定する。

現行の配布物にはコード署名がないため、Windows SmartScreenが未認知の実行ファイルとして警告する場合がある。READMEでは、インストーラーを渡した人の確認と警告画面の進み方を案内する。SHA-256は配布ファイルを詳しく確認する利用者向けの任意情報として提供する。警告画面の文言は対象実機で確認し、READMEの手順と一致させる。

## 7. 検証基準

### 7.1 自動検証

- `npm run verify`: lint、strict typecheck、全テストとcoverage、拡張ビルドを実行し、失敗とskipが0件であることを確認する。
- installer設定テスト: Windowsユーザー単位の固定path、非昇格、製品固有 `SetupMutex`、同時実行防止、downgrade拒否、同版再導入、1世代の復旧、app root限定削除を確認する。
- 安全境界テスト: custom registry、browser policy、force install、service、scheduled task、startup、telemetry、Chromeプロフィール探索を行う設定がないことを確認する。
- `npm run package`: sourceとbuildの一致を再確認し、再現可能なZIPとInno Setup 6インストーラーを生成する。
- 成果物監査: packageとmanifestのバージョン、manifest `key` の不在、ファイル名、サイズ、SHA-256、秘密情報とローカル専用ファイルの不在を確認する。

### 7.2 対象実機での受け入れ確認

自動検証に加え、対象のWindows PCとGoogle Chromeで次を確認する。

1. 新規導入で固定場所が作られ、Chromeの管理画面と選択用フォルダーが開き、利用者が拡張を追加できる。
2. Downloads内のインストーラーを削除してChromeを再起動しても、固定場所から拡張が動作する。
3. 同版を再インストールしてもextension IDと既存履歴が保持される。
4. 直前の配布版から現行版へ上書き更新し、extension ID、履歴、DB schema version 3への移行結果が保持される。
5. 更新後にChromeの表示バージョンと、`cookies`、`vrchat.com`、`vrchat.cloud`、`api.vrchat.cloud`、`files.vrchat.cloud` の権限を確認できる。更新案内の「今すぐ確認」を一度だけ押すと、以前の版で未保存だった画像も専用アラームで自動取得できる。画面に残数が表示され、Chrome再起動後も再開する。
6. 公式Webログイン後、100件を超えるワールドページとサムネイル取得を含む完全同期が成功し、同期後にAPI用一時Cookieが残らない。
7. 必要なバックアップを保存し、拡張画面の全消去・自己アンインストール、Windows側アンインストールの順で削除できる。
8. Windows側の削除後も、app root外のファイル、Chromeプロフィール、利用者が保存したJSONバックアップが変更されない。
9. 実際のSmartScreen表示とChromeの権限表示が、利用者向け手順の説明と一致する。

実機で確認していない項目は、自動テストや推測で完了扱いにしない。配布、GitHub Release、pushは、上記確認と公開対象監査を終えた後に明示承認を得て実行する。
