import React from "react";
import { createRoot } from "react-dom/client";
import App, { ShippingGroupsPreview, isShippingGroupsPreview } from "./App";
import "./styles.css";

const root = createRoot(document.getElementById("root"));
root.render(isShippingGroupsPreview ? <ShippingGroupsPreview /> : <App />);
