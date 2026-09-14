/// <reference types="vite/client" />

/**
 * Without this, import.meta.env values are `any` and silently defeat the
 * no-unsafe-assignment rule. Only VITE_-prefixed vars reach the browser.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
