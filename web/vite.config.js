import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// libauth (inside WizardConnect) uses top-level await, so the build targets browsers that have it.
export default defineConfig({
  plugins: [react()],
  build: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
});
