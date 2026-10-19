/**
 * 業務ダッシュボード `BusinessDashboard`（design §7.1 / §7.3 / §7.4 / §8.0）。
 *
 * 業務 4 画面（焙煎担当 / 梱包担当 / ライン監督 / QC）を WAI-ARIA tabs で束ねる。4 画面を
 * **常時マウント**し `hidden` で切り替える（画面離脱でライン監督のポーリングを止めないため。
 * 検証モードの `LabelingDashboard` と同じ手法。タブ実装はコピーして業務ラベルに差し替える＝
 * 検証モードのコードには手を入れない。§7.4）。先頭に §5.2 のブランドヘッダーを描画する。
 *
 * 梱包→ライン監督の batch_id 受け渡しは親 state ホイスティング。`isVisible`（自モードが
 * 表示中か）をライン監督モニタへ伝搬し、業務モード非表示時はポーリングを止める（§7.3）。
 */
"use client";

import { useRef, useState } from "react";
import BrandIcon from "../../common/BrandIcon";
import RoastingPanel from "./RoastingPanel";
import PackingPanel from "./PackingPanel";
import LineMonitorPanel from "./LineMonitorPanel";
import QcPanel from "./QcPanel";
import styles from "../labeling.module.css";

interface BusinessDashboardProps {
  /** 自モード（業務）が表示中か。ライン監督モニタのポーリング停止に伝搬する（§7.3）。 */
  isVisible: boolean;
}

interface TabDef {
  id: string;
  label: string;
}

const TABS: TabDef[] = [
  { id: "roasting", label: "焙煎担当" },
  { id: "packing", label: "梱包担当" },
  { id: "line", label: "ライン監督" },
  { id: "qc", label: "QC・出荷" },
];

export default function BusinessDashboard({ isVisible }: BusinessDashboardProps) {
  const [active, setActive] = useState(0);
  // 梱包担当 → ライン監督へ監視対象 batch_id を受け渡す（親 state ホイスティング）
  const [monitorBatchId, setMonitorBatchId] = useState("");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusTab(index: number) {
    const next = (index + TABS.length) % TABS.length;
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusTab(index + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusTab(index - 1);
        break;
      case "Home":
        e.preventDefault();
        focusTab(0);
        break;
      case "End":
        e.preventDefault();
        focusTab(TABS.length - 1);
        break;
      default:
        break;
    }
  }

  function handleMonitor(batchId: string) {
    setMonitorBatchId(batchId);
    setActive(2); // ライン監督へ切り替え
  }

  return (
    <div>
      <header className={styles.header}>
        <div className={styles.headerBrand}>
          <BrandIcon size={20} />
          <span>Kiro Roasters</span>
        </div>
        <h1 className={styles.headerTitle}>梱包現場ダッシュボード</h1>
        <p className={styles.subtitle}>
          焙煎計画をもとに、焙煎完了の記録から付番・出荷までの現場オペレーションを進めます。
        </p>
      </header>

      <div
        className={styles.tabList}
        role="tablist"
        aria-label="業務画面の切り替え"
      >
        {TABS.map((tab, index) => {
          const selected = active === index;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              id={`biz-tab-${tab.id}`}
              className={`${styles.tab} ${selected ? styles.tabActive : ""}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`biz-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(index)}
              onKeyDown={(e) => handleKeyDown(e, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 4 画面は常時マウント・hidden で切替（離脱でモニタのポーリングを止めないため） */}
      <div
        id="biz-panel-roasting"
        className={styles.panel}
        role="tabpanel"
        aria-labelledby="biz-tab-roasting"
        hidden={active !== 0}
      >
        <RoastingPanel />
      </div>
      <div
        id="biz-panel-packing"
        className={styles.panel}
        role="tabpanel"
        aria-labelledby="biz-tab-packing"
        hidden={active !== 1}
      >
        <PackingPanel onMonitor={handleMonitor} isActive={isVisible && active === 1} />
      </div>
      <div
        id="biz-panel-line"
        className={styles.panel}
        role="tabpanel"
        aria-labelledby="biz-tab-line"
        hidden={active !== 2}
      >
        <LineMonitorPanel
          batchId={monitorBatchId}
          onBatchIdChange={setMonitorBatchId}
          isVisible={isVisible}
        />
      </div>
      <div
        id="biz-panel-qc"
        className={styles.panel}
        role="tabpanel"
        aria-labelledby="biz-tab-qc"
        hidden={active !== 3}
      >
        <QcPanel isActive={isVisible && active === 3} />
      </div>
    </div>
  );
}
