const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const MAX_MESSAGE_DATA_BYTES = 24 * 1024;
const MAX_ATTRIBUTES = 50;

export interface SignedReportingMessage {
  readonly payload: string;
  readonly signature: string;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

export function parseSignedReportingMessage(value: unknown): SignedReportingMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (
    !exactKeys(message, ["payload", "signature"]) ||
    typeof message.payload !== "string" ||
    typeof message.signature !== "string" ||
    Buffer.byteLength(message.payload, "utf8") === 0 ||
    Buffer.byteLength(message.payload, "utf8") > MAX_PAYLOAD_BYTES ||
    Buffer.byteLength(message.signature, "utf8") === 0 ||
    Buffer.byteLength(message.signature, "utf8") > MAX_SIGNATURE_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(message.signature)
  ) {
    return null;
  }
  return { payload: message.payload, signature: message.signature };
}

function validAttributes(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= MAX_ATTRIBUTES && entries.every(
    ([key, child]) =>
      /^[A-Za-z0-9._:-]{1,256}$/.test(key) &&
      typeof child === "string" &&
      Buffer.byteLength(child, "utf8") <= 1_024,
  );
}

function decodeBase64Json(value: string): unknown {
  if (
    value.length === 0 ||
    value.length > Math.ceil(MAX_MESSAGE_DATA_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("Pub/Sub message data is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_MESSAGE_DATA_BYTES) {
    throw new Error("Pub/Sub message data exceeds its size limit");
  }
  if (bytes.toString("base64") !== value) {
    throw new Error("Pub/Sub message data is not canonical base64");
  }
  const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(json) as unknown;
}

export function decodeReportingPubSubPush(value: unknown): SignedReportingMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const push = value as Record<string, unknown>;
  const allowedPushKeys = new Set(["message", "subscription", "deliveryAttempt"]);
  if (Object.keys(push).some((key) => !allowedPushKeys.has(key))) return null;
  if (
    typeof push.subscription !== "string" ||
    !/^projects\/[A-Za-z0-9._:-]{1,128}\/subscriptions\/[A-Za-z0-9._:-]{1,255}$/.test(push.subscription) ||
    !push.message ||
    typeof push.message !== "object" ||
    Array.isArray(push.message)
  ) {
    return null;
  }
  if (
    push.deliveryAttempt !== undefined &&
    (!Number.isSafeInteger(push.deliveryAttempt) || (push.deliveryAttempt as number) < 1)
  ) {
    return null;
  }

  const message = push.message as Record<string, unknown>;
  const allowedMessageKeys = new Set([
    "attributes",
    "data",
    "messageId",
    "orderingKey",
    "publishTime",
  ]);
  if (
    Object.keys(message).some((key) => !allowedMessageKeys.has(key)) ||
    typeof message.data !== "string" ||
    typeof message.messageId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(message.messageId) ||
    !validAttributes(message.attributes)
  ) {
    return null;
  }
  if (
    message.publishTime !== undefined &&
    (typeof message.publishTime !== "string" || Number.isNaN(Date.parse(message.publishTime)))
  ) {
    return null;
  }
  if (
    message.orderingKey !== undefined &&
    (typeof message.orderingKey !== "string" || Buffer.byteLength(message.orderingKey, "utf8") > 1_024)
  ) {
    return null;
  }

  try {
    return parseSignedReportingMessage(decodeBase64Json(message.data));
  } catch {
    return null;
  }
}

export function encodeReportingPubSubData(message: SignedReportingMessage): string {
  const validated = parseSignedReportingMessage(message);
  if (!validated) throw new Error("Reporting Pub/Sub message is invalid");
  return Buffer.from(JSON.stringify(validated), "utf8").toString("base64");
}
