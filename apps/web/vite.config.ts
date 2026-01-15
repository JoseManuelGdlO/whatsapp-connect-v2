import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const previewPort = Number(process.env.WEB_PORT ?? 3000);

export default defineConfig({
  plugins: [react()],
  server: {
    strictPort: false
  },
  preview: {
    host: true,
    port: previewPort
  }
});

