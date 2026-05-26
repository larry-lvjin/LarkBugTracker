import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    host: true,
    https: false,
    proxy: {
      "/feishu-api": {
        target: "https://open.feishu.cn/open-apis",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/feishu-api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
