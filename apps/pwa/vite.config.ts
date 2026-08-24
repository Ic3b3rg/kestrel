import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  cacheDir: "/tmp/kestrel-vite",
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": process.env.VITE_API_PROXY ?? "http://127.0.0.1:3000",
      "/health": process.env.VITE_API_PROXY ?? "http://127.0.0.1:3000",
    },
  },
});
