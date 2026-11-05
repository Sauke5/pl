import { createHash } from "node:crypto";
import type { GatewayClaims } from "../gateway/types";

/** Accept only claims already verified by the gateway middleware. Never persist the token itself. */
export function attachmentSessionBinding(
  verifiedClaims: Pick<GatewayClaims, "sub" | "csrf_token">,
) {
  return createHash("sha256")
    .update(
      `doska-upload-session-v1\n${verifiedClaims.sub}\n${verifiedClaims.csrf_token}`,
      "utf8",
    )
    .digest("hex");
}
