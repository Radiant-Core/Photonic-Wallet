// Globals shared with public/boot-recovery.js (a classic script loaded before
// the entry module — see index.html). Keep in sync with that file.
declare global {
  interface Window {
    /** Set by main.tsx after render; boot-recovery's watchdog stands down. */
    __APP_BOOTED?: boolean;
    /** Unregister all SWs, delete all caches, reload. Defined by boot-recovery.js. */
    __pwRepair?: () => void;
  }
}

export {};
