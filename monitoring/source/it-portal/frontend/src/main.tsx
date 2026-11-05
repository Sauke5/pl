import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./api";
import App from "./App";
import { ActionNotificationsProvider } from "./ActionNotifications";
import "./styles.css";
import "./night-theme.css";
import "@pl/ui/styles.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ActionNotificationsProvider>
        <App />
      </ActionNotificationsProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
