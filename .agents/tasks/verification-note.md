# 検証ノート: 業務ダッシュボード実装（feature/online-business-ui）

design.md（第 3 改訂）/ plan.md に忠実に実装。review.json は不在だったため初回反復としてゼロから実装した。

## 実行コマンドと結果（worktree ルートで実行）

| コマンド | 結果 |
|---|---|
| `npm run lint`（eslint .） | **pass**（エラーゼロ） |
| `npx tsc --noEmit`（フロント。root tsconfig は `amplify`/`agents` を exclude） | **pass**（エラーゼロ） |
| `npx tsc --noEmit -p amplify/tsconfig.json`（バックエンド） | **pass**（エラーゼロ） |
| `npx vitest --run`（CDK 合成 + ユニット） | **pass**（16 files / 186 tests。ベースライン 153 → 186） |

> 注: root `tsconfig.json` は `"exclude": ["node_modules","amplify","agents"]` のため、
> `npx tsc --noEmit` だけでは `amplify/` を型チェックしない。バックエンドの型検証は
> `amplify/tsconfig.json` 指定の tsc と vitest（実行時）で担保した。

## 型での網羅性検出の確認（design §3.5 MEDIUM-1 / §11.2）

`handler.ts` の `execute()` から `case "roastingComplete"` を一時削除して
`npx tsc --noEmit -p amplify/tsconfig.json` を実行 →
`error TS2322: Type 'RoastingCompleteAction' is not assignable to type 'never'.` を確認（case を戻すとエラー消失）。
`const _exhaustive: never = action;` 方式が実際に効いている。

## 6 → 7 ルートの自動追従（design §11.2 MEDIUM-4）

`stack.test.ts` の `expect(nonOptions.length).toBe(LABELING_API_ROUTES.length)` は配列長比較のため
ルート 1 本追加（roasting-complete）で自動追従して緑。アサーションは変更していない。

## 依存追加

`@aws-sdk/util-dynamodb@3.996.9` を devDependencies に追加（`unmarshall` で
`ConditionalCheckFailedException.Item` を復元するため。design §3.5 MEDIUM-7）。
バージョンは `@aws-sdk/lib-dynamodb@3.1014.0` が要求する解決済み版に合わせた。

## 検証コア不変の確認

- `labeling-stream.ts` / `labeling-tables.ts` / `labeling-monitoring.ts` / `labeling-alarms.ts`、
  `seeder` / `labeling-worker` / `labeling-router` は変更なし（git diff で対象外）。
- `stack.test.ts` の Pipe/ESM 個数・MaximumConcurrency・SQS・GSI/Streams・wireSeederInvoke の
  既存アサーションは不変で緑。plan-seeder はイベントソースを持たず roast-batch 限定 PutItem のみ。
- 既存検証モード（画面 A〜D）は `isVisible?`（省略時 true）の伝搬 1 点のみの最小改変。表示時挙動・
  見た目・タブ構成は不変。

## ローカル/CI 不可（design §11.4）

実デプロイ（ampx sandbox）と 1000 多重の実機確認は SigV4・実 AWS が必要なため未実施。
フロント↔API 結合は Amplify Hosting デプロイ環境で確認する前提。

---

# 第 2 反復: review.json（5 ブロッキング）の修正

review.json の 5 件（BLOCK-1〜5）をすべて修正した。`semantic-review-b.md`（根拠）/
`semantic-review-a.md` を読み、ユーザー可視挙動を変える修正は無し（CSS Modules 境界内の
静的スタイル移設・業務画面専用の 44px クラス追加のみで、見た目の意味は不変）。

## 修正内容

- **BLOCK-1**（null 本文が 500）: `validateRoastingComplete` を `parsed: unknown` で受け、
  `typeof parsed !== "object" || parsed === null || Array.isArray(parsed)` を 400 にするガードを
  追加。`routes.test.ts` に「JSON の null 本文は 400」「配列/プリミティブ本文は 400」の 2 ケースを追加。
