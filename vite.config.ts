import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    exclude: ['e2e/**', 'node_modules/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    // 超过 500 kB 的只剩 EditorPane 这个按需异步 chunk(仅打开文件编辑器才下载),提高阈值避免误报
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // 按依赖分组拆包:常驻 vendor 独立成 chunk,便于缓存且避免单个 2MB 大包
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/') || id.includes('/node_modules/scheduler/')) {
            return 'vendor-react';
          }
          if (id.includes('/node_modules/@tanstack/') || id.includes('/node_modules/zustand/')) {
            return 'vendor-state';
          }
          if (
            id.includes('/node_modules/react-markdown') ||
            id.includes('/node_modules/remark-gfm') ||
            id.includes('/node_modules/rehype-highlight') ||
            id.includes('/node_modules/lowlight') ||
            id.includes('/node_modules/highlight.js') ||
            id.includes('/node_modules/micromark') ||
            id.includes('/node_modules/unified') ||
            id.includes('/node_modules/vfile') ||
            id.includes('/node_modules/unist-') ||
            id.includes('/node_modules/mdast-') ||
            id.includes('/node_modules/hast-') ||
            id.includes('/node_modules/remark-') ||
            id.includes('/node_modules/rehype-') ||
            id.includes('/node_modules/property-information') ||
            id.includes('/node_modules/ccount') ||
            id.includes('/node_modules/character-entities') ||
            id.includes('/node_modules/comma-separated-tokens') ||
            id.includes('/node_modules/escape-string-regexp') ||
            id.includes('/node_modules/html-void-elements') ||
            id.includes('/node_modules/space-separated-tokens') ||
            id.includes('/node_modules/trim-lines') ||
            id.includes('/node_modules/web-namespaces')
          ) {
            return 'vendor-markdown';
          }
          if (
            id.includes('/node_modules/radix-ui') ||
            id.includes('/node_modules/@shadcn/') ||
            id.includes('/node_modules/class-variance-authority') ||
            id.includes('/node_modules/clsx') ||
            id.includes('/node_modules/tailwind-merge') ||
            id.includes('/node_modules/tw-animate-css')
          ) {
            return 'vendor-ui';
          }
          if (id.includes('/node_modules/lucide-react')) {
            return 'vendor-icons';
          }
          return undefined;
        },
      },
    },
  },
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    strictPort: true,
    port: 5173,
  },
});
