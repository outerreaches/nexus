import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPresetConfigOverrides,
  getPreset,
  getPresetKernelExtra,
  setPresetKernelOverrides,
} from "./presets.js";

function clearOverrides(): void {
  setPresetKernelOverrides({});
}

test("researcher preset uses real file tool names (file_read/file_edit, not read_file/edit_file)", () => {
  clearOverrides();
  const researcher = getPreset("researcher");
  assert.ok(researcher);
  assert.ok(researcher.tools.includes("file_read"), "researcher must expose file_read");
  assert.ok(researcher.tools.includes("file_edit"), "researcher must expose file_edit");
  assert.ok(!researcher.tools.includes("read_file"), "read_file is not a real tool name");
  assert.ok(!researcher.tools.includes("edit_file"), "edit_file is not a real tool name");
});

test("getPreset merges kernelExtra for tools in the preset pool", () => {
  // graphic-designer has `vectorize` in tools but not in its kernel.
  setPresetKernelOverrides({ "graphic-designer": ["vectorize"] });
  try {
    const preset = getPreset("graphic-designer");
    assert.ok(preset);
    assert.ok(preset.kernel?.includes("vectorize"), "vectorize should be promoted into kernel");
    // Base kernel entries are preserved.
    assert.ok(preset.kernel?.includes("image_generate"));
  } finally {
    clearOverrides();
  }
});

test("getPreset ignores kernelExtra entries not in the preset's tool pool", () => {
  setPresetKernelOverrides({ "graphic-designer": ["shell_exec", "ha_deploy"] });
  try {
    const preset = getPreset("graphic-designer");
    assert.ok(preset);
    assert.ok(!preset.kernel?.includes("shell_exec"), "tools outside the pool must not be promoted");
    assert.ok(!preset.kernel?.includes("ha_deploy"));
  } finally {
    clearOverrides();
  }
});

test("getPreset does not duplicate a tool already in the kernel", () => {
  // orchestrator already has file_read in its kernel.
  setPresetKernelOverrides({ orchestrator: ["file_read"] });
  try {
    const preset = getPreset("orchestrator");
    assert.ok(preset);
    const count = preset.kernel?.filter((t) => t === "file_read").length ?? 0;
    assert.equal(count, 1, "file_read should appear exactly once");
  } finally {
    clearOverrides();
  }
});

test("getPreset returns base object identity when no override applies", () => {
  clearOverrides();
  const a = getPreset("coder");
  const b = getPreset("coder");
  assert.equal(a, b, "with no overrides getPreset should return the singleton");
});

test("applyPresetConfigOverrides maps nexus.json presets config to kernel overrides", () => {
  applyPresetConfigOverrides({ coder: { kernelExtra: ["ha_deploy"] }, trader: { kernelExtra: [] } });
  try {
    assert.deepEqual([...getPresetKernelExtra("coder")], ["ha_deploy"]);
    // Empty arrays are dropped.
    assert.deepEqual([...getPresetKernelExtra("trader")], []);
    const coder = getPreset("coder");
    assert.ok(coder?.kernel?.includes("ha_deploy"), "ha_deploy is in coder's tool pool and should promote");
  } finally {
    clearOverrides();
  }
});
