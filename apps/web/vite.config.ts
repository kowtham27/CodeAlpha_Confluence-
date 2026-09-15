import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // Required for the container to be reachable from the Windows host.
    host: true,
  },
  build: {
    sourcemap: true,
    target: 'es2023',
    // Vite inlines small assets as data: URIs, but the CSP allows fonts only
    // from 'self' (font-src 'self'): keep every font subset a real file.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
});
