"use strict";
const fs = require("fs");
const path = require("path");

// Restart profiles deliberately survive their children. Verify their physical
// ownership independently of the isolation helper's disposable scratch profile.
function prepareOwnedRestartDirectory(repositoryRoot, container, batch, requested) {
  let stage = "trusted repository root";
  let expected = repositoryRoot;
  const key = value => process.platform === "win32" ? value.toLowerCase() : value;
  const components = (value, label) => {
    if (typeof value !== "string" || !value || path.parse(value).root ||
        value.split(/[\\/]/).some(part => !part || part === "." || part === "..")) {
      throw new Error(label + " must be a relative directory without traversal");
    }
    return value.split(/[\\/]/);
  };
  try {
    const declaredRoot = path.resolve(repositoryRoot);
    const physicalRoot = fs.realpathSync.native(declaredRoot);
    stage = "declared container";
    const containerParts = components(container, "Container");
    const declaredContainer = path.join(declaredRoot, ...containerParts);
    stage = "batch containment";
    if (typeof batch !== "string" || !path.isAbsolute(batch) ||
        batch.split(/[\\/]/).includes("..")) {
      throw new Error("Batch must be absolute without parent traversal");
    }
    const batchRelative = path.relative(declaredContainer, batch);
    const batchParts = components(batchRelative, "Batch descendant");
    stage = "requested directory";
    const requestedParts = components(requested, "Requested directory");
    expected = physicalRoot;
    const verify = () => {
      const entry = fs.lstatSync(expected);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error("Not a real non-link directory");
      }
      if (key(fs.realpathSync.native(expected)) !== key(expected)) {
        throw new Error("Directory physical identity differs from its expected path");
      }
    };
    stage = "canonical repository root";
    verify();
    // A fresh checkout may lack the container; its verified parent is enough
    // to create it safely, just as for the batch and requested directories.
    // The batch is exclusive to this controller. This is a component walk,
    // not a concurrent-writer/handle-based filesystem transaction.
    for (const [label, parts] of [
      ["container", containerParts],
      ["batch", batchParts],
      ["requested", requestedParts],
    ]) {
      for (let index = 0; index < parts.length; index++) {
        expected = path.join(expected, parts[index]);
        stage = label + " " + parts.slice(0, index + 1).join(path.sep);
        try {
          fs.lstatSync(expected);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          try {
            fs.mkdirSync(expected);
          } catch (mkdirError) {
            if (mkdirError.code !== "EEXIST") throw mkdirError;
          }
        }
        verify();
      }
    }
    return expected;
  } catch (error) {
    throw new Error("Restart directory preparation at " + stage + " [" + expected + "]: " + error.message);
  }
}

module.exports = { prepareOwnedRestartDirectory };
