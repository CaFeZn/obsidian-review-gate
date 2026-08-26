import assert from "node:assert/strict";
import test from "node:test";
import { isNativeViewMounted } from "../packages/obsidian-plugin/src/editor/native-view-lifecycle";

test("native view lifecycle rejects a connected element from a closed window", () => {
  assert.equal(isNativeViewMounted(elementState(true, false)), true);
  assert.equal(isNativeViewMounted(elementState(true, true)), false);
  assert.equal(isNativeViewMounted(elementState(false, false)), false);
  assert.equal(isNativeViewMounted(elementState(true, null)), false);
});

function elementState(isConnected: boolean, closed: boolean | null): HTMLElement {
  return {
    isConnected,
    ownerDocument: {
      defaultView: closed === null ? null : { closed },
    },
  } as unknown as HTMLElement;
}
