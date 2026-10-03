# 配色とワールド記録管理の仕様

更新日: 2026-10-03

温白・濃い文字・控えめな緑の画面と、記録の非表示・復帰・完全削除を定義する。VRChat側のお気に入りを変更せず、Chrome内の記録だけを管理する。DB schema 4、JSON backup 3を使用し、旧JSON 1・2の読み込みを維持する。画像ZIP、認証方式、権限、インストーラー、リリース版番号は対象外とする。

## 1. 今回の画面要件

### 1.1 配色と見た目

レイアウト、文字サイズ、情報階層を基本的に保つ。popupは370px、dashboardは最大1040px。画像192px・16:9を維持し、狭い画面では既存の縦積みに従う。画像・ワールド名が最初に目に入る。装飾的な光彩、青いグラデーション、大きな新設heroは導入しない。

| 用途 | 色 | 適用 |
| --- | --- | --- |
| ページ背景 | #F7F6F2 | popup/dashboard、温かい白 |
| カード・入力面 | #FFFFFF | world、history、設定、dialog |
| 本文 | #252923 | 見出し、ワールド名、通常テキスト |
| 補足 | #5C635A | 作者・時刻・説明・placeholder |
| 主要操作 | #356447 | 主要ボタン背景、白文字、link、focus |
| 緑の淡い面 | #E7EEE7 | 選択中・正常状態の補助面 |
| 装飾境界 | #D4D8CF | カード・区切り。操作識別をこの線だけに依存しない |
| 入力・ボタン境界 | #7B8178 | 操作の輪郭が必要な白面 |
| 注意 | #725321 / #FAF0D9 | 確認中・注意。文字と面 |
| 危険 | #8B3028 / #F8ECE9 | 不可逆操作・エラー。文字と面 |
| 無効面 | #E9EAE4 | disabled、文字 #5C635A |

算出済みコントラスト: 本文/背景13.67:1、補足/背景5.73:1、白文字/主要緑6.85:1、入力境界/白4.00:1、注意文字/注意面6.23:1、危険文字/危険面7.12:1。通常文字4.5:1以上、操作・focus3:1以上を実装時にも検証する。hoverの一律brightnessは明色面で判別が弱くなるため、緑の濃淡・下線・境界で明示する。

- `color-scheme: light` とnative select/checkboxの見え方を揃える
- 警告は色だけで表さず、既存の「現在アクセスできません」「確認中」等の状態語を残す
- primaryは各画面の主要導線だけ。「削除」は強いprimaryにせず、危険色の文字を使う控えめな補助操作
- focusは3pxの濃緑＋offset。白/温白/淡い状態面上で確認する
- targetは基本44px、狭いリンクでも24px以上。既存native link・details・Back/Forwardを維持する
- 英語section-labelの派手な強調は弱める。文言の全面書き換えや新しいフォント導入はしない

### 1.2 popup

既存構造のまま、要確認の要約 → 「名前と画像を見る」 → 確認操作・最終確認 → 画像保存状況の順序を維持する。popupに削除UIは追加しない。

要確認件数からhiddenを除外する。hiddenしかない場合も「保存済み記録なし」と誤表示しない。保存総数はhiddenを含む。通常要確認が0件で非表示記録があるときは補足に「非表示の記録がN件あります。記録画面で確認できます」を置く。

### 1.3 ワールド画面

- 既存3ナビゲーション（ワールド / 変更履歴 / 設定とバックアップ）を保つ
- 消えた可能性が確定した通常カードにだけ「削除」ボタンを追加する
- 対象条件は `membershipState === not_in_favorites || availabilityState === unavailable`。確認中や通常お気に入りのカードには出さない
- カードの画像・名前・補足・状態・詳細の並びを保ち、操作は状態行の後ろ/末尾に置く。名称へ重ねない
- 通常の「すべての記録」もhiddenを除外し、optionを「すべての記録（非表示を除く）」にする
- 絞り込みselectに「非表示の記録」を追加。検索語・作者・旧名・リスト絞り込みは同じ仕組みを使う
- 一覧上部、既存検索detailsの外に小さな「非表示の記録（N件）」linkを置く。常に発見可能とし、0件でも入口は維持する
- routeは `#hidden` を追加。既存 `#attention` / `#all` / `#events` / `#settings`、不明hashのfallbackを壊さない
- hidden一覧では同じ画像・名前・状態を表示し、「非表示」ラベル、「戻す」「完全に削除」を付ける。完全削除は通常一覧には出さない
- hidden一覧の説明: 「一覧から非表示にした記録です。名前・画像・履歴は残っており、同期と通知は続きます」
- hiddenが元の状態へ自然復帰しても非表示を自動解除しない。「戻す」でだけ通常一覧へ戻す
- 「戻す」成功後はhidden一覧から該当カードが消え、「一覧に戻しました」を通知。直後の同期は開始しない。すでに利用可能なら「すべての記録」で見られ、消失条件が残れば通常の要確認一覧にも戻る
- 変更履歴にはhiddenも引き続き表示し、対象の名称横に「非表示」を添える。閲覧・既読化だけでカードを隠さない
- 設定の保存件数は実保存総数。必要な内訳は「ワールドN件（非表示M件）」とし、操作後の0件と区別する

