// Generates standalone.html (double-click build) from src/App.jsx + src/styles.css.
// Run:  node scripts/build-standalone.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// src/ uses Vite-style absolute "/assets/..." (Vite maps public/ to the site root).
// The standalone build is served on GitHub Pages PROJECT PAGE (/<repo>/), so rewrite the
// primary path to "/MOMAH-housingsub/assets/...". Only matches the src="/assets/..." form,
// so the onError fallbacks ("public/assets/..." and "assets/...") are left untouched.
const REPO_BASE = "/MOMAH-housingsub";
const css = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8").replaceAll("url('/assets/", "url('" + REPO_BASE + "/assets/");
let code = fs.readFileSync(path.join(root, "src", "App.jsx"), "utf8").replaceAll('"/assets/', '"' + REPO_BASE + '/assets/');

code = code
  .replace('import React, { useState, useMemo, useEffect, useRef, createContext, useContext } from "react";',
           'const { useState, useMemo, useEffect, useRef, createContext, useContext } = React;')
  .replace('import * as RC from "recharts";', 'const RC = window.Recharts || {};')
  .replace(/\nexport default App;\s*$/, "\n");
code += '\nReactDOM.createRoot(document.getElementById("root")).render(<App />);\n';

const html = `<!doctype html>
<html lang="en" dir="ltr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MOMAH · Dynamic Subsidy Allocation & Optimization</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Naskh+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${css}
</style>
</head>
<body>
<div id="root"></div>
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script crossorigin src="https://unpkg.com/prop-types@15/prop-types.min.js"></script>
<script crossorigin src="https://unpkg.com/recharts@2.12.7/umd/Recharts.js"></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script type="text/babel" data-presets="react">
${code}
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(root, "standalone.html"), html);
console.log("standalone.html written:", html.length, "bytes");
