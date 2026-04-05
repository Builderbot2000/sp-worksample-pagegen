import {defineConfig} from 'vite';
import {createRequire} from 'module';

// Use createRequire to bypass ESM/CJS interop issues with @motion-canvas/vite-plugin.
// The plugin is a CJS module; in Node ESM context, dynamic import() double-wraps it.
const _require = createRequire(import.meta.url);
const motionCanvas = _require('@motion-canvas/vite-plugin').default as () => unknown;

export default defineConfig({
  plugins: [motionCanvas()],
  server: {
    port: 9000,
    fs: {
      // Allow serving screenshots from anywhere on the filesystem.
      allow: ['/'],
    },
  },
});
