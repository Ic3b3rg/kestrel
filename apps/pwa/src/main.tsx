import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Missing PWA root element");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
