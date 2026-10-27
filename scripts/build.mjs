import { build } from "esbuild";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["web/main.ts"],
  outfile: "dist/app.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
});
await copyFile("web/index.html", "dist/index.html");
await copyFile("web/styles.css", "dist/styles.css");
await writeFile("dist/robots.txt", "User-agent: *\nDisallow: /\n");
await writeFile("dist/_headers", `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
  X-Robots-Tag: noindex, nofollow
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
  Cache-Control: no-cache
`);
console.log("Built static calendar assets in dist/.");
