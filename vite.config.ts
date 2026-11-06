import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: [{ find: /^react-native$/, replacement: 'react-native-web' }],
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});
