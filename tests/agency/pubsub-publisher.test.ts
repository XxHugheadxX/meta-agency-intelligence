import { describe, expect, it, vi } from "vitest";
import {
  decodeReportingPubSubPush,
  GooglePubSubReportingQueuePublisher,
} from "../../src/agency/scheduler/index.js";

const topicName = "projects/agency-test-123/topics/agency-reporting-jobs";
const message = {
  payload: JSON.stringify({ tenantId: "tenant-a", workspaceId: "workspace-a" }),
  signature: "valid_signature",
};

describe("Google Pub/Sub reporting queue publisher", () => {
  it("publishes one validated signed envelope without putting credentials in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messageIds: ["123456789"],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const tokens = { getAccessToken: vi.fn().mockResolvedValue("synthetic-workload-token") };
    const publisher = new GooglePubSubReportingQueuePublisher(topicName, tokens, fetchMock);

    await publisher.publish(message);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://pubsub.googleapis.com/v1/${topicName}:publish`);
    expect(String(url)).not.toContain("synthetic-workload-token");
    expect(init.headers.Authorization).toBe("Bearer synthetic-workload-token");
    expect(init.redirect).toBe("error");
    const request = JSON.parse(String(init.body));
    expect(request).toEqual({ messages: [{ data: expect.any(String) }] });
    expect(decodeReportingPubSubPush({
      message: { data: request.messages[0].data, messageId: "123456789" },
      subscription: "projects/agency-test-123/subscriptions/agency-reporting-push",
    })).toEqual(message);
    expect(String(init.body)).not.toContain("synthetic-workload-token");
  });

  it("refreshes workload authentication once after a 401", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageIds: ["123"] }), {
        status: 200,
      }));
    const tokens = { getAccessToken: vi.fn().mockResolvedValue("synthetic-workload-token") };
    const publisher = new GooglePubSubReportingQueuePublisher(topicName, tokens, fetchMock);

    await publisher.publish(message);
    expect(tokens.getAccessToken).toHaveBeenNthCalledWith(1, false);
    expect(tokens.getAccessToken).toHaveBeenNthCalledWith(2, true);
  });

  it("fails closed on invalid topics, messages, and publish acknowledgements", async () => {
    expect(() => new GooglePubSubReportingQueuePublisher(
      "projects/agency-test-123/topics/../other",
    )).toThrow("topic name");
    expect(() => new GooglePubSubReportingQueuePublisher(
      "projects/agency-test-123/topics/goog-internal",
    )).toThrow("topic name");

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      messageIds: [],
    }), { status: 200 }));
    const publisher = new GooglePubSubReportingQueuePublisher(
      topicName,
      { getAccessToken: vi.fn().mockResolvedValue("synthetic-workload-token") },
      fetchMock,
    );
    await expect(publisher.publish({ ...message, signature: "not+base64" }))
      .rejects.toThrow("Invalid signed");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(publisher.publish(message)).rejects.toThrow("publish response");
  });
});
