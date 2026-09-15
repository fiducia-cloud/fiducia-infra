import edgeWorker from "./index.mjs";
import { enforceJwtRevocationBoundary } from "./jwt-revocation-boundary.mjs";
import {
  failClosedConfigurationResponse,
  secureResponse,
} from "./security-boundary.mjs";

export { RateLimiter } from "./index.mjs";

export default {
  async fetch(request, env, ctx) {
    try {
      const revocationFailure = await enforceJwtRevocationBoundary(request, env);
      if (revocationFailure) {
        return secureResponse(request, revocationFailure, env);
      }

      const response = await edgeWorker.fetch(request, env, ctx);
      return secureResponse(request, response, env);
    } catch (error) {
      console.error(
        "fiducia-edge request boundary failed closed:",
        error instanceof SyntaxError ? "syntax_error" : "boundary_error",
      );
      return failClosedConfigurationResponse(request);
    }
  },
};
