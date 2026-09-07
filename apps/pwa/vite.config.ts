import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const apiProxyTarget = process.env.VITE_API_PROXY ?? "http://127.0.0.1:3000";

export default defineConfig({
  cacheDir: "/tmp/kestrel-vite",
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      includeAssets: ["favicon.svg"],
      manifest: {
        background_color: "#171717",
        description: "Plan and govern software change across your Projects.",
        display: "standalone",
        icons: [
          { src: "/icon-192.svg", sizes: "192x192", type: "image/svg+xml" },
          { src: "/icon-512.svg", sizes: "512x512", type: "image/svg+xml" },
          {
            purpose: "maskable",
            sizes: "512x512",
            src: "/maskable-icon.svg",
            type: "image/svg+xml",
          },
        ],
        id: "/",
        name: "Kestrel",
        short_name: "Kestrel",
        start_url: "/",
        theme_color: "#171717",
      },
      registerType: "autoUpdate",
      workbox: {
        cleanupOutdatedCaches: true,
        globPatterns: ["**/*.{css,html,js}"],
        navigateFallbackDenylist: [/^\/api\//, /^\/auth\//, /^\/health\//],
        runtimeCaching: [],
      },
    }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { changeOrigin: false, target: apiProxyTarget },
      "/auth": { changeOrigin: false, target: apiProxyTarget },
      "/health": { changeOrigin: false, target: apiProxyTarget },
    },
  },
});
