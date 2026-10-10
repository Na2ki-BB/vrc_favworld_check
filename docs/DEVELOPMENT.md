# 開発ガイド

この文書は、開発環境の準備、検証、配布ファイルの作成手順をまとめています。利用者向けの導入手順は[README](../README.md)を参照してください。

## 必要な環境

- Node.js 22.13.0以降の22系、または24以降とnpm。`package.json` は22以上を指定していますが、ロックされたESLintの依存関係にはこの条件が必要です
- 動作確認用のWindows版Google Chrome 120以降
- Windowsインストーラーを生成する場合はInno Setup 6

ソースはJavaScriptのES Modulesです。JSDocと `checkJs` によるstrict型検査を行い、テストにはNode.js標準のテストランナーと `fake-indexeddb` を使います。

## 準備と基本コマンド

リポジトリのルートで実行します。

```sh
npm ci
npm run verify
```

`npm run verify` は以下を順に実行します。Windowsインストーラーの生成や実ブラウザでの確認は含みません。

1. ESLint
2. TypeScriptによるJavaScriptの型検査
3. 全テストとカバレッジ計測
4. 配布元の検査と拡張のビルド

| コマンド | 用途・出力 |
| --- | --- |
| `npm run lint` | 静的解析 |
| `npm run typecheck` | 型検査のみ。ファイルは生成しない |
| `npm test` | 全テスト |
| `npm run test:coverage` | 全テストとカバレッジの表示 |
| `npm run build` | 検査後、`extension/` を `dist/extension/` へコピー |
| `npm run package:extension` | ビルドとChrome用ZIPの生成 |
| `npm run build:installer` | ビルドとWindowsインストーラーの生成 |
| `npm run package` | ビルド、ZIP、Windowsインストーラーの生成 |
| `npm run icons` | 拡張アイコンの再生成 |

関連するテストだけを実行する例です。

```sh
node --test tests/domain.test.js
node --test tests/auth-status.test.js tests/auth-status-ui.test.js
node --test tests/database.test.js tests/backup.test.js tests/backup-archive.test.js tests/backup-ui.test.js
```

変更後は関連テストを実行し、最後に `npm run verify` で全体を確認します。カバレッジ計測は設定されていますが、自動の最低カバレッジ閾値は設けていません。

## Chromeで読み込む

1. `npm run build` を実行します
2. Chromeで `chrome://extensions/` を開き、「デベロッパー モード」を有効にします
3. 「パッケージ化されていない拡張機能を読み込む」から `dist/extension/` を選択します
4. ソース変更後は再ビルドし、Chromeの拡張機能画面で再読み込みします

保存データを引き継ぐ確認では、同じChromeプロフィールと読み込み先を使います。利用中の拡張を削除したり、別フォルダーを読み込んだりする前に記録と保存済み画像を含むZIPバックアップを確認してください。従来のJSONには画像が含まれません。削除・移行の検証には専用のChromeプロフィールとダミーデータを使います。実利用者の記録・画像・バックアップをテスト用ファイルとして保存しないでください。

## テストの担当範囲

| テスト | 主に確認する内容 |
| --- | --- |
| `api.test.js` | ページング、入力上限、必要項目の抽出、認証要求、転送拒否、再試行 |
| `auth-cookie-bridge.test.js` | 一時Cookieの属性、既存Cookieとの競合、中断・片付け |
| `auth-status*.test.js` | ログイン確認の状態、60秒キャッシュ、同期との分離、画面表示 |
| `domain.test.js`、`favorite-groups.test.js` | 2軸の状態遷移、リスト履歴、初回・復帰・重複抑止 |
| `database.test.js`、`backup.test.js` | 原子的保存、世代競合、移行、JSON互換性、非表示・完全削除 |
| `backup-archive.test.js`、`backup-ui.test.js` | ZIPの構造・CRC・容量、画像の参照・検証、記録と画像の一括復元、既存画像の保持 |
| `background.test.js` | 同期全体、通知、アラーム、画像の継続処理、削除との競合 |
| `thumbnail.test.js` | 画像URL、転送先、形式・サイズ・画素数、縮小、失敗分類 |
| `ui.test.js` | 絞り込み、要確認表示、画像の状態、記録操作、画面の安全性 |
| `schedule.test.js`、`dnr.test.js` | 待機期限、起動時の復旧、限定したUser-Agentルール |
| `manifest.test.js`、`installer-config.test.js`、`release-scripts.test.js` | 権限、配布対象、インストーラー入力、ZIP再現性 |

