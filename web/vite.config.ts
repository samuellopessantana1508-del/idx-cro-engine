import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  // o editor de automações usa o mesmo núcleo do servidor (supabase/functions/_shared/flow-core.ts)
  server: { fs: { allow: [".."] } },
});
