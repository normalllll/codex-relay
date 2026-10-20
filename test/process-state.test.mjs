import { adaptTest } from "./support/harness.mjs";
const test = adaptTest(await import(process.versions.bun ? "bun:test" : "node:test"));
import assert from "node:assert/strict";
import { isMissingProcess } from "../process-state.mjs";

test("lock recovery recognizes missing processes without treating access denial as a dead owner", () => {
  assert.equal(isMissingProcess({ code: "ESRCH" }, "linux"), true);
  const legacy = { code: "", errno: -4040, syscall: "kill" };
  assert.equal(isMissingProcess(legacy, "win32"), true);
  assert.equal(isMissingProcess(legacy, "linux"), false);
  for (const error of [{ code: "EPERM" }, { code: "EACCES" }, { code: "" }, { code: "", errno: -4040, syscall: "open" }])
    assert.equal(isMissingProcess(error, "win32"), false);
});
