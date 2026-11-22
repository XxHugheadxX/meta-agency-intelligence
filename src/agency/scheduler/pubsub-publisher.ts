import {
  MetadataServerAccessTokenProvider,
  type GoogleAccessTokenProvider,
} from "../delivery/index.js";
import {
  encodeReportingPubSubData,
  parseSignedReportingMessage,
  type SignedReportingMessage,
} from "./pubsub-envelope.js";
import type { ReportingQueuePublisher } from "./reporting-fan-out.js";

const PUBSUB_ORIGIN = "https://pubsub.googleapis.com";
const MAX_RESPONSE_BYTES = 8 * 1024;

function validateTopicName(value: string): void {
  if (!/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~-]{2,254}$/.test(value)) {
    throw new Error("Invalid reporting Pub/Sub topic name");
  }
  const topicId = value.slice(value.lastIndexOf("/") + 1);
  if (/^goog/i.test(topicId)) throw new Error("Invalid reporting Pub/Sub topic name");
}

async function readLimitedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error("Pub/Sub response exceeds its size limit");
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Pub/Sub response exceeds its size limit");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Pub/Sub returned an invalid response");
  }
}

function assertPublishResponse(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Pub/Sub returned an invalid publish response");
  }
  const record = value as Record<string, unknown>;
  if (
    !Array.isArray(record.messageIds) ||
    record.messageIds.length !== 1 ||
    typeof record.messageIds[0] !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(record.messageIds[0])
  ) {
    throw new Error("Pub/Sub returned an invalid publish response");
  }
}

export class GooglePubSubReportingQueuePublisher implements ReportingQueuePublisher {
  private readonly endpoint: URL;

  constructor(
    topicName: string,
    private readonly tokens: GoogleAccessTokenProvider =
      new MetadataServerAccessTokenProvider(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    validateTopicName(topicName);
    this.endpoint = new URL(`/v1/${topicName}:publish`, PUBSUB_ORIGIN);
  }

  async publish(message: SignedReportingMessage): Promise<void> {
    const validated = parseSignedReportingMessage(message);
    if (!validated) throw new Error("Invalid signed reporting queue message");
    const body = JSON.stringify({
      messages: [{ data: encodeReportingPubSubData(validated) }],
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.tokens.getAccessToken(attempt > 0);
      let response: Response;
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body,
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        throw new Error("Pub/Sub reporting queue is unavailable");
      }
      if (response.status === 401 && attempt === 0) continue;
      if (!response.ok) throw new Error("Pub/Sub rejected the reporting message");
      assertPublishResponse(await readLimitedJson(response));
      return;
    }
    throw new Error("Pub/Sub reporting authentication failed");
  }
}
