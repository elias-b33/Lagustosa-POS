import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
export default defineConfig({
  root: path.resolve("portal/web"),
  envDir: path.resolve("portal"),
  plugins: [react()],
  build: {
    outDir: path.resolve("dist/portal"),
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    host: "127.0.0.1",
    port: 5193,
    strictPort: true,
    fs: { allow: [path.resolve(".")] },
    proxy: { "/api": "http://127.0.0.1:5194" },
  },
});
