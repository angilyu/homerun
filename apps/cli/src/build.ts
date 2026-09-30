import { resolveBuildChannel, runningCompiled } from "@homerun/client";
import type { BuildChannel } from "@homerun/core";

export const CLI_VERSION: string = typeof HOMERUN_CLI_VERSION === "string" ? HOMERUN_CLI_VERSION : "0.3.0-dev";

/**
 * Fails closed, like homerund: a compiled `homerun` is release unless it was built with an
 * explicit `--define HOMERUN_CLI_BUILD='"development"'`. Running from source is development.
 */
export const BUILD_CHANNEL: BuildChannel = resolveBuildChannel(
  typeof HOMERUN_CLI_BUILD === "string" ? HOMERUN_CLI_BUILD : undefined,
  runningCompiled(import.meta.url),
);

/**
 * The code requirement homerund must satisfy before the release CLI sends its token (§5.2),
 * compiled in by the packaging scripts. Absent in any other build, which then refuses.
 */
export const PEER_REQUIREMENT: string | undefined =
  typeof HOMERUN_CLI_PEER_REQUIREMENT === "string" && HOMERUN_CLI_PEER_REQUIREMENT ? HOMERUN_CLI_PEER_REQUIREMENT : undefined;