- **BLOCK-2**（4 分類が handler 未テスト）: `handler.test.ts` を新規追加（aws-sdk-client-mock で
  DynamoDBDocumentClient を差し替え）。成功=completed、Item 無し条件失敗=not_found、
  ROASTING_DONE=skipped、LABELING/LABELED/想定外=invalid、混在入力の 4 分類（unmarshall 経路）、
  想定外 AWS エラーの 500 契約を固定（6 ケース）。
- **BLOCK-3**（plan-seeder IAM が対象ロール/Resource を固定しない）: `stack.test.ts` のテストを
  刷新し、plan-seeder 関数 → 実行ロール論理 ID → そのロールに結び付く IAM Policy を特定。
  (1) DynamoDB action が `dynamodb:PutItem` ただ 1 つ（余分 action 不在）、(2) その Resource が
  roast-batch テーブル ARN に結び付くこと、を照合する。
- **BLOCK-4**（静的 inline style が CSS Modules 境界外）: 固定 margin/border/padding を
  `labeling.module.css` の名前付きクラス（`.spaceTopSm/Md/Lg/Xl`・`.listRowFlush`）へ移設。
  PackingPanel/QcPanel/LineMonitorPanel の TSX はクラス参照のみに。実行時データで変わる
  進捗バー幅（`style={{ width: n% }}`）は動的なため inline のまま残す。
- **BLOCK-5**（新規業務操作が 44px タップ領域未保証）: 検証画面を変えず業務専用の
  `.bizButton`（min-height:44px）と、44px 以上のクリック領域を持つ `.checkOption`（label 全体が
  クリック可能）を追加。業務 4 画面の操作ボタンを `.secondaryButton`→`.bizButton` に、RoastingPanel の
  checkbox を `<label className={checkOption}>` で囲んだ。検証画面が使う `.secondaryButton`（40px）は不変。

## 実行コマンドと結果（worktree ルートで実行・第 2 反復）

| コマンド | 結果 |
|---|---|
| `npm run lint`（eslint .） | **pass**（エラーゼロ） |
| `npx tsc --noEmit`（フロント） | **pass**（エラーゼロ） |
| `npx tsc --noEmit -p amplify/tsconfig.json`（バックエンド） | **pass**（エラーゼロ） |
| `npx vitest --run`（CDK 合成 + ユニット） | **pass**（17 files / 194 tests。186 → 194。+8 = handler.test.ts 6 + routes.test.ts 2） |

## 検証コア不変の確認（第 2 反復）

`git status` の変更は routes.ts / routes.test.ts / handler.test.ts(新規) / stack.test.ts /
CSS / 業務 4 コンポーネントのみ。検証コア（labeling-stream/tables/monitoring/alarms、
seeder/worker/router、handler.ts の既存ロジック）と検証画面（画面 A〜D・`.secondaryButton`）は
差分なし。handler.ts 本体には手を入れず、副作用動作の回帰テストのみを追加した。

---

# 第 3 反復: review.json（BLOCK-1 = plan-seeder 環境変数不整合）の修正

`review.json` / `semantic-review-b.md`（根拠）/ `semantic-review-a.md` を読んだ。ブロッキングは
1 件（BLOCK-1）のみ。非ブロッキング nit は NIT-1（500 で部分成功を失う＝設計 §3.5 が明示許容した
挙動）と NIT-2（レート表示の一瞬ジッタ＝設計 §8.3 指定の 2 サンプル方式に内在。許容範囲）で、
いずれも挙動変更を伴うため loop 内では変更しない（finding も「許容/親切なら補足」どまり）。
BLOCK-1 の修正はユーザー可視挙動を変えない（起動時に失敗していた経路を設計どおり成功させる）。

## 修正内容（BLOCK-1）

plan-seeder Lambda には roast-batch 名（`LABELING_ROAST_BATCH_TABLE_NAME`）だけが注入されるが、
handler が共通 `resolveTableNames()` を呼んでいたため `LABELING_UNIT_TABLE_NAME` も必須解決され、
手動 invoke が最初の PutItem より前に `RuntimeConfigError` で失敗していた。

- `runtime-config.ts`: roast-batch 名だけを解決する専用リゾルバ `resolveRoastBatchTableName()` を
  追加（既存 `resolveTableNames()` は seeder/worker 用にそのまま維持）。
