import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  envPrefix: ['VITE_', 'REACT_APP_'],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      // /auth/callback is a client route (Google OAuth lands there), so keep it out of the proxy
      '^/auth/(?!callback(?:[/?#]|$))': 'http://localhost:3000',
    },
  },
});
