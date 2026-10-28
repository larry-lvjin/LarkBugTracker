import { defineConfig } from 'vite';

// 仅构建静态前端；不代理 Open API，不需要应用密钥。
export default defineConfig({
  base: './',
  resolve: { preserveSymlinks: true },
  // 项目和 SDK 都是原生 JS。保留可审计代码，避免构建阶段大临时文件与额外编译子进程。
  build: { outDir: 'dist', sourcemap: false, target: 'esnext', minify: false, cssMinify: false },
});
