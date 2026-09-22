export type JwtSummary = {
  sub: string | null;
  iss: string | null;
  exp: number | null;
  expIso: string | null;
  expired: boolean;
  segmentCount: number;
};

export type ClientsResponseSummary = {
  httpStatus: number;
  topKeys: string[];
  success: boolean | null;
  error: string | null;
  dataIsArray: boolean;
  clientsCount: number;
  applicantsCount: number;
  responseSnippet: string;
  rawTextLength: number;
  parseError: string | null;
};

export type DashboardFetchDebug = {
  steps: string[];
  auth: {
    jwtSource:
      | "bearer-otp"
      | "clerk-mint"
      | "bearer-cache"
      | "clerk-retry-after-empty"
      | "bearer-retry-after-empty"
      | "none";
    hasBearerFromRequest: boolean;
    bearerSegmentCount: number;
    hasClerkSession: boolean;
    hasClerkCookie: boolean;
    organizationIdSet: boolean;
    backendUrl: string;
    jwtBeforeClients: JwtSummary | null;
    jwtAfterRefresh: JwtSummary | null;
  };
  clients: ClientsResponseSummary;
  clerkMintError: string | null;
  clerkRetryError: string | null;
};

export function decodeJwtPayloadServer(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function summarizeJwt(jwt: string): JwtSummary | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  const payload = decodeJwtPayloadServer(jwt);
  if (!payload) {
    return {
      sub: null,
      iss: null,
      exp: null,
      expIso: null,
      expired: true,
      segmentCount: parts.length,
    };
  }
  const exp = typeof payload.exp === "number" ? payload.exp : null;
  const expired = exp != null ? Date.now() >= exp * 1000 - 60_000 : false;
  return {
    sub: typeof payload.sub === "string" ? payload.sub : null,
    iss: typeof payload.iss === "string" ? payload.iss : null,
    exp,
    expIso: exp != null ? new Date(exp * 1000).toISOString() : null,
    expired,
    segmentCount: parts.length,
  };
}

export function summarizeClientsJson(
  json: unknown,
  httpStatus: number,
  rawTextLength = 0,
  parseError: string | null = null,
): Omit<ClientsResponseSummary, "httpStatus"> {
  const root = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const topKeys = Object.keys(root);
  const success = typeof root.success === "boolean" ? root.success : null;
  const error =
    typeof root.error === "string"
      ? root.error
      : typeof root.message === "string"
        ? root.message
        : null;
  const data = root.data;
  const dataIsArray = Array.isArray(data);
  const clientsCount = dataIsArray ? data.length : 0;
  let applicantsCount = 0;
  if (dataIsArray) {
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const applicants = (item as Record<string, unknown>).applicants;
      if (Array.isArray(applicants)) applicantsCount += applicants.length;
    }
  }
  let responseSnippet = "";
  try {
    responseSnippet = JSON.stringify(json).slice(0, 400);
  } catch {
    responseSnippet = String(json).slice(0, 400);
  }
  return {
    topKeys,
    success,
    error,
    dataIsArray,
    clientsCount,
    applicantsCount,
    responseSnippet,
    rawTextLength,
    parseError,
  };
}

export function emptyDashboardFetchDebug(): DashboardFetchDebug {
  return {
    steps: [],
    auth: {
      jwtSource: "none",
      hasBearerFromRequest: false,
      bearerSegmentCount: 0,
      hasClerkSession: false,
      hasClerkCookie: false,
      organizationIdSet: false,
      backendUrl: "",
      jwtBeforeClients: null,
      jwtAfterRefresh: null,
    },
    clients: {
      httpStatus: 0,
      topKeys: [],
      success: null,
      error: null,
      dataIsArray: false,
      clientsCount: 0,
      applicantsCount: 0,
      responseSnippet: "",
      rawTextLength: 0,
      parseError: null,
    },
    clerkMintError: null,
    clerkRetryError: null,
  };
}
