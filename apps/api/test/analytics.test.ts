import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashVisitorId } from "../src/analytics/visitor.js";

describe("privacy-minimized product analytics", () => {
  it("hashes valid visitor ids without retaining the source value", () => {
    const visitorId = "wx_analytics_test_visitor_123456";
    const digest = hashVisitorId(visitorId);
    assert.equal(digest?.length, 64);
    assert.notEqual(digest, visitorId);
    assert.equal(hashVisitorId(visitorId), digest);
  });

  it("ignores malformed visitor ids", () => {
    assert.equal(hashVisitorId("short"), null);
    assert.equal(hashVisitorId("visitor id with spaces"), null);
    assert.equal(hashVisitorId(["visitor-id"]), null);
  });
});
