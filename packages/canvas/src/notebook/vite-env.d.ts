/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_DEV_ORG?: string;
  readonly VITE_PROJECT_ID?: string;
  readonly VITE_ABLY_KEY?: string;
  /** "1" hides the signup UI (twin of the server's AUTH_DISABLE_SIGNUP). */
  readonly VITE_AUTH_DISABLE_SIGNUP?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
