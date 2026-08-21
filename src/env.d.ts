import type { HaloApi } from '../electron/preload';

declare global {
  interface Window {
    halo: HaloApi;
  }
}

export {};
