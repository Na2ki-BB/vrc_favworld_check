# Windows 簡易インストーラー計画

## 目的と対象

- PC 操作に詳しくない知人 1 名が実際に使う Google Chrome だけを対象にする。
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
5. Downloads 内のインストーラーは導入後に削除できると案内する。

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
- Cookie、profile、IndexedDB、認証、API、同期、DB、backup の実装変更
- Windows 10/11 両方、Chrome/Edge 両方、複数 profile、全障害点、ProcMon、複数 AV の網羅
- push、GitHub Release、外部配布

## 検証

- 自動: installer 設定の静的テスト、manifest の `key` 不在、lint、型検査、全テスト、
  `npm run verify`、`npm run package`、Inno Setup compile。
- 知人の実 PC / 実 Chrome: fresh install、Downloads の installer 削除後の動作、同版再インストール、
  1 回の上書き更新、更新前後の extension ID と履歴保持、正規順序のアンインストール。
- コード署名をしないため、SmartScreen が未認知の実行ファイルとして警告する残余リスクを受容し、
  配布時にファイル名と SHA-256 を別経路で確認する。

## 実装状況と残作業（2026-08-18）

ローカル実装と開発環境での検証は完了している。

- Inno Setup 6.7.3 を Windows ユーザー単位で導入し、`.iss` の実コンパイルに成功した。
- `npm run verify` は lint、型検査、12 テスト、build をすべて成功し、失敗・skip は 0 件だった。
- `npm run package` は検証済み `dist/extension` から ZIP と未署名 Windows installer を生成した。
- installer config test は固定 path、非昇格、`SetupMutex`、禁止機能不在、manifest `key` 不在、
  downgrade 拒否、単一世代 rollback、app root 限定削除を固定した。
- 最終レビューで見つかったインストーラー二重起動の競合は、製品固有 `SetupMutex` を追加して解消した。

知人への配布前に、次の実機受け入れ試験が残る。

1. 知人の実 PC / 実 Chrome で fresh install し、管理画面と Explorer が開き、日本語案内から
   unpacked 拡張を読み込めることを確認する。
2. Downloads 内の installer を削除し、Chrome を再起動しても固定 path の拡張が動作することを確認する。
3. Chrome を閉じた状態で同版再インストールを 1 回行い、extension ID と履歴が変わらないことを確認する。
4. 現行 `0.1.0` より新しい検証済み版を用意して上書き更新を 1 回行い、extension ID と履歴の保持、
   `extension.old` が成功後に残らないことを確認する。
5. 必要なら JSON backup、拡張 UI の全消去・自己アンインストール、Windows 側アンインストールの順で削除し、
   app root 外、Chrome profile / Cookie / IndexedDB、JSON backup が Windows 側から削除されないことを確認する。
6. 実機で表示された SmartScreen 警告を知人向け案内へ反映し、配布ファイルの SHA-256 を別経路で伝える。

push、GitHub Release、知人への外部配布は、それぞれ明示承認を得るまで行わない。
