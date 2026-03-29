/**
 * Unit tests for strip-json-fences.ts — strips markdown code fences
 * that LLMs sometimes wrap around JSON responses.
 */
import { test, expect } from "@playwright/test";
import { stripJsonFences } from "../../src/shared/strip-json-fences";

test.describe("stripJsonFences", () => {
  test("JSON without fences returns unchanged", () => {
    const json = '{"key": "value", "num": 42}';
    expect(stripJsonFences(json)).toBe(json);
  });

  test("strips ```json fences", () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(stripJsonFences(input)).toBe('{"key": "value"}');
  });

  test("strips ``` fences with no language tag", () => {
    const input = '```\n{"key": "value"}\n```';
    expect(stripJsonFences(input)).toBe('{"key": "value"}');
  });

  test("strips fences with arbitrary language tag", () => {
    const input = '```javascript\nconsole.log("hi")\n```';
    expect(stripJsonFences(input)).toBe('console.log("hi")');
  });

  test("handles whitespace around fences", () => {
    const input = '  \n```json\n{"a": 1}\n```\n  ';
    expect(stripJsonFences(input)).toBe('{"a": 1}');
  });

  test("preserves nested backticks inside content", () => {
    // Content that contains backticks but not the fence pattern
    const input = '```json\n{"code": "use `backticks` here"}\n```';
    expect(stripJsonFences(input)).toBe('{"code": "use `backticks` here"}');
  });

  test("empty string returns empty", () => {
    expect(stripJsonFences("")).toBe("");
  });

  test("only backticks without proper fence structure returns trimmed input", () => {
    expect(stripJsonFences("```")).toBe("```");
  });

  test("already trimmed content without fences returns as-is", () => {
    const input = '{"already": "clean"}';
    expect(stripJsonFences(input)).toBe('{"already": "clean"}');
  });

  test("multiline JSON inside fences", () => {
    const input = '```json\n{\n  "a": 1,\n  "b": 2\n}\n```';
    expect(stripJsonFences(input)).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  test("trims whitespace from extracted content", () => {
    const input = '```json\n  {"key": "value"}  \n```';
    expect(stripJsonFences(input)).toBe('{"key": "value"}');
  });

  test("trims leading/trailing whitespace on input without fences", () => {
    const input = '   {"key": "value"}   ';
    expect(stripJsonFences(input)).toBe('{"key": "value"}');
  });
});