- `plan-seeder/handler.ts`: `resolveTableNames()` → `resolveRoastBatchTableName()` に切替。
  unit テーブル名に一切依存しなくなった（「roast-batch だけを知る独立関数」という設計境界を保持）。
- `plan-seeder/handler.test.ts`（新規）: aws-sdk-client-mock で DynamoDBDocumentClient を差し替え、
  unit 名を未設定にしたまま (1) 全 10 件が roast-batch への条件付き PutItem に到達し inserted を返す、
  (2) 条件失敗は skipped に分類（冪等・巻き戻さない）、(3) 想定外 AWS エラーは throw、を固定。
- `runtime-config.test.ts`: `resolveRoastBatchTableName` の「unit 名なしで解決」「roast 名欠落で
  RuntimeConfigError」の 2 ケースを追加。

## 実行コマンドと結果（worktree ルートで実行・第 3 反復）

| コマンド | 結果 |
|---|---|
| `npm run lint`（eslint .） | **pass**（エラーゼロ） |
| `npx tsc --noEmit`（フロント） | **pass**（エラーゼロ） |
| `npx tsc --noEmit -p amplify/tsconfig.json`（バックエンド） | **pass**（エラーゼロ） |
| `npx vitest --run`（CDK 合成 + ユニット） | **pass**（18 files / 199 tests。194 → 199。+5 = plan-seeder handler.test.ts 3 + runtime-config.test.ts 2） |

## 検証コア不変の確認（第 3 反復）

`git status` の変更は `amplify/functions/plan-seeder/handler.ts` / 同 `handler.test.ts`(新規) /
`amplify/functions/shared/runtime-config.ts` / 同 `runtime-config.test.ts` の 4 ファイルのみ。
検証コア（labeling-stream/tables/monitoring/alarms、seeder/worker/router）と検証画面（画面 A〜D）、
labeling-api handler 本体・routes、業務 4 画面、CSS には差分なし。新リゾルバ追加は既存
`resolveTableNames()` を変更しないため seeder/worker の挙動も不変。

---

# 第 4 反復: review.json（BLOCK-1 + 非ブロッキング）の修正

`review.json` / `semantic-review-b.md`（根拠）/ `semantic-review-a.md` を読んだ。ブロッキングは
1 件（BLOCK-1 = ダークモードの業務ボタンが WCAG 2.1 AA 未達）。非ブロッキングは UX-1 / DEPLOY-1 /
NIT-1 / NIT-2。

## BLOCK-1（ダークモードの業務ボタンが AA 未達）

ダークモードの `--color-primary: #4da6e0` に `#fff` 文字を置くとコントラスト 2.68:1 で、通常文字に
必要な 4.5:1（WCAG 2.1 AA）を満たさない。影響は `.bizButton:hover`（白文字反転）と、RoastingPanel の
主要操作「焙煎完了を記録」が流用していた既存 `.primaryButton`。`.primaryButton` は検証画面
（UnitTracePanel / BatchRegisterPanel）と共有されるため、検証画面に影響を与えずに業務画面だけを
補正する方針を採った。

- `labeling.module.css`: 業務専用の `.bizPrimaryButton` を新設（ライト時は従来 primary と同系）。
  `@media (prefers-color-scheme: dark)` で `.bizPrimaryButton` 背景を `#1a6aad`（白文字で 5.66:1）、
  hover を `#176bb0`（5.58:1）、`.bizButton:hover` の背景も `#1a6aad`（5.66:1）に補正。
- `RoastingPanel.tsx`: 「焙煎完了を記録」ボタンを `.primaryButton` → `.bizPrimaryButton` に変更。
- 検証画面が使う `.primaryButton` は変更しないため、画面 A〜D の見た目は不変。
- focus-visible は背景ではなく outline で示すため配色補正の影響を受けない。

コントラスト実測（相対輝度計算）: 業務ボタンの通常/hover が ライト 5.04/7.27、ダーク 5.66/5.58。
すべて AA（≥4.5:1）を満たす。

## UX-1（後工程ワークリストが初回取得のまま残る）

