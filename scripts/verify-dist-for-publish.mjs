#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";

const packageDir = resolve(process.argv[2] || process.cwd());
const pkgPath = resolve(packageDir, "package.json");

if (!existsSync(pkgPath)) {
  console.error(`[publish-guard] no package.json found at ${pkgPath}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const distDir = resolve(packageDir, "dist");
const issues = [];

function fail(message) {
  issues.push(message);
}

function collectExportFiles(exportValue, out) {
  if (!exportValue) {
    return;
  }
  if (typeof exportValue === "string") {
    out.push(exportValue);
    return;
  }

  if (Array.isArray(exportValue)) {
    for (const entry of exportValue) {
      collectExportFiles(entry, out);
    }
    return;
  }

  if (typeof exportValue === "object") {
    for (const value of Object.values(exportValue)) {
      collectExportFiles(value, out);
    }
  }
}

function normalizePackagePath(candidate) {
  if (typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  if (isAbsolute(trimmed)) {
    return trimmed;
  }
  return trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
}

function entryPaths() {
  const candidates = [];

  if (pkg.main) {
    candidates.push(normalizePackagePath(pkg.main));
  }
  if (pkg.types) {
    candidates.push(normalizePackagePath(pkg.types));
  }

  const collected = [];
  collectExportFiles(pkg.exports, collected);
  for (const candidate of collected) {
    candidates.push(normalizePackagePath(candidate));
  }

  return [...new Set(candidates.filter(Boolean))];
}

function fileExistsWithBytes(targetPath) {
  if (!targetPath || !isAbsolute(targetPath)) {
    targetPath = resolve(packageDir, targetPath);
  }
  if (!existsSync(targetPath)) {
    return { ok: false, reason: "missing" };
  }

  const st = statSync(targetPath);
  if (!st.isFile()) {
    return { ok: false, reason: "not_a_file" };
  }

  if (st.size <= 0) {
    return { ok: false, reason: "empty_file" };
  }

  return { ok: true };
}

const distExists = existsSync(distDir);
if (!distExists) {
  fail(`missing dist directory: ${distDir}`);
} else {
  const distFiles = readdirSync(distDir);
  const jsOrDtsFiles = distFiles.filter((name) => name.endsWith(".js") || name.endsWith(".d.ts"));
  if (jsOrDtsFiles.length === 0) {
    fail(`dist directory has no .js/.d.ts artifacts at ${distDir}`);
  }
}

const filesList = pkg.files || [];
if (!Array.isArray(filesList) || !filesList.includes("dist")) {
  fail("publish files field does not include 'dist'");
}

for (const artifact of entryPaths()) {
  const check = fileExistsWithBytes(resolve(packageDir, artifact));
  if (!check.ok) {
    fail(`publish artifact missing or invalid: ${artifact} (${check.reason})`);
  }
}

if (issues.length > 0) {
  console.error(`[publish-guard] FAILED for package ${pkg.name || "<unknown>"}`);
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log(`[publish-guard] ${pkg.name || "<unknown>"} dist appears ready for publish`);
