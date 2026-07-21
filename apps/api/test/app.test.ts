import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

describe("detective archives API", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp();
  });

  after(async () => {
    await app.close();
  });

  it("returns health status", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: "ok",
      service: "detective-archives-api"
    });
  });

  it("lists detectives with pagination", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/detectives?pageSize=2" });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(body.data.length, 2);
    assert.equal(body.pagination.total, 3);
    assert.equal(body.pagination.totalPages, 2);
  });

  it("filters detectives by keyword", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/detectives?q=%E6%B3%A2%E6%B4%9B" });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].slug, "hercule-poirot");
  });

  it("returns one detective by slug", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/detectives/sherlock-holmes" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.nameZh, "夏洛克·福尔摩斯");
  });

  it("returns a stable error for a missing detective", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/detectives/not-exist" });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().code, "DETECTIVE_NOT_FOUND");
  });

  it("rejects invalid pagination", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/detectives?page=0" });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "INVALID_QUERY");
  });

  it("lists the complete picture-book volume index", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/picture-book?pageSize=150"
    });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(body.data.length, 109);
    assert.equal(body.coverage.standardVolumeCount, 108);
    assert.equal(body.coverage.latestPublishedVolume, 108);
    assert.equal(body.pagination.total, 109);
  });

  it("searches picture-book names, aliases and recommended works", async () => {
    const aliasResponse = await app.inject({
      method: "GET",
      url: "/api/v1/picture-book?q=%E9%B2%81%E9%82%A6"
    });
    assert.equal(aliasResponse.statusCode, 200);
    assert.equal(aliasResponse.json().data[0].id, "PB-004-STD");

    const workResponse = await app.inject({
      method: "GET",
      url: "/api/v1/picture-book?q=%E6%81%90%E6%80%96%E8%B0%B7"
    });
    assert.equal(workResponse.statusCode, 200);
    assert.equal(workResponse.json().data[0].id, "PB-001-STD");
  });

  it("keeps standard and special volume entries distinct", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/picture-book?fromVolume=105&toVolume=105&pageSize=10"
    });
    const body = response.json();
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      body.data.map((entry: { id: string }) => entry.id),
      ["PB-105-STD", "PB-105-SP"]
    );
  });

  it("returns one picture-book entry with a case-insensitive id", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/picture-book/pb-105-sp"
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.names.zh, "工藤新一");
    assert.equal(response.json().data.verification.identity, "PRIMARY_SOURCE_CONFIRMED");
  });

  it("rejects a reversed picture-book volume range", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/picture-book?fromVolume=20&toVolume=10"
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, "INVALID_QUERY");
  });
});
