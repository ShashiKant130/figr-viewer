import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The preview pages load agent.js from this exact origin, so the port must not drift.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 5173, strictPort: true },
});
