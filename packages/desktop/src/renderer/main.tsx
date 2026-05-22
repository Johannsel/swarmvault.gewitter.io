import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
// rendererReady() is called in App.tsx's useEffect, after React hooks subscribe to sync:status
