export {};

declare global {
  interface Window {
    __CORASTUFF_CONFIG__?: {
      CONVEX_URL?: string;
    };
  }
}