テスト内のChrome APIや画像処理の代替実装、ソース検査は、実ブラウザ・実API・Windowsでの検証を置き換えるものではありません。

### 変更時に維持する条件

- 8リスト・800ワールドで、先頭・中間・末尾の変化を欠落なく比較する
- 一覧の部分取得、401、429、通信障害、5xx、転送、形式不正で、保存済み状態を誤更新しない
- Cookie値や不要な認証応答をDB・ログ・バックアップへ渡さず、所有が不明なCookieを削除しない
- 名前・状態の保存後、303件・800件の画像を専用アラームとWorker再生成を経て処理し、主要APIを再取得しない
- 画像取得の期限、最大3回の試行、429の待機、失敗理由、既存画像保持を守る
- DB version 1・2・3から4への移行と、JSON version 1・2・3の読み込みを維持する
- ZIP内の非表示・完全削除状態を保持し、画像の追加・更新、既存画像の保持、削除済みIDの画像消去を記録と同時に確定する
- 壊れたZIP・参照不整合・デコード不能な画像・容量超過を、保存済み記録と画像を変えずに拒否する
- 復元・完全削除後の古い同期計画、画像Blob、ジョブが記録を再生成しない
- 非表示は同期・通知を止めず、完全削除は他ワールド・他アカウントの記録に影響しない
- 通知の最大1回試行、未読の正確性、内訳不明時の表示を維持する
- ログイン確認と同期履歴を混同せず、レート制限と認証処理の競合を共有制御する

## 配布ファイルの作成

通常の拡張パッケージは次のコマンドで生成できます。

```sh
npm run package:extension
```

Windowsインストーラーも生成する場合は、Inno Setup 6のコンパイラー `ISCC.exe` を利用できる環境で実行します。

```sh
npm run package
```

コンパイラーはPATHや標準の導入先から検索します。別の場所にある場合は環境変数 `INNO_SETUP_COMPILER` に実行ファイルのパスを指定します。Windows上、またはWindows版コンパイラーを実行できるWSL環境を想定しています。通常のLinux環境でZIPを作成できても、Windowsインストーラーを生成できるとは限りません。

生成物は `artifacts/` に出力されます。

- `vrc_favworld_check-v<version>.zip`
- `vrc_favworld_check-installer-v<version>.exe`

各生成スクリプトはSHA-256を標準出力へ表示します。チェックサムファイルを自動作成するコマンドではありません。

ビルドではmanifestの版・権限・禁止項目、配布ファイル、秘密情報に見える文字列を検査します。インストーラー生成前には `package.json`、ソースとビルド済みmanifestの版、およびソースとビルドのファイル一覧・内容の一致を確認します。ZIPは並び順と時刻を固定し、同じ内容から同じバイト列を生成します。インストーラーのバイト単位の再現性まで保証するものではありません。

`package` 系コマンドはlint・型検査・全テストを実行しないため、配布前に別途 `npm run verify` を実行します。

### GitHub Actionsで下書きReleaseを作る

`.github/workflows/windows-draft-release.yml` は、`main` の最新コミットに対する手動実行だけを受け付けます。実行画面の `release_version` には `package.json` と同じ `x.y.z`（先頭の `v` なし）を入力します。標準の `windows-2022` GitHub-hosted runner 1台の同一jobで検査、ZIPとEXEの生成、SHA-256一覧の生成、新しい下書きReleaseへの添付までを行います。

