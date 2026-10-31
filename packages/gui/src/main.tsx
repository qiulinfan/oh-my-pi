import { drawMathWithKatexHtml } from "@oh-my-pi/collab-web/src/components/transcript/math";
import hljs from "highlight.js/lib/common";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { listenToEmbedder } from "./editor-context";
import { routeLinksToEmbedder } from "./embed";
import { loadPrefs, reloadPrefsOnReturn } from "./prefs";
import "katex/dist/katex.min.css";
import "./styles.css";

// This page loads KaTeX's stylesheet, so transcript math draws as KaTeX HTML (MathML alone loses \mathbb and friends).
drawMathWithKatexHtml();
// Fenced code in answers is highlighted through collab-web's highlight.js seam (`getHljs`).
(globalThis as { hljs?: unknown }).hljs = hljs;

routeLinksToEmbedder();
listenToEmbedder();

// The page's preferences come before the first render, so a chosen theme never flashes the default.
await loadPrefs();
reloadPrefsOnReturn();

createRoot(document.getElementById("root")!).render(<App />);
