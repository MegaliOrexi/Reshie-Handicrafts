// Gateway access tokens: HS256 JWTs signed with our own secret.
// Secret: GATEWAY_JWT_SECRET (at least 32 random characters).
import { jwtVerify, SignJWT } from "npm:jose@5.9.6";

const ISSUER = "reshie-pos";
const AUDIENCE = "egoal-gateway";
export const TOKEN_TTL_SECONDS = 3600;

function key(): Uint8Array {
  const secret = Deno.env.get("GATEWAY_JWT_SECRET") ?? "";
  if (secret.length < 32) throw new Error("GATEWAY_JWT_SECRET missing or shorter than 32 characters");
  return new TextEncoder().encode(secret);
}

export async function signToken(clientId: string, email: string): Promise<string> {
  return await new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(clientId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(key());
}

/** Returns { clientId, email } or throws. */
export async function verifyToken(token: string): Promise<{ clientId: string; email: string }> {
  const { payload } = await jwtVerify(token, key(), { issuer: ISSUER, audience: AUDIENCE, algorithms: ["HS256"] });
  return { clientId: String(payload.sub), email: String(payload.email ?? "") };
}
