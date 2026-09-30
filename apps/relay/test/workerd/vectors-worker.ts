import { verifyAllVectors } from "@homerun/protocol";
import { VECTOR_FILES } from "@homerun/protocol/vector-files";

/** Test only: checks every protocol vector inside workerd, the relay's runtime (§16.2). */
export default {
  fetch(): Response {
    return Response.json(verifyAllVectors(VECTOR_FILES));
  },
};
