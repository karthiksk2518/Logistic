import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig(({ mode }) => {
  const backendEnvDir = path.resolve(__dirname, "../backend");
  const env = loadEnv(mode, backendEnvDir, "");
  const apiProxyTarget = env.VITE_API_PROXY_TARGET || "http://localhost:5000";

  return {
    envDir: backendEnvDir,
    plugins: [
      react(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        "@shared": path.resolve(__dirname, "src/shared"),
        "@assets": path.resolve(__dirname, "../backend/attached_assets"),
      },
    },
    root: ".", 
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
    server: {
      proxy: {
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false,
          cookieDomainRewrite: "",
          cookiePathRewrite: "/",
        },
        "/ws": {
          target: apiProxyTarget,
          changeOrigin: true,
          ws: true,
          secure: false,
        },
        "/assets": {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: false,
        },
      }
    }
  };
});
