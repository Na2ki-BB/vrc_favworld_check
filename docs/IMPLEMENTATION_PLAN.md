# vrc_favworld_check 実装・検証計画

## 1. 完了定義

本製品は、利用者がVRChat公式サイトでログインした既存セッションを使い、最大8リスト・800ワールドの現在状態を端末内へ記録できることを完了条件とする。名称変更、リスト移動、一覧からの消失、アクセス不可と復帰を誤断定せず履歴化し、開発者サーバー、資格情報入力、利用者によるDB保守を必要としないことを必須とする。

公開候補は次のrelease gateをすべて満たす必要がある。

- VRChat Creator Guidelinesと現行コミュニティOpenAPIを再確認している。
- manifestに資格情報・閲覧履歴へアクセスする権限がない。
- lint、strict typecheck、全テスト、coverage計測、build、公開物の秘密検査が成功し、未実行の主要分岐がないことをレビューする。
- 800ワールド、8リスト、DB v1移行、backup v1互換、削除失敗の各fixtureが成功する。
- 配布ZIPが複数タイムゾーンで同一になる。
- 実利用者のCookie、バックアップ、ログ、`.env`、ローカル専用文書がGit追跡対象にない。

## 2. 採用する構成

| 領域 | 採用 | 理由 |
| --- | --- | --- |
| 実行環境 | Chrome / Edge Manifest V3拡張 | 公式Webログインをブラウザへ委ね、追加アプリなしでUI・定期実行・通知を提供できる |
| 永続DB | 拡張origin内のIndexedDB `vrc-favworld-check` | サーバー費用と利用者によるDB導入が不要。transactionとschema migrationを利用できる |
| 開発者DB | 使用しない | 利用者データと秘密を開発者が保持しない |
| 認証 | VRChat公式サイトの既存セッション | パスワード、2FA、Cookie値、tokenを製品の管理対象にしない |
| API | 読み取り専用GET | VRChat側の状態を変更しない |
| 通知 | OS通知 + 永続未読バッジ | OS通知欠落時も履歴を正本として確認できる |
| 配布 | Store用MV3 packageを正本 | 非IT利用者には自動更新できるStore配布が最終形。公開申請までは署名なしZIPで検証する |

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

1. グループAPIの部分障害と同期全体の障害境界を分離する。
2. commit後に未読バッジをDBから再構築する。
3. 36時間の同期停滞と個別確認待ち件数をstatusへ公開する。
4. 全消去では永続gate、alarm停止、利用者recordの原子的消去、自己アンインストールを順序固定し、全repository書込みが同じtransaction内でgateを検査する。

出口条件は、401・429・network・5xx・redirectでDB不変、グループschemaまたはID同一性だけの不調では以前の名称を保持してworld同期成功、DNR不成立時fetch 0、削除失敗時uninstall 0、既存の削除guardからの再試行でguardを解除せず自己アンインストールまで再実行できることである。

### Phase 4: UI・利用者保護

1. カード、検索、フィルターへ利用者設定のリスト名を表示する。
2. 800件を200件ずつ段階表示する。
3. 未読、同期停滞、グループ情報の鮮度、保存件数・概算容量を平易な日本語で示す。
4. 全消去前に対象件数、最終backup日時、外部JSONが残ることを確認する。

出口条件は、API文字列をHTMLとして解釈する経路がなく、キーボード操作とvisible focusを維持し、固定エラーコードごとに次の操作が表示されることである。

### Phase 5: 配布・実環境確認

1. 再現可能なmanifest直下ZIPとSHA-256を作る。
2. ChromeとEdgeの新規profileでsideload smoke testを行う。
3. 利用者本人の環境で、公式ログイン、最大件数、リスト名、alarm、通知、backup、復元を確認する。
4. 外部公開の承認後だけChrome Web Store / Edge Add-onsへ提出する。

Store審査、開発者登録、実アカウントでのAPI応答確認はローカル実装だけでは完了できないため、コードのrelease gateと分けて扱う。

## 4. リスクの判断

| リスク | 判断 | 実装上の扱い |
| --- | --- | --- |
| 800件の一覧比較 | 保有 | bulkページングと全ID比較を維持し、専用回帰テストを追加 |
| 個別GET最大20件 | 保有・軽減 | API保護のため上限維持。2回目404を優先し待ち件数を表示 |
| 非公式API変更 | 保有・軽減 | strict schema、部分障害境界、固定エラー、releaseごとの仕様確認 |
| ブラウザ終了中に同期不可 | 保有 | 次回起動時にalarm修復。OS設定や常駐アプリを追加しない |
| OS通知欠落 | 軽減 | IndexedDB履歴と未読バッジを正本にする |
| 履歴の長期増加 | 保有・軽減 | core履歴は消さず、同期記録だけ整理し、容量警告と全消去を提供 |
| ローカルDBが平文 | 保有 | 認証情報を保存せず、OSアカウント・ディスク保護を前提にする |
| 手動配布の導入・更新 | 回避 | Store用packageを維持し、外部公開承認後にStoreを第一導線にする |
| アンインストール後の残存 | 軽減 | DB論理削除を確認してから自己削除。外部JSON・物理痕跡は保証外と明示 |

## 5. 変更管理

- schema、backup、message、event kindはversioned contractとしてテストする。
- API raw objectをrepositoryやloggerへ渡さない。
- 依存追加、権限追加、通信先追加は個別の脅威レビューなしに行わない。
- 修正は関連テストから始め、最後に全検証を一度通す。
- push、Store提出、外部サービス送信は、ローカル検証と公開対象監査の後に明示承認を得て実行する。
