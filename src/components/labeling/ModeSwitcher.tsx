/**
 * 業務/検証モードのトップレベル切替（design §7.1 / §7.2）。
 *
 * WAI-ARIA tabs パターン（`role="tablist"`/`role="tab"`/`aria-selected`/roving tabindex、
 * ArrowLeft/Right/Home/End、Enter/Space、`:focus-visible`。既存 `LabelingDashboard` のタブ実装に
 * 準拠）。業務モード（既定）/検証モードの 2 ボタン。AA コントラスト・44px タップ領域は
 * 既存 `.tab` クラスを再利用して満たす。
 */
"use client";

import { useRef } from "react";
import styles from "./labeling.module.css";

export type AppMode = "business" | "verification";

interface ModeSwitcherProps {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
}

const MODES: { id: AppMode; label: string }[] = [
  { id: "business", label: "業務モード" },
  { id: "verification", label: "検証モード" },
];

export default function ModeSwitcher({ mode, onChange }: ModeSwitcherProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusMode(index: number) {
    const next = (index + MODES.length) % MODES.length;
    onChange(MODES[next].id);
    refs.current[next]?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        focusMode(index + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        focusMode(index - 1);
        break;
      case "Home":
        e.preventDefault();
        focusMode(0);
        break;
      case "End":
        e.preventDefault();
        focusMode(MODES.length - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      className={styles.tabList}
      role="tablist"
      aria-label="表示モードの切り替え"
    >
      {MODES.map((m, index) => {
        const selected = mode === m.id;
        return (
          <button
            key={m.id}
            ref={(el) => {
              refs.current[index] = el;
            }}
            id={`mode-tab-${m.id}`}
            className={`${styles.tab} ${selected ? styles.tabActive : ""}`}
            role="tab"
            type="button"
            aria-selected={selected}
            aria-controls={`mode-panel-${m.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(m.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
