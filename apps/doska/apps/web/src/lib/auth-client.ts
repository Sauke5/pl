import { getApiUrl } from "@/fetchers/get-api-url";
import { apiKeyClient } from "@better-auth/api-key/client";
import {
  adminClient,
  anonymousClient,
  deviceAuthorizationClient,
  emailOTPClient,
  genericOAuthClient,
  inferAdditionalFields,
  inferOrgAdditionalFields,
  lastLoginMethodClient,
  magicLinkClient,
  organizationClient,
} from "better-auth/client/plugins";
import type { AccessControl } from "better-auth/plugins/access";
import { createAuthClient } from "better-auth/react";
import { ac, admin, member, owner, viewer } from "./permissions";

const apiBase = new URL(getApiUrl("auth"), window.location.origin);

export const authClient = createAuthClient({
  baseURL: apiBase.origin,
  basePath: apiBase.pathname,
  plugins: [
    anonymousClient(),
    lastLoginMethodClient(),
    magicLinkClient(),
    emailOTPClient(),
    organizationClient({
      // Same widening as the server plugin in `apps/api/src/auth.ts`: our
      // narrow `statement` shape makes `ac`'s inferred `newRole` generic
      // incompatible with better-auth's looser `AccessControl` type.
      ac: ac as AccessControl,
      roles: {
        viewer,
        member,
        admin,
        owner,
      },
      dynamicAccessControl: {
        enabled: true,
      },
      schema: inferOrgAdditionalFields({
        invitation: {
          additionalFields: {
            projectAccess: {
              type: "string",
              input: true,
              required: false,
            },
            projectIds: {
              type: "string[]",
              input: true,
              required: false,
            },
          },
        },
      }),
    }),
    genericOAuthClient(),
    deviceAuthorizationClient(),
    apiKeyClient(),
    adminClient(),
    inferAdditionalFields({
      user: {
        locale: {
          type: "string",
          required: false,
          input: true,
        },
      },
    }),
  ],
});
