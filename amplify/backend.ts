import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource.js';
import { data } from './data/resource.js';
import { getVerificationConfig } from './custom/verification-config.js';
import { LabelingTables } from './custom/labeling-tables.js';
import { LabelingFunctions } from './custom/labeling-functions.js';
import { LabelingApi } from './custom/labeling-api.js';
import { LabelingStream } from './custom/labeling-stream.js';
import { LabelingMonitoring } from './custom/labeling-monitoring.js';
import { LabelingAlarms } from './custom/labeling-alarms.js';

/**
 * Amplify Gen 2 バックエンド合成（design §10 / 要件 12）。
 *
 * 既存 `defineBackend({ auth, data })`（Cognito + Todo モデル）は変更・削除しない
 * （要件 12.1 / 12.4）。本 PoC の全リソースは `backend.createStack('SqsLabelingPoc')` の
 * ネストスタックに置き、検証終了後に sandbox 削除でこのスタックだけを一括破棄できる状態を
 * 保つ（要件 12.2 / 非機能 2）。クロススタック参照は LabelingApi（Cognito オーソライザー）→
 * `backend.auth.resources.userPool` の一方向のみで循環しない（design §2.2）。
 *
 * 配線順序（design §10）:
 *   getVerificationConfig()（1 度だけ解決・全 Construct と GET /config に共有）
 *   → LabelingTables → LabelingFunctions → LabelingApi(userPool)
 *   → functions.wireSeederInvoke(api)（labeling-api に seeder 起動権限/環境変数）
 *   → LabelingStream（入口 + SQS + worker ESM の配線）
 *   → LabelingMonitoring → LabelingAlarms
 */
const backend = defineBackend({
  auth,
  data,
});

// 本 PoC のネストスタック（要件 12.2）
const stack = backend.createStack('SqsLabelingPoc');

// 検証パラメータを 1 度だけ解決して共有（design §4.1 / §10）
const config = getVerificationConfig();

const tables = new LabelingTables(stack, 'LabelingTables', { config });

const functions = new LabelingFunctions(stack, 'LabelingFunctions', {
  tables,
  config,
});

const api = new LabelingApi(stack, 'LabelingApi', {
  handlers: { api: functions.api },
  // クロススタック参照（一方向）。既存 auth の User Pool を流用する（決定 1 / 要件 12.1）
  userPool: backend.auth.resources.userPool,
});

// labeling-api に seeder の lambda:InvokeFunction と関数名の環境変数を付与（design §6.5）
functions.wireSeederInvoke(api);

const stream = new LabelingStream(stack, 'LabelingStream', {
  tables,
  functions,
  config,
});

new LabelingMonitoring(stack, 'LabelingMonitoring', {
  functions,
  tables,
  stream,
  config,
});

const alarms = new LabelingAlarms(stack, 'LabelingAlarms', {
  functions,
  tables,
  stream,
});

// フロントが参照する出力（design §10 / §4.4）。
// labelingApiUrl は amplify_outputs.json の custom.labelingApiUrl に載る
backend.addOutput({
  custom: {
    labelingApiUrl: api.url,
    alarmTopicArn: alarms.topicArn,
    relayMode: config.relayMode,
    labelingMaxConcurrency: String(config.labelingMaxConcurrency),
  },
});