## 2. 操作・確認文言

### 2.1 通常カードの「削除」

1. 対象名・画像・アカウントを特定した確認dialogを開く
2. タイトル: 「この記録を一覧から削除しますか？」
3. 本文: 「『{ワールド名}』を通常の一覧から隠します。名前・画像・変更履歴は残り、『非表示の記録』から戻せます。同期と通知は続きます。VRChatのお気に入りは変更しません」
4. ボタン: 「キャンセル」「一覧から削除」
5. キャンセル/Escape/戻るでデータを変更しない。既定focusはキャンセル
6. 確認成功後にだけカード・件数を更新し、「一覧から非表示にしました」をrole=statusで知らせる。未確認の結果を成功扱いしない

### 2.2 非表示一覧の「戻す」

可逆であるため追加confirmは不要。明示操作で表示状態だけ解除する。画像・履歴・名称・既読・通知claim・最終API観測時刻を変更しない。成功後のfocusは次カードの操作、なければ前カード、空なら一覧見出しへ移す。

### 2.3 非表示一覧の「完全に削除」

通常のhide確認とは別のdialog。

タイトル: 「このワールドの記録を完全に削除しますか？」

本文:
「『{ワールド名}』の保存名・画像・変更履歴を、このブラウザから完全に削除します。この操作は取り消せません。
現在のJSONバックアップには画像が含まれないため、削除した画像はJSONから戻せません。
同じ記録の再表示を防ぐためWorld IDだけを残します。今後、VRChatのお気に入りで利用可能と確認できた場合は、新しい記録として保存します。
VRChatのお気に入りや、ほかのワールドの記録は変更しません」

- 最新の保存状態がfavoritedかつaccessibleなら「現在は利用可能なため、次回の確認で新しい記録として保存される可能性があります」を条件付きで追記する。別の抑止flagや操作対象制限は追加しない
- アカウント表示名・world名・World IDを対象情報として表示。名前不明でもIDで確認できる
- 可能なら対象の保存画像有無と履歴件数を表示。確認用読取り失敗時は削除を開始しない
- ボタンは「キャンセル」「完全に削除」。キャンセルへ初期focus。色は危険色、不可逆ボタンをprimary緑にしない
- 同期/実行中の画像保存/別の記録変更/復元/全消去と競合していれば開始を拒否し、終了後の再試行を案内する。画像が次回待ちの状態は操作可能
- 実行中は二重送信を無効化。閉じる場合でも完了を推測せず、再表示時にDBを確認する
- 成功はtransaction commit後にのみ返す。UI更新失敗は「削除は完了しました。表示を再読み込みしてください」と区別する
- ユーザーが以前保存したJSONファイルはこの操作で変更できない。古いJSONを明示的に復元すれば名称・履歴が戻ることは、バックアップ復元確認で説明する

### 2.4 dialogのアクセシビリティ

新規2dialogはnative `<dialog>.showModal()` を使う。タイトル/説明の関連付け、Tab封じ込め、Escape取消、背景inert、閉鎖後focus復帰、長い日本語・World ID・200%zoom・320px幅を検証する。画面遷移/アカウント切替ではdialogを閉じ、古い対象へのsubmitを無効化する。既存backup/purgeのconfirm全面置換は今回しない。

## 3. データ設計（最小追加）

### 3.1 変更前の構成

