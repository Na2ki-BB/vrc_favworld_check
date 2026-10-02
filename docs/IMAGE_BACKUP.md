# 画像込みバックアップ設計

## 目的

従来のJSONバックアップを壊さず、Chrome内に保存済みのWebPサムネイルも別の環境へ移せるようにする。認証情報、Cookie、同期中の一時状態、通知キュー、ログは対象にしない。

## 利用者向け形式

- 記録のみ: 従来の `.json`。format version 1 / 2 の読み込みを継続する。
- 記録と画像: `.zip`。archive version 1。

ZIPの内容は次の3種類だけとする。

```text
backup.json
thumbnails/index.json
thumbnails/<world-id>.webp
```

`backup.json` は従来JSONと同じスキーマで、単独でも既存validatorを通る。`index.json` は画像のWorld ID、固定パス、寸法、byte数、取得時刻、検証済みVRChat画像URLだけを持つ。

## 復元の意味

- 対象profileのワールド、リスト、履歴、許可済み設定は従来どおりバックアップ内容へ置き換える。
- 他profileは変更しない。
- ZIP内の画像は同じIndexedDB transactionで追加または更新する。
- ZIPに含まれない既存画像は削除しない。
- JSONだけの復元でも既存画像を削除しない。
- 検証失敗時はtransactionを開始しない。不整合や書き込み失敗時は記録と画像をまとめてrollbackする。

## ZIPの安全境界

一般的なZIP展開は行わず、必要最小限のstored ZIPだけを専用parserで読む。

- 上限: archive全体64MiB、JSON 25MiB、画像index 5MiB、画像1件48KiB、画像最大10,000件
- UTF-8の通常ファイルだけを許可
- 圧縮、暗号化、data descriptor、extra field、comment、multi-disk、Zip64を拒否
- 絶対パス、ドライブ名、`..`、`.`、空要素、backslash、未知entry、重複entryを拒否
- central/local headerの名前、方式、CRC、サイズ、offsetが一致することを確認
- entryの重なり、gap、末尾の隠しdataを拒否
- indexにない画像、画像のないindex、別profile／未知world／重複worldを拒否
- WebP構造、寸法、byte数、VRChat画像URLを再検証

## 秘密情報を含めない仕組み

記録部分は従来のallowlist serializerを再利用する。画像indexも固定fieldだけから新しいobjectを作る。次は出力しない。

- password、2FA code、Cookie、token、session、authorization header
- rate-limit、次回実行、画像job、purge guardなどの端末運用状態
- ログ、例外、任意URL、未知field

## UI

設定画面の操作は3つに限定する。

1. 記録のみをJSONへ書き出す
2. 記録と保存済み画像をZIPへ書き出す
3. JSONまたはZIPを選んで復元する

ZIP生成中は他の書き出しと復元を無効化する。復元前に既存の同期中確認と利用者確認を行う。
