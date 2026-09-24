import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { asbToken } from "../src/services/compose.js";

describe("asb image token extraction", () => {
  it("reads the same token from the grid and picker hosts", () => {
    const token = "AB-nOUa9iKgd4aMxdEJT_iBxyfD2iXKU";
    assert.equal(asbToken(`https://flow.google.com/asb/${token}=s1600-rw`), token);
    assert.equal(asbToken(`https://lh3.googleusercontent.com/asb/${token}=w400-h225`), token);
  });

  it("ignores query strings and urls without a token", () => {
    assert.equal(asbToken("https://lh3.googleusercontent.com/asb/ABC123?foo=bar"), "ABC123");
    assert.equal(asbToken("https://flow-content.google/image/15e471c5-b40b-47f7-9082-0b12d024bc00"), null);
    assert.equal(asbToken(null), null);
  });
});