- IndexedDB schemaは3。storeはprofiles/worlds/thumbnails/favoriteGroups/events/syncRuns/settings/meta
- worldの主キーは `[userId, worldId]`。画像は別storeのBlobで、JSONには入らない
- `dataGeneration:userId` とworld revisionで古い同期/画像書込みを拒否している
- `reconcileWorlds` は前回worldと今回favorite relation/metadata IDの和集合から作る。単純削除だけではrelationに残るIDが次回再作成される
- `replaceProfileData` は対象profileのworld/event/groupを置換するが既存画像を残す
- 未読はprofile単位の件数だけ。旧event単位の既読情報はない
- dashboardの他tab更新検知はactiveProfileId/lastSuccessfulSyncAt主体のため、削除専用の変更検知を足す必要がある

### 3.2 schema4と `worldDispositions`

新storeを1つ追加。主キー `[userId, worldId]`、by-user index。

| state | 保存field | 意味 |
| --- | --- | --- |
| hidden | userId, worldId, state:"hidden" | 記録は保持、通常一覧のみ非表示 |
| purged | userId, worldId, state:"purged" | 名前・画像・履歴は存在せず、IDだけの再生成抑止 |

表示中はこのstoreに行を持たない。WorldRecordのAPI状態フィールドへhiddenを混ぜず、同期がUI状態を上書きしないようにする。時刻/名称/画像URL/旧履歴をpurged行へ残さない。

不変条件:
- hiddenのIDにはworldが存在する
- purgedのIDにはworld/thumbnail/eventが存在しない
- 1IDにhidden/purgedが重複しない
- すべてprofileで分離。他アカウントの同一World IDへ影響しない
- 表示状態変更はAPI由来のイベントを作らず、world.updatedAt・revisionを変更しない

metaへ `presentationGeneration:userId` を追加（未作成時は0扱い）。hide/戻す/完全削除/backup復元で増加。`dataGeneration` はhide/戻すでは増やさず、完全削除/復元/同期では従来に沿って増やす。表示だけの操作で無関係な画像ジョブを無効化しない。

migrationは新store追加と後述の未読互換metaのみ。既存world/event/画像/設定/通知claim/状態/世代を壊さない。v1→v4/v2→v4/v3→v4、新規v4をカバーし、失敗時はupgrade transaction全体abort。DB `backupFormatVersion` は3へ。

### 3.3 repositoryの変更

- 表示用snapshot（worlds/events/favoriteGroups/dispositions/generation/presentationGeneration/profile）は一つのreadonly transactionで取得し、混在snapshotを出さない
- `getSyncSnapshot` にdispositionsを含める
- `getProfileStats` は保存総数と通常一覧のattention/missing/unavailable件数を分け、hiddenCountを返す。世代番号と表示集計は同じreadonly transactionで読み、GET_STATUSが新世代と旧件数を組み合わせないようにする
- `hideWorld` / `restoreHiddenWorld` / `purgeHiddenWorld` を追加。任意store名や任意keyを受けない
- action入力は検証済み userId/worldId、画面の期待generation/presentationGeneration/world revision。状態を再読して対象と権限範囲を確認
- hideはまだ表示中の消失確定worldに限定。restore/完全deleteはhiddenに限定。状態が変わっていたら更新要求を返し、古い確認内容で続行しない
- 全writeは既存purgePending guardを守る。削除方法/対象をUIの表示だけに依存しない
- clearProfile/purgeAllDataに新storeと新metaを含める。全消去とアンインストールの現在の安全性を弱めない

## 4. 同期・画像・競合

### 4.1 hidden

同期入力に通常どおり含める。画像取得・名前更新・旧名保持・状態履歴・通知も既存どおり。通常の一覧・要確認表示件数だけから除く。戻した後の再同期でhiddenに戻ったり、履歴がbaselineへ戻ったりしない。

### 4.2 purgedと新規再登録

purged IDを取得済みfavorite relationだけからworld化しない。個別probe候補にも追加しない。削除済みIDの定期的な全件probeを導入しない。

次の「通常同期で得られた、新たな利用可能のお気に入り証拠」でだけ抑止を解除する:
- 完全取得できた今回の `/worlds/favorites` にcanonical IDと正常な名前等のmetadataがある、または
- 今回のfavorite relationに同IDがあり、既存の通常取得対象として得た同worldの正常な200 detailがある

relationだけ、404、未知、失敗/部分snapshot、過去syncの結果だけでは解除しない。お気に入りを外した過去worldを、単に閲覧可能という理由だけで勝手に再登録しない。sourceから再発見されないpurged IDはそのまま保持する。

