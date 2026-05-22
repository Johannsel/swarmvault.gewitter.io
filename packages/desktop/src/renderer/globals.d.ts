import type { SwarmVaultAPI } from "../preload/index.js";

declare global {
  interface Window {
    swarmvault: SwarmVaultAPI;
  }
}
