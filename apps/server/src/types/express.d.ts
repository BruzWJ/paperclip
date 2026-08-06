import type { RequestActor } from "../http/request-actor.js";
import type { RequestAuthority } from "../http/request-authority.js";
import type { ErrorContext } from "../middleware/error-handler.js";

declare global {
  namespace Express {
    interface Request {
      actor: RequestActor;
      requestAuthority: RequestAuthority;
    }

    interface Response {
      __errorContext?: ErrorContext;
      err?: Error;
    }
  }
}
