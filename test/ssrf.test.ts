import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpUrl, isForbiddenIp } from "../src/ssrf.js";

test("forbidden addresses: loopback, RFC1918, link-local/metadata, CGNAT, v6 privates", () => {
  for (const ip of [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "169.254.0.1", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12::1", "fe80::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.5", "64:ff9b::a00:1",
  ]) {
    assert.equal(isForbiddenIp(ip), true, `${ip} must be forbidden`);
  }
});

test("public addresses pass", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isForbiddenIp(ip), false, `${ip} must be allowed`);
  }
});

test("assertPublicHttpUrl rejects bad protocols, credentials, and private IP literals", async () => {
  await assert.rejects(() => assertPublicHttpUrl("file:///etc/passwd"), /protocol/);
  await assert.rejects(() => assertPublicHttpUrl("ftp://example.com/x"), /protocol/);
  await assert.rejects(() => assertPublicHttpUrl("http://user:pass@example.com/"), /credentials/);
  await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1/img.png"), /private/);
  await assert.rejects(() => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/"), /private/);
  await assert.rejects(() => assertPublicHttpUrl("http://[::1]/img.png"), /private/);
  await assert.rejects(() => assertPublicHttpUrl("not a url"), /valid URL/);
});

test("assertPublicHttpUrl checks every resolved address", async () => {
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const rebindLookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.7", family: 4 }, // one private A record poisons the set
  ];
  const url = await assertPublicHttpUrl("https://example.com/cat.jpg", publicLookup);
  assert.equal(url.hostname, "example.com");
  await assert.rejects(() => assertPublicHttpUrl("https://example.com/cat.jpg", rebindLookup), /private/);
});
