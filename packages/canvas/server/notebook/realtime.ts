import { workspaceChannel, type RealtimeMessage } from "../../lib/realtime/index.js";
import Ably from "ably";
import type { Bindings } from "./context.js";

export { workspaceChannel };
export type RealtimeEvent = RealtimeMessage;

/**
 * Publish an event to Ably. No-ops when ABLY_API_KEY is unset so the app runs
 * fine without realtime configured. Failures never break the request.
 */
export async function publish(
  env: Bindings,
  channel: string,
  event: RealtimeEvent,
): Promise<void> {
  if (!env.ABLY_API_KEY) return;
  try {
    const rest = new Ably.Rest(env.ABLY_API_KEY);
    await rest.channels.get(channel).publish(event.type, event);
  } catch (err) {
    console.error("Ably publish failed", err);
  }
}
