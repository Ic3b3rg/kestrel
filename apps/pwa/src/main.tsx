import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) {
  throw new Error("Missing PWA root element");
}

createRoot(root).render(
  <StrictMode>
    <main>
      <h1>Kestrel</h1>
      <p>Starting the Installation view…</p>
    </main>
  </StrictMode>,
);
