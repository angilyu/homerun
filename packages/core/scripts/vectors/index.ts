import type { Vector } from "./types";
import { common, domain, grants, health, input, schedule, taskSpec } from "./model";
import { events } from "./events";
import { protocol } from "./protocol";
import { relay } from "./relay";
import { versionPolicyVectors } from "./version-policy";

/** Vector groups; each becomes `vectors/<group>.json`. */
export const VECTOR_GROUPS: Record<string, Vector[]> = {
  common,
  schedule,
  health,
  "task-spec": taskSpec,
  grants,
  input,
  domain,
  events,
  protocol,
  relay,
  "version-policy": versionPolicyVectors,
};

export type { Vector };
