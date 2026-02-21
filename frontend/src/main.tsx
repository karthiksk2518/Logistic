import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "./i18n";

const hideInitialLoader = () => {
  const loader = document.getElementById("initial-loader");
  if (loader) {
    loader.style.opacity = "0";
    loader.addEventListener("transitionend", () => loader.remove(), { once: true });
    setTimeout(() => loader.remove(), 500);
  }
};

createRoot(document.getElementById("root")!).render(<App />);
hideInitialLoader();
