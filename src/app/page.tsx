"use client";

import { useState } from "react";
import LabelingDashboard from "@/src/components/labeling/LabelingDashboard";
import ModeSwitcher, { type AppMode } from "@/src/components/labeling/ModeSwitcher";
import BusinessDashboard from "@/src/components/labeling/business/BusinessDashboard";
import styles from "@/src/components/labeling/labeling.module.css";

/**
 * トップページ: 業務モード（既定）/ 検証モードの 2 層ダッシュボード（design §7.2 / §7.3）。
 *
 * - 業務モード（既定）: 現場オペレーター向けの業務 4 画面（焙煎/梱包/ライン監督/QC）。
 *   ブランドヘッダーは BusinessDashboard が先頭に描画する。
 * - 検証モード: 既存の付番検証ダッシュボード（画面 A〜D）。タイトルヘッダーはここ（検証ブロック
 *   内・LabelingDashboard の前）に据え置き、見た目・情報設計は一切変えない（§7.2 MEDIUM-1）。
 *
 * 両モードを常時マウント + `hidden` で切り替え、各ダッシュボードに `isVisible`（自モードが表示中か）
 * を渡して hidden 側のモニタ・ポーリングを止める（過剰ポーリング抑止。§7.3 MEDIUM-5）。
 * 認証は layout.tsx の AmplifyProvider(<Authenticator>) 配下で満たされる。
 */
export default function Home() {
  const [mode, setMode] = useState<AppMode>("business");

  return (
    <main className={styles.main}>
      <ModeSwitcher mode={mode} onChange={setMode} />

      {/* 業務モード（既定）: ブランドヘッダーは BusinessDashboard が描画する */}
      <div
        id="mode-panel-business"
        role="tabpanel"
        aria-labelledby="mode-tab-business"
        hidden={mode !== "business"}
      >
        <BusinessDashboard isVisible={mode === "business"} />
      </div>

      {/* 検証モード: 既存タイトルヘッダーを据え置き（見た目不変） */}
      <div
        id="mode-panel-verification"
        role="tabpanel"
        aria-labelledby="mode-tab-verification"
        hidden={mode !== "verification"}
      >
        <header className={styles.header}>
          <h1 className={styles.title}>SQS 付番バッチ処理 PoC</h1>
          <p className={styles.subtitle}>
            焙煎後の梱包バッチを題材に、DynamoDB Streams → SQS ファンアウトで付番ワーカーを
            最大 1,000 多重まで張り付かせる検証ダッシュボードです。
          </p>
        </header>
        <LabelingDashboard isVisible={mode === "verification"} />
      </div>
    </main>
  );
}
