import type { RequestActor } from "../http/request-actor.js";
import type { RequestAuthority } from "../http/request-authority.js";

declare global {
  namespace Express {
    interface Request {
      actor: RequestActor;
      requestAuthority: RequestAuthority;
    }
  }
}