- `package-lock.json` に対して `npm ci --ignore-scripts` を使い、Actionは完全なcommit SHA、Node.jsは `22.23.3`、runner組み込みのInno Setupは出力を無効化した最小スクリプトの検査コンパイルでengine version `6.7.1` と確認して固定します。setup-nodeのpackage-manager cacheも明示的に無効化します。固定値とrunnerの内容が変わった場合は失敗させ、変更をレビューしてから更新します。
- workflowの権限は通常 `contents: read`、Releaseを作るjobだけ `contents: write` です。追加secretやPATは使わず、checkout後に認証情報を残しません。
- `upload-artifact` とActions cacheは使いません。成果物は同一jobからReleaseへ直接添付するため、Actions artifact/cacheの保存領域を消費しません。
- 同時実行を直列化し、入力版、manifest版、`origin/main` の最新SHAを検査します。Release作成の直前にGitHub APIで対象SHAの軽量タグを原子的に新規作成し、同じGitタグ、下書き、または公開済みReleaseがあれば、タグ移動・再利用・上書き・asset追加をせず失敗します。
- 作られるReleaseは必ず下書きです。workflowは公開、既存Releaseの編集、assetの `--clobber` を行いません。失敗して不完全な下書きまたはこの実行が作ったタグだけが残った場合は内容を確認し、必要なものだけを手動で削除してから再実行します。

下書き作成後はEXE、ZIP、`SHA256SUMS.txt`をダウンロードしてハッシュを照合し、次節の実機確認を記録します。問題がないことを確認した担当者だけがGitHub上で手動公開します。workflowの成功は実機確認や公開承認を意味しません。

## 配布前の実機確認

対象のWindowsとChromeで確認し、実行した環境と結果をレビューに記録します。未実施の項目を合格扱いにしません。

1. 新規導入後、固定配置フォルダーから読み込み、公式サイトのログイン・2FA後に同期できる
2. ログイン確認を開き直しても通信を過剰に繰り返さず、通信不能をログアウトとして表示しない
3. 100件を超える一覧、複数リスト、名前・作者・画像の保存を確認できる
4. 正常終了後にAPI用一時Cookieと所有マーカーが残らない。Cookieの値は表示・撮影・記録せず、存在と属性だけを確認する
5. 画像の取得・縮小・DB保存・Blob表示を確認し、画面を閉じた後とChrome再起動後も残りの処理を続けられる
6. 初回、要確認0件、確認待ち、通信失敗、検索0件、画像未保存・読み出し失敗・表示失敗を区別できる
7. 非表示、戻す、完全削除、確認のキャンセル、Escape、二重操作、別タブ更新、画面遷移後の操作対象を確認する
8. 320・375・768・1040px相当の画面幅、ポップアップ、200%拡大、長い名前、キーボード、フォーカス、強制配色で操作できる
9. ZIPの書き出しと復元を確認し、保存済み画像、非表示・完全削除状態、設定、他アカウントの記録が正しく扱われることを確認する。JSON version 1・2・3の復元、バックアップにない既存画像の保持、削除済みIDの画像消去、過去通知の非再送も確認する
   - 画像未保存・0件、復元のキャンセル・連打、同期や別画面の操作との競合、壊れたZIPやデコード不能画像の拒否を確認する
10. 直前の配布版からの更新と同版再インストールで、拡張ID、保存履歴、DB移行結果を維持できる。古い版への上書きを拒否する
11. インストーラーをDownloadsから削除しても固定配置の拡張が動き、更新時の権限承認・再読み込みを案内どおり行える
12. 全記録消去、Chrome側削除、Windows側削除の順で利用を終了できる。途中失敗時のデータ状態と再試行案内も確認する

Windows固有の配置・更新・削除条件は[インストーラー仕様](INSTALLER.md)、データ処理の境界は[セキュリティ](SECURITY.md)と[プライバシー](PRIVACY.md)を参照してください。

## 変更と公開時の確認

DB、バックアップのJSON・ZIP、イベント種別、画面からの命令は互換性のある契約として扱います。API、権限、通信先、認証処理を変更する場合は、実装・テストと関連文書を同時に更新します。

公開前に差分と成果物を確認し、Cookie、バックアップ、ログ、環境変数ファイル、ローカル専用ファイルを含めないでください。自動検査は公開内容のレビューを省略する理由にはなりません。
