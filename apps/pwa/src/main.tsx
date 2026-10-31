import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./App";
import { APP_PATH, IS_OWNER, SLUG } from "./api";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

// Each tenant registers the shared worker script with its own scope (/t/<slug>/), so installs never overlap.
if ("serviceWorker" in navigator && (SLUG || IS_OWNER) && import.meta.env.PROD) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("/sw.js", { scope: APP_PATH }).catch(() => undefined); });
}