再登録はworld作成とpurged行削除を同一sync transactionで行う。初回名・初回時刻をその取得時点から開始し、旧イベントや旧画像を復活させない。再登録そのものを「名称変更」「復帰」として通知しない。後続の新しい変化は通常どおり履歴にする。

同期replanは毎回最新dispositionsで入力をフィルタする。保存するplanのevents/worlds/thumbnail候補から抑止IDを落とす。抑止解除は、API取得前のinitialSnapshotにpurged行があり、そのsnapshotのgenerationで初回commitできる場合だけ許可する。generation conflict後のreplanでは、すでに取得済みのAPI結果を使った抑止解除を一切許可しない（ほかのworldの通常replanは継続）。これにより途中で削除されたIDを古い200で即復活させず、次の新しい通常同期で再判断できる。削除時刻等をpurged行へ追加せず、既存世代で区別する。commit直前にもdispositionとgenerationを検証する。

### 4.3 mutationの順序

既存SyncServiceの単一flightとthumbnail mutation lockへ、記録操作を小さく追加する。新たな汎用状態管理frameworkは作らない。

1. Service Workerの閉じたcommandで処理する。UIから直接破壊的repository操作を呼ばない
2. 同期/画像batch実行中は `SYNC_IN_PROGRESS`。pending/waitingの画像jobは許可
3. 同一Service Worker内でrecord mutationの予約を先に置き、新たなsync/thumbnail/purgeを短時間開始させない
4. lock内で最新のactiveProfile、generation、world/disposition、pending jobを確認
5. repository transaction実行。終了後のみbadge/表示更新・画像alarm修復をbest-effortで行う
6. エラー時も予約解除。alarm修復失敗は「データ保存成功、画像予定の修復は保留」と分ける

別dashboardの直接backup復元やService Worker再起動に対しては、in-memory lockではなくDBの期待generationとpurge guardが最終防御になる。

### 4.4 完全削除transaction

transaction対象: worlds、thumbnails、events、worldDispositions、settings、meta（必要なprofile検証を含む）。

- 対象worldを1件削除
- 同profile・同worldのthumbnail Blobを削除
- 同profile・同worldのすべての名称/状態/リスト変更eventを削除
- hiddenをpurgedへ置換
- 未読追跡から対象分のみ更新（次節）
- dataGenerationとpresentationGenerationを増加
- 同profile・現世代の有効なthumbnailJobが存在すれば対象IDをitemsから除き、残りitemsのattempts/元URL/取得時刻/backoffを保持して新generationへ更新。空ならcomplete/nextAttemptAt=null
- 同profileでも世代不一致の古いjobには対象ID/画像URLが残り得るため、対象itemを除去する。ただし残りの古いjobを新世代へ昇格・再実行しない。空ならjobを消す
- 構造不正jobでもuserIdが対象profileと厳密一致し、再利用不可と判定できるものはjob全体を廃棄する。所有profileを安全に特定できない壊れたjobは、他profileへ影響させないため削除transactionをabortし、保存状態の不整合として報告する。壊れたraw値/画像URLをログやエラー本文へ出さない
- 他profileと確認できるpending jobには触らない
- 画像cursor等に対象IDやURLが残る場合は対象だけ除去し、progressは残りitemsから再算出
- 途中で失敗したらすべてrollback。対象以外の画像・world・event・group・診断syncRunは維持する

既存 `putThumbnail` のgeneration・対象world存在・activeProfileチェックを残し、purged行も拒否する。旧batchのBlob/ checkpointが遅れて返っても削除済画像を再作成できない。元worldが後日新規再登録された場合も旧generationの画像は受理しない。

## 5. 未読の整合性

hide/戻すでは未読件数を変更しない。変更履歴を開く既存の既読化でのみ通常の未読を消す。通知送信済みと既読を混同しない。

旧DBには未読の対象event情報がないため、完全削除時に「対象の履歴件数を未読から単純減算」「全件既読化」「時刻順から推測」のいずれも採用しない。

