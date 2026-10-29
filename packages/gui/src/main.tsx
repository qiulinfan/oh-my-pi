import { drawMathWithKatexHtml } from "@oh-my-pi/collab-web/src/components/transcript/math";
import hljs from "highlight.js/lib/common";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "katex/dist/katex.min.css";
import "./styles.css";

// This page loads KaTeX's stylesheet, so transcript math draws as KaTeX HTML (MathML alone loses \mathbb and friends).
drawMathWithKatexHtml();
// Fenced code in answers is highlighted through collab-web's highlight.js seam (`getHljs`).
(globalThis as { hljs?: unknown }).hljs = hljs;

createRoot(document.getElementById("root")!).render(<App />);
