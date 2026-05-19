import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.js";
import { useThemeStore } from "./store/theme-store.js";
import { initShiki } from "./utils/shiki-init.js";
import "./styles/global.css";

useThemeStore.getState().init();
initShiki().catch(() => {});

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);
