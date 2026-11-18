"use strict";

const fs = require("fs");
const path = require("path");

function prepareReleaseNotes(root, ref) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Release notes require a stable x.y.z package version.");
  }
  if (ref !== `refs/tags/v${version}`) {
    throw new Error(`Release notes require refs/tags/v${version}; received ${ref}.`);
  }

  const notesPath = path.resolve(root, "docs", `RELEASE-NOTES-${version}.md`);
  const body = fs.readFileSync(notesPath, "utf8");
  if (body.length > 65536) {
    throw new Error("Release notes exceed the update popup's Markdown size limit.");
  }
  const lines = body.replace(/^\uFEFF/, "").split(/\r\n?|\n/);
  const expected = `Release notes need '# Markaloo ${version}' and plain-text customer change bullets. ` +
    "Use only ## sections, '- Text' bullets and two-space wrapped lines; escape '<' as '&lt;'.";
  if (lines[0] !== `# Markaloo ${version}` || body.includes("<")) {
    throw new Error(expected);
  }
  // A small change-list format avoids counting hidden comments or code as release changes.
  let hasBullet = false, inBullet = false;
  for (const line of lines.slice(1)) {
    if (!line.trim() || /^## [\p{L}\p{N}]/u.test(line)) {
      inBullet = false;
    } else if (/^- [\p{L}\p{N}]/u.test(line)) {
      hasBullet = true;
      inBullet = true;
    } else if (!inBullet || !/^  [\p{L}\p{N}]/u.test(line)) {
      throw new Error(expected);
    }
  }
  if (!hasBullet) throw new Error(expected);
  return notesPath;
}

function verifyPublishedReleaseNotes(root, ref, release) {
  const notesPath = prepareReleaseNotes(root, ref);
  if (!release || release.tag_name !== ref.slice("refs/tags/".length) ||
      release.draft !== false || release.body !== fs.readFileSync(notesPath, "utf8")) {
    throw new Error("Published release notes do not match the exact tag and validated customer notes.");
  }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3 && process.argv.length !== 4) {
      throw new Error("Usage: node scripts/prepare-release-notes.js refs/tags/vX.X.X [published-release.json]");
    }
    const root = path.resolve(__dirname, ".."), ref = process.argv[2];
    if (process.argv.length === 4) {
      verifyPublishedReleaseNotes(root, ref, JSON.parse(fs.readFileSync(process.argv[3], "utf8")));
      console.log(`Published release notes match ${ref}.`);
    } else {
      const notesPath = prepareReleaseNotes(root, ref);
      if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `path=${notesPath}\n`);
      }
      console.log(notesPath);
    }
  } catch (error) {
    console.error(`Release notes check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { prepareReleaseNotes, verifyPublishedReleaseNotes };
