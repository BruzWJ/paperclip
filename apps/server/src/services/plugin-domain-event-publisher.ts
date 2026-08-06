import type { PluginEvent } from "@paperclipai/plugin-sdk";
import { logger } from "../middleware/logger.js";
import type { PluginEventBus } from "./plugin-event-bus.js";

/** App-owned post-commit delivery seam for generic plugin domain events. */
export interface PluginDomainEventPublisher {
  publish(event: PluginEvent): Promise<void>;
}

/**
 * Bind the process event bus to the explicit publisher passed to domain
 * producers. Delivery is awaited, but remains best-effort: a plugin failure is
 * logged and cannot roll back an already committed Paperclip operation.
 */
export function createPluginDomainEventPublisher(
  eventBus: PluginEventBus,
): PluginDomainEventPublisher {
  return Object.freeze({
    async publish(event: PluginEvent): Promise<void> {
      try {
        const { errors } = await eventBus.emit(event);
        for (const { pluginId, error } of errors) {
          logger.warn(
            { pluginId, eventType: event.eventType, err: error },
            "plugin event handler failed",
          );
        }
      } catch (error) {
        logger.warn(
          { eventType: event.eventType, err: error },
          "plugin event delivery failed",
        );
      }
    },
  });
}
