import type { Vector } from "./types";
import { common, domain, grants, input, schedule, taskSpec } from "./model";
import { events } from "./events";
import { protocol } from "./protocol";
import { relay } from "./relay";

/** Vector groups; each becomes `vectors/<group>.json`. */
export const VECTOR_GROUPS: Record<string, Vector[]> = {
  common,
  schedule,
  "task-spec": taskSpec,
  grants,
  input,
  domain,
  events,
  protocol,
  relay,
};

export type { Vector };
