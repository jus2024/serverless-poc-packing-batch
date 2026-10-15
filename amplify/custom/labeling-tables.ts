import { Names, RemovalPolicy } from "aws-cdk-lib";
import {
  AttributeType,
  Billing,
  ProjectionType,
  StreamViewType,
  TableV2,
} from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";
import {
  getVerificationConfig,
  type VerificationConfig,
} from "./verification-config.js";

/**
 * 検証用の DynamoDB テーブル 2 本（design §3 / §4.2、要件 3 / 1.6 / 11 / 12.2）。
 *
 * ## 本 PoC のテーブル構成（参考 EC PoC `order-tables.ts` を踏襲）
 *
 * Lot `1─<N` RoastBatch `1─<N` Unit の 3 階層のうち、Lot はテーブルを作らず Unit に
 * `lot_id` 属性として持たせる（design §3）。全テーブルは接頭辞 `kiro-roasters-`、
 * `Billing.onDemand()`（PAY_PER_REQUEST）、`RemovalPolicy.DESTROY`（検証終了後に
 * スタックごと一括破棄できる状態を保つ。要件 12 / 非機能 2）。
 *
 * - `kiro-roasters-unit`（主役）: Streams で滞留する側。`StreamViewType.NEW_IMAGE`
 *   （後続は新規イメージだけを読む。要件 2 / 1.6）。GSI1 `batch-units-index`（画面 D の
 *   batch トレース）/ GSI2 `lot-trace-index`（画面 D の lot トレース）はいずれも
 *   `projectionType=ALL`（画面 D が `status` / `best_before` / `qr_payload` / `labeled_at` を
 *   返すため基表への追加読み取りを避ける。要件 11.3）。
 * - `kiro-roasters-roast-batch`: 投入指示＋完了集計。Streams なし・GSI なし
 *   （画面 B の一覧は `Scan` + フィルタで足りる規模。design §3.2）。
 *
 * ## `unit_count` を unit に非正規化する（design §3.1 / レビュー第 3R HIGH-1・案 B）
 *
 * worker の完了遷移は条件式 `labeled_count = :n` の `:n` に当該 batch の `unit_count` を
 * 束縛する必要がある。worker が参照する入口は SQS ペイロードだけであり、Pipes 経路は
 * その本文を Streams の `NewImage`（= unit レコード）からしか射影できない。そのため
 * **unit レコード自体に `unit_count` を持たせる**のが Pipes/中継 Lambda 両方式で成立する
 * 唯一の素直な解である。属性の追加は seeder（§6.1）が行い、テーブル定義は PAY_PER_REQUEST の
 * スキーマレスなので本 Construct では GSI/Streams の構造だけを固定する。
 *
 * ## warm throughput を設定しない（design §4.2）
 *
 * 本作は SQS 側の多重が主役で、unit テーブルへの書き込みは seeder の `BatchWriteItem` と
 * worker の `UpdateItem` に限られる。オンデマンドのバーストで足りるため warm throughput は
 * 設定しない（前作の知見。GSI にも設定しない）。射影 `ALL` の GSI は基表と同量の書き込みを
 * 受けるため、GSI 側の `WriteThrottleEvents` も観測対象にする（要件 7.5。§8.1）。
 */

/** unit テーブルの GSI 名（design §3.1 / §4.2）。 */
export const BATCH_UNITS_INDEX_NAME = "batch-units-index";
export const LOT_TRACE_INDEX_NAME = "lot-trace-index";

/**
 * Lambda へ渡すテーブル関連の環境変数キー（design §4.2）。
 * 実行時側 `shared/runtime-config.ts` の `ENV_KEYS` が同じキーを読む。
 * キー名のブレを防ぐため定数化し、`stack.test.ts` で突き合わせる（design §6.6 / §16）。
 */
export const LABELING_TABLE_ENV_KEYS = {
  unitTableName: "LABELING_UNIT_TABLE_NAME",
  roastBatchTableName: "LABELING_ROAST_BATCH_TABLE_NAME",
  batchUnitsIndexName: "LABELING_BATCH_UNITS_INDEX_NAME",
  lotTraceIndexName: "LABELING_LOT_TRACE_INDEX_NAME",
  unitStreamArn: "LABELING_UNIT_STREAM_ARN",
} as const;

export interface LabelingTablesProps {
  /**
   * 物理テーブル名の接頭辞。
   *
   * @default 'kiro-roasters'（design §3.3）
   */
  readonly tableNamePrefix?: string;

  /**
   * 物理テーブル名の末尾に付ける一意サフィックス（design §3.3）。
   * 空文字を渡すと固定名になる（単一専用アカウント向け。衝突の責任は呼び出し側）。
   *
   * @default 構築パスとスタック名から算出した 8 文字
   */
  readonly tableNameSuffix?: string;

  /**
   * 解決済みの検証パラメータ。
   *
   * @default `getVerificationConfig()`（環境変数から解決）
   */
  readonly config?: VerificationConfig;
}

/** unit / roast-batch テーブルをまとめて定義する Construct（design §4.2） */
export class LabelingTables extends Construct {
  /** 主役テーブル。Streams(NEW_IMAGE) 有効・GSI 2 本（design §3.1） */
  readonly unitTable: TableV2;

