/**
 * Unit tests for network-errors.ts — detects transient network errors
 * that should trigger retry rather than permanent failure.
 */
import { test, expect } from "@playwright/test";
import { isNetworkError } from "../../src/main/services/network-errors";

test.describe("isNetworkError", () => {
  test("Error with ENOTFOUND message → true", () => {
    expect(isNetworkError(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe(true);
  });

  test("Error with ETIMEDOUT message → true", () => {
    expect(isNetworkError(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe(true);
  });

  test("Error with ECONNREFUSED message → true", () => {
    expect(isNetworkError(new Error("connect ECONNREFUSED 127.0.0.1:3000"))).toBe(true);
  });

  test("Error with ECONNRESET message → true", () => {
    expect(isNetworkError(new Error("read ECONNRESET"))).toBe(true);
  });

  test('Error with "socket hang up" message → true', () => {
    expect(isNetworkError(new Error("socket hang up"))).toBe(true);
  });

  test('Error with message containing "network" → true', () => {
    expect(isNetworkError(new Error("network timeout at: https://example.com"))).toBe(true);
  });

  test("object with code ENOTFOUND → true", () => {
    const err = { code: "ENOTFOUND", message: "some error" };
    expect(isNetworkError(err)).toBe(true);
  });

  test("object with code ETIMEDOUT → true", () => {
    const err = { code: "ETIMEDOUT" };
    expect(isNetworkError(err)).toBe(true);
  });

  test("object with code ECONNREFUSED → true", () => {
    const err = { code: "ECONNREFUSED" };
    expect(isNetworkError(err)).toBe(true);
  });

  test("object with code ECONNRESET → true", () => {
    const err = { code: "ECONNRESET" };
    expect(isNetworkError(err)).toBe(true);
  });

  test('regular error "invalid input" → false', () => {
    expect(isNetworkError(new Error("invalid input"))).toBe(false);
  });

  test("null → false", () => {
    expect(isNetworkError(null)).toBe(false);
  });

  test("undefined → false", () => {
    expect(isNetworkError(undefined)).toBe(false);
  });

  test("non-error object without network indicators → false", () => {
    expect(isNetworkError({ foo: "bar" })).toBe(false);
  });

  test("string coercion: plain string with network keyword → true", () => {
    // String(error) for a non-Error produces the string itself
    expect(isNetworkError("network failure")).toBe(true);
  });

  test("string coercion: plain string without network keyword → false", () => {
    expect(isNetworkError("something else")).toBe(false);
  });
});
