const fs = require("fs");
const path = require("path");
const { SCHEMES } = require("./owned-dialogs");
let cachedCss = null;

function canonicalPopupCss() {
  if (cachedCss !== null) return cachedCss;
  const source = fs.readFileSync(path.join(__dirname, "styles.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (selector === ":root" || selector === "body" || selector === "body.dark-mode" ||
        /^body\[data-theme="(?:clarity|parchment|abyss|ember)"\]$/.test(selector)) {
      const properties = [...match[2].matchAll(/(--[\w-]+\s*:[^;{}]+;)/g)]
        .map(value => value[1]);
      if (properties.length) blocks.push(`${selector}{${properties.join("")}}`);
      if (selector === "body") {
        const family = match[2].match(/(?:^|;)\s*font-family\s*:\s*([^;{}]+);/);
        if (family) blocks.push(`body,button,input,select{font-family:${family[1]}}`);
      }
    }
  }
  // Data documents cannot depend on file: stylesheet resolution. These are
  // trusted bundled sources, not CSS or URLs supplied by document content.
  for (const match of source.matchAll(/@font-face\s*\{[^{}]*\}/g)) {
    if (!/FiraCode-(?:Regular|Bold)\.ttf/.test(match[0])) continue;
    blocks.push(match[0].replace(/url\(['"]?\.\.\/fonts\/(FiraCode-(?:Regular|Bold)\.ttf)['"]?\)/,
      (_all, name) => `url("data:font/ttf;base64,${fs.readFileSync(path.join(__dirname, "..", "fonts", name)).toString("base64")}")`));
  }
  cachedCss = blocks.join("\n");
  return cachedCss;
}

function popupTheme(themeId) {
  if (!SCHEMES.has(themeId)) themeId = "default-light";
  const dark = ["default-dark", "abyss", "ember"].includes(themeId);
  return {
    dark, css: canonicalPopupCss(),
    attributes: `${dark ? 'class="dark-mode" ' : ""}${
      themeId.startsWith("default-") ? "" : `data-theme="${themeId}"`}`,
  };
}

module.exports = { popupTheme };