全業務パネルを常時マウントする一方、PackingPanel / QcPanel はマウント時 effect でしか自動取得せず、
前工程完了後もタブ遷移直後は古い一覧を表示していた。全マウント方針（§7.4）を維持したまま、
タブ活性化時に再取得する `isActive` prop を追加。

- `PackingPanel.tsx` / `QcPanel.tsx`: `isActive` prop を追加し、`useEffect([isActive, load])` で
  アクティブ時のみ `load()` を呼ぶ（非アクティブ時は裏側の無駄な再取得をしない）。
- `BusinessDashboard.tsx`: `isActive={isVisible && active === N}` を各パネルへ伝搬。
  表示される一覧データ・操作・ARIA 構造は不変（鮮度のみ改善）。

## NIT-1（package-lock.json の churn と npm ci 不整合）

検証の結果、HEAD の `package-lock.json` は `npm ci` が **ERESOLVE で失敗**することを確認した
（直接依存に固定した `@aws-sdk/util-dynamodb@3.996.9` の peer が `@aws-sdk/client-dynamodb@^3.1111.0`
を要求し、固定済み client `3.1014.0` と衝突）。これは Amplify Hosting の `npm ci` を壊すため修正した。

- `package.json` / `package-lock.json`: `@aws-sdk/util-dynamodb` を `3.996.9` → `3.996.2` に変更
  （peer は `^3.1003.0` で、固定 client `3.1014.0` が満たす）。`lib-dynamodb@3.1014.0` が要求する
  `^3.996.2` とも一致するため単一版にデデュープされる。`overrides` に `@aws-sdk/util-dynamodb: 3.996.2`
  を追加し、transitive（lib-dynamodb 経由）も 3.996.2 に固定。
- lockfile は 3 参照（root spec / resolved+integrity / peer）＋ overrides のみの最小手編集に留め、
  無関係な floating 依存の再解決（copilotkit/ai/langchain 等の版上げ）は行っていない。
- 隔離ディレクトリで `npm ci` を実行し、util-dynamodb の ERESOLVE が解消されたことを確認。
  なお base/HEAD に元々存在する別の lockfile 同期ギャップ（zod・@types/express 等の floating 版ずれ、
  copilotkit の caret 解決）は本 finding の範囲外かつ修正には依存ツリー全体の再解決が必要になるため、
  本反復では触れていない。

## DEPLOY-1 / NIT-2（本反復では対応しない）

- **DEPLOY-1**: Amplify Hosting 上の plan-seeder→焙煎完了→付番→梱包→QC 通し結合は SigV4・実 AWS が
  必要でローカル/CI 不可（design §11.4）。リリース前スモークゲートとして残す（非ブロッキング）。
- **NIT-2**: warn/unknownBadge の生 hex はダーク分岐込みで AA を満たしており、action は「任意」。
  共有 globals.css への色変数追加は差分を広げるため、スコープ維持を優先して据え置いた。

## 実行コマンドと結果（worktree ルートで実行・第 4 反復）

| コマンド | 結果 |
|---|---|
| `npm run lint`（eslint .） | **pass**（エラーゼロ） |
| `npx tsc --noEmit`（フロント） | **pass**（エラーゼロ） |
| `npx vitest --run`（CDK 合成 + ユニット） | **pass**（18 files / 199 tests） |
| `npm ci`（隔離ディレクトリ・util-dynamodb 検証） | util-dynamodb の ERESOLVE 解消を確認 |

コントラストは相対輝度計算で業務ボタン全状態が AA（≥4.5:1）を満たすことを確認（上記実測値）。

## 検証コア不変の確認（第 4 反復）

変更は `labeling.module.css`（業務 primary クラス追加 + dark 補正）/ `RoastingPanel.tsx`（クラス差替）/
`PackingPanel.tsx`・`QcPanel.tsx`・`BusinessDashboard.tsx`（`isActive` 伝搬）/ `package.json`・
`package-lock.json`（util-dynamodb 版整合）のみ。検証コア（labeling-stream/tables/monitoring/alarms、
seeder/worker/router）、labeling-api handler/routes、plan-seeder、検証画面（画面 A〜D・`.primaryButton`）
には挙動差分なし。業務パネルの再取得追加は表示データ・操作・ARIA を変えず鮮度のみ改善する。
