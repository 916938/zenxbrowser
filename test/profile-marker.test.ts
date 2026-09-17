import { test } from "node:test";
import assert from "node:assert/strict";
import { extractProfileMarker, markerFromTitles, markerMatches, expectedMarkers } from "../src/profile-marker.ts";

test("extractProfileMarker 从真实窗口标题取出 Profile 段", () => {
  assert.equal(extractProfileMarker("New tab - 8 - Microsoft​ Edge"), "8");
  assert.equal(extractProfileMarker("about:blank - 10 - Microsoft Edge"), "10");
  assert.equal(extractProfileMarker("Agent Router and 3 more pages - 9 - Microsoft Edge"), "9");
  assert.equal(extractProfileMarker("Inbox - Default - Microsoft Edge"), "default");
});

test("extractProfileMarker 对无关标题返回 null", () => {
  for (const title of ["", "Microsoft Edge", "No dashes here", "-  - Microsoft Edge", "Edge"]) {
    assert.equal(extractProfileMarker(title), null, title);
  }
});

test("markerFromTitles 用多重集差集，重复标题也能识别新窗口", () => {
  const before = ["New tab - 8 - Microsoft Edge", "New tab - 8 - Microsoft Edge"];
  const after = [...before, "about:blank - 9 - Microsoft Edge"];
  assert.equal(markerFromTitles(before, after), "9");
  // 没有新窗口时不得凭空返回标记。
  assert.equal(markerFromTitles(before, before), null);
  // 少了一个窗口（没有新增）也不得误判。
  assert.equal(markerFromTitles(before, before.slice(0, 1)), null);
});

test("markerFromTitles 新窗口 Profile 不唯一时拒绝判定", () => {
  const before: string[] = [];
  const after = ["a - 8 - Microsoft Edge", "b - 9 - Microsoft Edge"];
  assert.equal(markerFromTitles(before, after), null, "两个不同 Profile 不能盲选");
});

test("expectedMarkers / markerMatches 处理 Default 与 Profile N", () => {
  assert.deepEqual(expectedMarkers("Profile 8"), ["8"]);
  assert.deepEqual(expectedMarkers("profile 10"), ["10"]);
  assert.deepEqual(expectedMarkers("Default"), ["default", "1"], "Default 也可能显示为 1");
  assert.equal(markerMatches("8", "Profile 8"), true);
  assert.equal(markerMatches("8", "Profile 9"), false);
  assert.equal(markerMatches("default", "Default"), true);
  assert.equal(markerMatches("1", "Default"), true);
  assert.equal(markerMatches(null, "Profile 8"), false);
});
