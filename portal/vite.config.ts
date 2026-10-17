import { validatePublicConfig } from "./shared/public-config.ts";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, path.resolve("portal"), "VITE_");
  validatePublicConfig(
    process.env.VITE_ADMIN_SUPABASE_URL ?? env.VITE_ADMIN_SUPABASE_URL,
    process.env.VITE_ADMIN_SUPABASE_KEY ?? env.VITE_ADMIN_SUPABASE_KEY,
    false,
    command === "serve",
  );
  return {
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
  };
});
