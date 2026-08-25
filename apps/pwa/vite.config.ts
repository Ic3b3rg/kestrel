import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  cacheDir: "/tmp/kestrel-vite",
  plugins: [
    react(),
    VitePWA({
      includeAssets: ["favicon.svg"],
      manifest: {
        background_color: "#f2efe7",
        description: "Observe the durable Kestrel Installation and its latest diagnostic.",
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
        name: "Kestrel Installation",
        short_name: "Kestrel",
        start_url: "/",
        theme_color: "#17201c",
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
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": process.env.VITE_API_PROXY ?? "http://127.0.0.1:3000",
      "/auth": process.env.VITE_API_PROXY ?? "http://127.0.0.1:3000",
      "/health": process.env.VITE_API_PROXY ?? "http://127.0.0.1:3000",
    },
  },
});
