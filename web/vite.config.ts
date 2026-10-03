import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  define: {'process.env': {}, global: 'globalThis'},
  resolve: {alias: {buffer: 'buffer/'}},
  server: {port: 5173, fs: {allow: ['..']}},
  build: {outDir: 'dist', emptyOutDir: true},
})
