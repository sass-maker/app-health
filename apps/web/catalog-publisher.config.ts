import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    target: 'node24',
    outDir: '../../dist/catalog-publisher',
    lib: {
      entry: resolve(import.meta.dirname, '../catalog-publisher/src/catalog-publisher-cli.ts'),
      formats: ['es'],
      fileName: () => 'catalog-publisher.mjs',
    },
    rollupOptions: { external: [/^node:/, ...builtinModules] },
    minify: false,
  },
});