最小互換案:
- metaにprofile別の未読追跡 `{ legacyCount, legacyWorldIds, legacyUncertain, byWorld }` を持つ
- upgrade時の既存未読件数をlegacyCountへ移し、当時eventを持つworld ID集合をlegacyWorldIdsへ。byWorldは空。upgrade直後の表示件数は変えない
- 以後の新規event commitだけbyWorldへworld別加算。重複event再commitは加算しない
- 完全削除でbyWorldの対象分だけ除去。legacyCount>0かつ対象がlegacyWorldIdsに含まれる場合だけ、legacyUncertain=trueにする。対象IDは集合から除去する
- legacyWorldIdsが空になればlegacyCount=0・uncertain=false（旧履歴が全て対象ごと削除されたため）
- exact時はlegacyCount＋byWorld合計を表示。uncertain時は数字を捏造せず、badgeを「?」、設定欄を「未読件数は未確定」、補足を「記録の削除前の未読内訳を確認できません。変更履歴を開くと通常の表示に戻ります」とする
- 変更履歴を開いた既存のmarkEventsReadでlegacy/byWorldを同一transactionで空にし、以後は正確な件数へ戻す。画面未読表示と拡張badgeは共通のsummaryに従う
- backup復元は従来どおり既読として取り込み、追跡metaを空にする。未読追跡はJSONへexportしない

これは旧データの欠落を正確に扱うための互換処理であり、新しい読書/通知機能を追加するものではない。既存getUnreadCountだけをUIが参照し続けないよう、summaryのexact/uncertainをpopup/dashboard/badgeへ同じ意味で通す。

## 6. バックアップと復元

### 6.1 JSON version3

新しいexportはversion3。既存profile/worlds/favoriteGroups/events/preferencesに `worldDispositions` を追加する。hiddenのworld・名前・履歴とhidden行を含める。purgedはIDとstateだけを含み、world/画像/eventは含めない。

- 画像Blobは今回もJSONへ含めない。画像ZIPは別作業のまま
- raw API、認証情報、世代番号、job、通知の秘密情報、未読metaは追加しない
- v1/v2 JSONは引き続き読み込める。未知fieldの厳格reject、サイズ/件数/深さ/型/ID/所有者検証を維持する
- v3 dispositionsもallowlist/同profile/重複禁止/hiddenのworld存在/purgedのworld・event不存在を検査。名前/URLを持つpurged行は拒否
- dispositions件数の上限は10,000（保存world上限とは別、JSON総25MiB上限も維持）。上限を超えると勝手に抑止IDを落とさずexportを止め、制限理由を表示する
- v3ファイルは旧アプリでは読めない。復元UIに「この形式を復元するには対応する最新版が必要」を明示し、旧版互換v2 exportの別UIは作らない

### 6.2 復元の意味

復元は今と同じ「そのprofileの記録をファイル内容で置換」。新形式では表示/抑止状態もそのファイルを正とする。旧形式はその状態を持たないため、取り込むworldは通常表示となり、そのprofileの既存dispositionsは消える。

確認に以下を追加する:
- 「表示/非表示・削除済みIDの扱いもバックアップの状態へ戻ります」
- 旧形式なら「この旧形式には非表示・削除済みIDがありません。以前に削除した名前や履歴がファイルに含まれていれば、記録へ戻ります」
- 「画像はこのJSONから復元できません。端末に残っている画像は引き続き利用します」

v3でpurgedと明示されたIDについては、復元先に残っている対象thumbnailも同じtransactionで削除する。そうしないとpurgedに画像が残る不変条件違反となる。それ以外の画像は現行どおり保持する。旧形式の復元で削除済画像を生成/復元することはない。

restore完了でdataGeneration/presentationGenerationを増加し、古いUI読取り/画像jobを無効化する。対象profileの古いpending画像jobは廃棄する（バックアップは画像URLを含まないため安全な再生成不可）。保存済Blobは上記例外以外維持。次の通常同期で最新metadataから画像jobを作る。復元だけでAPI呼出しや過去通知再送を開始しない。

## 7. 他tab・アカウント・画面ライフサイクル

