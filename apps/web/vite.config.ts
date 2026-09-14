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
  },
});
