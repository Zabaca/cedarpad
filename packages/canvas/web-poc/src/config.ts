/** Frontend runtime config from Vite env (VITE_*). Sensible localhost defaults. */
export const config = {
  /** API origin. Empty in dev → relative paths proxied by Vite (same-origin cookies). */
  apiUrl: import.meta.env.VITE_API_URL ?? "",
  ablyKey: import.meta.env.VITE_ABLY_KEY ?? "",
};
