import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "/",
  plugins: [
    react(),
    tailwind(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // The manifest is generated per tenant by the Worker (unique id + scope), so none is emitted here.
      manifest: false,
      injectRegister: false,
      injectManifest: { globPatterns: ["**/*.{js,css,html,svg,png,woff2}"], globIgnores: ["**/icons/icon-maskable-*.png"] },
    }),
  ],
  build: { target: "es2022", sourcemap: false },
  server: { proxy: { "/t": "http://localhost:8787", "/owner/api": "http://localhost:8787" } },
});
