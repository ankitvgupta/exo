/// <reference types="vite/client" />

import type { ElectronAPI } from "../main/preload";

declare global {
  interface Window {
    api: ElectronAPI;
  }
}
