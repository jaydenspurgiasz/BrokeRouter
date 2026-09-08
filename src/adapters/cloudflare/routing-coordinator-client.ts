import type { Env } from "../../config";
import type { RoutingCoordinator } from "./routing-coordinator";

const COORDINATOR_KEY_VERSION = "routing-v2";

/** A versioned name guarantees this deployment creates a fresh, region-hinted coordination atom. */
export function routingCoordinator(env: Env, environment: string): DurableObjectStub<RoutingCoordinator> {
  return env.ROUTING_COORDINATOR.getByName(`${COORDINATOR_KEY_VERSION}:${environment}`, { locationHint: "wnam" });
}
