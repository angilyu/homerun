import { isCompiledUrl, resolveBuildChannel } from "@homerun/client";
import type { BuildChannel } from "@homerun/core";

export const CLI_VERSION: string = typeof HOMERUN_CLI_VERSION === "string" ? HOMERUN_CLI_VERSION : "0.3.0-dev";

/**
 * Fails closed, like homerund: a compiled `homerun` is release unless it was built with an
 * explicit `--define HOMERUN_CLI_BUILD='"development"'`. Running from source is development.
 */
export const BUILD_CHANNEL: BuildChannel = resolveBuildChannel(
  typeof HOMERUN_CLI_BUILD === "string" ? HOMERUN_CLI_BUILD : undefined,
  isCompiledUrl(import.meta.url),
);