  /** 投入指示＋完了集計テーブル。Streams なし・GSI なし（design §3.2） */
  readonly roastBatchTable: TableV2;

  /** unit テーブルの GSI 名（画面 D のトレース照会で使う） */
  readonly batchUnitsIndexName = BATCH_UNITS_INDEX_NAME;
  readonly lotTraceIndexName = LOT_TRACE_INDEX_NAME;

  constructor(scope: Construct, id: string, props: LabelingTablesProps = {}) {
    super(scope, id);

    // config は現時点でテーブル構造に影響しないが、全 Construct と props 形を揃え、
    // 将来テーブル側に検証パラメータが波及したときの受け口を残す（参考 EC PoC と同じ）
    props.config ?? getVerificationConfig();
    const prefix = props.tableNamePrefix ?? "kiro-roasters";
    const suffix = props.tableNameSuffix ?? defaultNameSuffix(this);
    const name = (logicalName: string) =>
      [prefix, logicalName, suffix].filter((part) => part !== "").join("-");

    this.unitTable = new TableV2(this, "UnitTable", {
      tableName: name("unit"),
      // PK は unit_id 単独（SK なし）。`UNIT#...` 形式の冪等キー（design §3.1）
      partitionKey: { name: "unit_id", type: AttributeType.STRING },
      // 後続は新規イメージだけを読む（要件 2 / 1.6）。NEW_IMAGE で十分
      dynamoStream: StreamViewType.NEW_IMAGE,
      // オンデマンド（PAY_PER_REQUEST。design §3）。上限は設けない
      billing: Billing.onDemand(),
      globalSecondaryIndexes: [
        {
          // 画面 D: batch 指定のトレース（要件 11.1）
          indexName: BATCH_UNITS_INDEX_NAME,
          partitionKey: { name: "batch_id", type: AttributeType.STRING },
          sortKey: { name: "unit_id", type: AttributeType.STRING },
          // 射影 ALL（画面 D が全属性を返すため基表への追加読み取りを避ける。要件 11.3）
          projectionType: ProjectionType.ALL,
        },
        {
          // 画面 D: lot 指定のトレース（要件 11.2）
          indexName: LOT_TRACE_INDEX_NAME,
          partitionKey: { name: "lot_id", type: AttributeType.STRING },
          sortKey: { name: "unit_id", type: AttributeType.STRING },
          projectionType: ProjectionType.ALL,
        },
      ],
      // 検証終了後にスタックごと消せる状態を保つ（要件 12 / 非機能 2）
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.roastBatchTable = new TableV2(this, "RoastBatchTable", {
      tableName: name("roast-batch"),
      // PK は batch_id 単独（SK なし）。`BATCH#...` 形式（design §3.2）
      partitionKey: { name: "batch_id", type: AttributeType.STRING },
      billing: Billing.onDemand(),
      // Streams なし / GSI なし。一覧は Scan + フィルタで足りる規模（design §3.2）
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  /**
   * unit テーブルの Streams ARN（design §4.2）。
   * Pipes の source（`labeling-stream.ts`）・router の `DynamoEventSource` が繋ぐ対象であり、
   * `LABELING_UNIT_STREAM_ARN` の環境変数（`labeling-functions.ts`）でも渡す。
   *
   * @throws {Error} Streams が無効な場合（この Construct では起こらないが、
   *   props の変更で静かに壊れるのを防ぐ）。
   */
  get unitStreamArn(): string {
    const arn = this.unitTable.tableStreamArn;
    if (!arn) {
      throw new Error(
        "unit テーブルの Streams が無効です（design §3.1 は NEW_IMAGE を要求します）",
      );
    }
    return arn;
  }

  /**
   * Lambda へ渡すテーブル関連の環境変数（design §4.2）。
   * 名前は合成時に決まるトークンであり、文字列として比較してはいけない。
   */
  get tableEnvironment(): Record<string, string> {
    return {
      [LABELING_TABLE_ENV_KEYS.unitTableName]: this.unitTable.tableName,
      [LABELING_TABLE_ENV_KEYS.roastBatchTableName]:
        this.roastBatchTable.tableName,
      [LABELING_TABLE_ENV_KEYS.batchUnitsIndexName]: this.batchUnitsIndexName,
      [LABELING_TABLE_ENV_KEYS.lotTraceIndexName]: this.lotTraceIndexName,
      [LABELING_TABLE_ENV_KEYS.unitStreamArn]: this.unitStreamArn,
    };
  }
}

/**
 * 物理テーブル名の既定サフィックス（design §3.3）。
 *
 * `Names.uniqueResourceName` は「最上位スタック名 + 構築パス + 8 文字のハッシュ」を返す。
 * ここではハッシュ部分だけを使う。スタック名がハッシュの入力に含まれるため、
 * sandbox / ブランチが違えば別の値になり名前が衝突しない。同じスタックを再デプロイする
 * 限り値は変わらない（テーブルの作り直しは起きない）。参考 EC PoC と同じ考え方。
 */
function defaultNameSuffix(scope: Construct): string {
  return Names.uniqueResourceName(scope, { maxLength: 12 }).slice(-8).toLowerCase();
}
