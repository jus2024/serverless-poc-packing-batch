"use client";

import LabelingDashboard from "@/src/components/labeling/LabelingDashboard";
import styles from "@/src/components/labeling/labeling.module.css";

/**
 * トップページ: SQS 付番バッチ処理 PoC の検証ダッシュボード（design §11.1 / 要件 12.5）。
 *
 * 画面 A〜D のタブ構成（LabelingDashboard）をマウントする。認証は layout.tsx の
 * AmplifyProvider(<Authenticator>) 配下で満たされる（4 画面とも Cognito 認証配下）。
 * サンプルページ（/sample）は参照用に残すが、ここからの導線は置かない（structure 方針）。
 */
export default function Home() {
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.title}>SQS 付番バッチ処理 PoC</h1>
        <p className={styles.subtitle}>
          焙煎後の梱包バッチを題材に、DynamoDB Streams → SQS ファンアウトで付番ワーカーを
          最大 1,000 多重まで張り付かせる検証ダッシュボードです。
        </p>
      </header>

      <LabelingDashboard />
    </main>
  );
}
