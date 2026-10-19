/**
 * ブランドアイコン（design §5.1 / 要件 F8。過去 PoC stock-management / ec-site-ordering と同形）。
 *
 * next/image で Web 表示用の軽量版アイコンを出すだけの最小コンポーネント。店名は呼び出し側が
 * 横に置く（§5.2 のブランドヘッダー）。`alt="Kiro Roasters"`・width/height 明示で CLS を防ぐ
 * （要件 F8-2）。
 *
 * ## ブランドアセットの三重配置と更新運用（要件 F8-4）
 *
 * 画像の実体は 3 箇所に配置している。差し替え時は三者を揃えて更新すること:
 * - `public/brand/kiro-roasters-icon-256.png` — Web 表示用の軽量版（本コンポーネントが参照）
 * - `public/brand/kiro-roasters-icon.png`     — 高解像度版（元データ・再書き出し用）
 * - `src/app/icon.png`                         — ファビコン（256 版をコピー）
 */
import Image from "next/image";

interface BrandIconProps {
  /** 一辺のピクセル数（width/height に明示。既定 20）。 */
  size?: number;
  className?: string;
}

export default function BrandIcon({ size = 20, className }: BrandIconProps) {
  return (
    <Image
      src="/brand/kiro-roasters-icon-256.png"
      alt="Kiro Roasters"
      width={size}
      height={size}
      className={className}
    />
  );
}
