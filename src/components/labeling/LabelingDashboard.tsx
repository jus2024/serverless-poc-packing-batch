/**
 * 付番検証ダッシュボード（design §11.1 / 要件 8〜11）。
 *
 * 画面 A〜D を ARIA タブ構成で束ねる。4 画面を**常時マウント**し `hidden` で表示を切り替える
 * （タブ離脱で画面 C のポーリングが止まらないようにする。参考 EC PoC の OrderDashboard と同じ）。
 * タブはキーボード操作可能（ArrowLeft/Right/Home/End、roving tabindex。WAI-ARIA tabs パターン）。
 * styling は CSS Modules + @aws-amplify/ui-react（ワークスペース steering 優先。新規ライブラリ無し）。
 */
"use client";

import { useRef, useState } from "react";
import BatchRegisterPanel from "./BatchRegisterPanel";
import BatchListPanel from "./BatchListPanel";
import ProgressMonitorPanel from "./ProgressMonitorPanel";
import UnitTracePanel from "./UnitTracePanel";
import styles from "./labeling.module.css";

interface TabDef {
  id: string;
  label: string;
}

const TABS: TabDef[] = [
  { id: "register", label: "A. バッチ登録" },
  { id: "list", label: "B. 一覧・付番開始" },
  { id: "progress", label: "C. 進捗モニタ" },
  { id: "trace", label: "D. トレース照会" },
];

export default function LabelingDashboard({
  isVisible = true,
}: { isVisible?: boolean } = {}) {
  const [active, setActive] = useState(0);
  // 画面 B → 画面 C へ監視対象 batch_id を受け渡す
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
    setActive(2); // 画面 C へ切り替え
  }

  return (
    <div>
      <div
        className={styles.tabList}
        role="tablist"
        aria-label="付番検証の画面切り替え"
      >
        {TABS.map((tab, index) => {
          const selected = active === index;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              id={`tab-${tab.id}`}
              className={`${styles.tab} ${selected ? styles.tabActive : ""}`}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={`panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActive(index)}
              onKeyDown={(e) => handleKeyDown(e, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* 4 画面は常時マウント・hidden で切替（ポーリングを止めないため） */}
      <div
        id="panel-register"
        className={styles.panel}
        role="tabpanel"
        aria-labelledby="tab-register"
        hidden={active !== 0}
      >
        <BatchRegisterPanel />
      </div>
      <div
        id="panel-list"
        className={styles.panel}
        role="tabpanel"
        aria-labelledby="tab-list"
        hidden={active !== 1}
      >
        <BatchListPanel onMonitor={handleMonitor} />
      </div>
      <div
        id="panel-progress"
        className={styles.panel}
        role="tabpanel"
        aria-labelledby="tab-progress"
        hidden={active !== 2}
      >
        <ProgressMonitorPanel
          batchId={monitorBatchId}
          onBatchIdChange={setMonitorBatchId}
          isVisible={isVisible}
        />
      </div>
      <div
        id="panel-trace"
        className={styles.panel}
        role="tabpanel"
        aria-labelledby="tab-trace"
        hidden={active !== 3}
      >
        <UnitTracePanel />
      </div>
    </div>
  );
}