- GET_STATUSへactiveProfileのdataGeneration/presentationGeneration/hiddenCount/未読summaryを追加
- dashboardは既存3秒の可視時pollとvisibilitychangeで世代も比較し、変化したらloadData(null,true)。lastSuccessfulSyncAt不変のhide/戻す/削除でも反映する。追加の常時pollや新permissionは不要
- popupも既存pollで件数を再取得する
- 再描画後も選択filter・search・paginationを保ち、dialog操作やfocusを無断で奪わない
- command開始時にprofile ID/world ID/期待世代を固定する。アカウントが変われば再確認を求め、別profileへ対象を読み替えない
- loadDataのprogressEpoch、thumbnailRenderGeneration、pageClosed、repository identityの既存ガードを全新操作へ適用
- hide/deleteにより消えるcardのobjectURLはrevokeする。遅延hydrateで消したcardが復活しない
- 確認dialog表示中に対象状態/アカウント/世代が変わればsubmit無効化し「記録が更新されました。もう一度確認してください」。実行後の不明な応答はDBを再読し、二重削除を自動実行しない
- 戻る/進む/不正hash/ページを閉じる/再表示を試験する。新しい#hiddenは既存worlds panelのフィルター状態として扱う

## 8. 受入条件・テスト

### 機能

- F01 消失確定カードに「削除」、通常/確認中カードに表示されない
- F02 hide確認を取消すと一切writeしない。confirmで通常/検索/件数から外れ、画像・名称・履歴・通知は保持
- F03 既読化、再読込、次回同期、アカウント切替を経てもhidden維持。元worldが利用可能へ復帰しても自動表示しない
- F04 hiddenから戻すと通常表示へ戻る。同期・通知・履歴の過去分を再発生させない
- F05 完全削除はhiddenからのみ、別confirmで対象の名前/画像/履歴だけを消す。他world/他profileを維持
- F06 relationにIDが残り404/unknownでも次回同期で再生成しない。API失敗/部分取得で抑止を解除しない
- F07 後日の利用可能なfavorite metadataで新規再登録。旧名/旧画像/旧履歴を戻さず、再登録時の変更/復帰通知なし
- F08 非favの単独200を理由に再加入させない。purged IDの全件probeなし、既存20件上限維持
- F09 hidden件数・通常attention件数・保存総数・thumbnail件数・未読・badgeを区別し一致させる

### 移行・復元・競合

- D01 新規v4、v1/v2/v3→v4成功。upgrade failureで既存データ不変
- D02 hide/戻すはdataGeneration不変で、待機中画像jobの残り件数・世代を壊さない
- D03 完全削除transactionの全途中失敗注入でworld/画像/event/抑止/未読/世代が全rollback
- D04 同期中/画像batch中拒否、現世代の待機画像jobから対象だけ除去し残りが継続できる。旧世代jobでも対象ID/URLは残らず、古いjobを新世代へ昇格しない。構造不正jobの同profile廃棄/所有不明abort/別profile維持を検証
- D05 古いsync commit・replan・画像Blob書込み・画像checkpointが対象を復活させない
- D06 同期/画像/restore/purge・別tab操作の競合、同じWorld IDの別profile分離、activeProfile変更を検証
- D07 旧未読件数はupgradeだけでは変更なし。確実な対象分だけ減算。旧分の不明時は不明表示で無関係な未読を既読扱いしない
- D08 markRead後・JSON復元後の未読は0。後続新規eventでは正確集計。通知claimを既読判定に流用しない
- D09 v1/v2を復元可、v3 roundtripでhidden/purged維持。未知field/重複/別user/矛盾/容量超過をwrite前にreject
- D10 v3のpurged対象画像を残さず、その他画像維持。旧JSONから画像を復元したと誤表示しない
- D11 stale UI、応答消失、二重click、別tab変更の最大既存poll間隔での反映、終了/再起動後の永続結果を確認

### UI

- U01 popup370px、dashboard1040pxと320/375/768px、200%zoom、長い日本語/長名/World IDで横overflowや切れなし
- U02 警告/エラー/空状態/同期中/画像なし/画像読込失敗/disabled/selected/hover/focus/forced-colorsの各stateを確認
- U03 keyboardだけで検索、filter、削除confirm取消/確定、hidden戻す/完全削除confirm、Escape、Back/Forward可能
- U04 modal focus trapと復帰先、削除による対象DOM消失、live statusの過剰読み上げ/無言失敗なし
- U05 色contrastを最終CSSから再計算。主要画像/名称の視認性が操作追加前より劣らない

### 実施する検証

既存 `npm run verify`（lint → typecheck → test:coverage → build）を最終変更後に実行。focused testだけを全通過と報告しない。synthetic fixtureを用いたブラウザ実画面確認でpopup/dashboard/各dialogと競合操作の画面を保存する。実ユーザーの記録をQA用に削除しない。
