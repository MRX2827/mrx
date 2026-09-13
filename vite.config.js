import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const fb = (name) => fileURLToPath(new URL("./src/fb/" + name, import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  base: "/mrx/",
  plugins: [react()],
  resolve: {
    alias: {
      // Старый UI сохраняет знакомые импорты Firebase, но все они направлены
      // в совместимые модули собственного сервера. В сборке нет Firebase.
      "firebase/app": fb("app.js"),
      "firebase/auth": fb("auth.js"),
      "firebase/firestore": fb("firestore.js"),
      "firebase/storage": fb("storage.js"),
      "firebase/messaging": fb("messaging.js"),
    },
  },
});
