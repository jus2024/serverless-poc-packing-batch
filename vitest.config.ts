import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * vitest 設定（FEAT-001 / design §16.0）。
 *
 * - environment: node。本 PoC のテスト対象は Lambda 純ロジック（amplify/functions）と
 *   CDK 合成テスト（amplify/custom）、およびフロントの純ロジック（src/lib）であり、
 *   いずれも DOM を必要としないため node 環境で統一する。
 * - include: テストはプロダクションコードに併置（*.test.ts）する方針のため、
 *   amplify 配下と src 配下の *.test.ts のみを対象にする。
 * - resolve.alias: tsconfig の baseUrl(./) + paths("@/*": ["./*"]) に合わせ、
 *   vite-tsconfig-paths を足さずに '@' をリポジトリルート（__dirname 相当）へ向ける。
 */
const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["amplify/**/*.test.ts", "src/**/*.test.ts"],
    // FEAT-001 時点ではテスト未配置。以降の FEAT がテストを追加するまでは
    // 「テスト 0 件」を失敗（exit 1）ではなく成功（exit 0）として扱い、
    // CI の『テスト』ステップが前提整備段階でグリーンになるようにする。
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
});
