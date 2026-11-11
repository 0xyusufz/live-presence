import React from "react";
import { createRoot } from "react-dom/client";
import { ViewerApp } from "./ui.js";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ViewerApp />
  </React.StrictMode>,
);
