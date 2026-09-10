import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_SIGNATURE_AGE_SECONDS = 300;

export class WebhookSignatureError extends Error {
  constructor(public readonly code: "UNIPILE_WEBHOOK_SECRET_NOT_CONFIGURED" | "UNIPILE_SIGNATURE_MISSING" | "UNIPILE_SIGNATURE_INVALID" | "UNIPILE_SIGNATURE_EXPIRED") {
    super(code);
  }
}

export function verifyUnipileAuthHeader(input: {
  authHeader: string | undefined;
  secret: string | undefined;
}): void {
  if (!input.secret) throw new WebhookSignatureError("UNIPILE_WEBHOOK_SECRET_NOT_CONFIGURED");
  if (!input.authHeader) throw new WebhookSignatureError("UNIPILE_SIGNATURE_MISSING");
  const expected = Buffer.from(input.secret, "utf8");
  const received = Buffer.from(input.authHeader, "utf8");
  const valid = expected.length === received.length && timingSafeEqual(expected, received);
  if (!valid) throw new WebhookSignatureError("UNIPILE_SIGNATURE_INVALID");
}

export function verifyUnipileSignature(input: {
  signatureHeader: string | undefined;
  rawBody: Buffer;
  secret: string | undefined;
  nowMs?: number;
}): void {
  if (!input.secret) throw new WebhookSignatureError("UNIPILE_WEBHOOK_SECRET_NOT_CONFIGURED");
  if (!input.signatureHeader) throw new WebhookSignatureError("UNIPILE_SIGNATURE_MISSING");

  const fields = Object.fromEntries(input.signatureHeader.split(",").map((part) => {
    const [key, value] = part.trim().split("=", 2);
    return [key, value];
  }));
  const timestamp = Number(fields.t);
  const receivedSignature = fields.v0;
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(timestamp) || Math.abs(Math.floor(now / 1000) - timestamp) > MAX_SIGNATURE_AGE_SECONDS) {
    throw new WebhookSignatureError("UNIPILE_SIGNATURE_EXPIRED");
  }
  if (!receivedSignature || !/^[a-f0-9]{64}$/i.test(receivedSignature)) {
    throw new WebhookSignatureError("UNIPILE_SIGNATURE_INVALID");
  }

  const expectedSignature = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.rawBody.toString("utf8")}`)
    .digest("hex");
  const valid = receivedSignature.length === expectedSignature.length && timingSafeEqual(
    Buffer.from(receivedSignature, "hex"),
    Buffer.from(expectedSignature, "hex")
  );
  if (!valid) throw new WebhookSignatureError("UNIPILE_SIGNATURE_INVALID");
}
