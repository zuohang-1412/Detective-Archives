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
});
