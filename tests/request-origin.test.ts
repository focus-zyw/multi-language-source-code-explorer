import assert from "node:assert/strict";
import { test } from "node:test";
import { isSameOriginRequest } from "../src/lib/request-origin.ts";

test("explanation accepts loopback aliases and the actual incoming Host", () => {
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal(isSameOriginRequest(new Request("http://localhost:3000/api/explain", {
      headers: { host: `${hostname}:3000`, origin: `http://${hostname}:3000`, "sec-fetch-site": "same-origin" },
    })), true, hostname);
  }
  assert.equal(isSameOriginRequest(new Request("http://localhost:3000/api/explain", {
    headers: { host: "localhost:4311", origin: "http://localhost:4311" },
  })), true);
});

test("explanation rejects foreign origins, other ports, schemes and malformed origins", () => {
  for (const origin of ["http://evil.test:3000", "http://localhost.evil.test:3000", "http://localhost:4000", "https://localhost:3000", "null", "invalid", "http://user@localhost:3000", "http://localhost:3000/path"]) {
    assert.equal(isSameOriginRequest(new Request("http://localhost:3000/api/explain", { headers: { host: "localhost:3000", origin } })), false, origin);
  }
  assert.equal(isSameOriginRequest(new Request("http://localhost:3000/api/explain", { headers: { "sec-fetch-site": "cross-site" } })), false);
});

test("explanation retains same-origin network deployments and headerless local clients", () => {
  assert.equal(isSameOriginRequest(new Request("https://atlas.example/api/explain", { headers: { origin: "https://atlas.example", host: "atlas.example" } })), true);
  assert.equal(isSameOriginRequest(new Request("http://localhost:3000/api/explain")), true);
});
