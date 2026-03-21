import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { readdirSync, statSync } from "fs";
import path from "path";

const repoRoot = process.cwd();
const mobileRoot = path.join(repoRoot, "presence-mobile/src");
const testAppRoot = path.join(repoRoot, "presence-test-app/src");

const mirroredDuplicates = [
  "attestation/appAttest.ts",
  "backgroundRefresh.ts",
  "deeplink.ts",
  "health/pass.test.mjs",
  "health/pass.ts",
  "qrScanner.ts",
  "sync/queue.ts",
  "types/index.ts",
  "ui/assets/presence-orb.png",
  "ui/components/PresenceStatusCard.tsx",
  "ui/connectionLinking.ts",
  "ui/screens/OnboardingScreen.tsx",
  "ui/usePresenceBackgroundSync.ts",
  "ui/usePresenceState.ts",
];

const intentionalForks = {
  "crypto/index.ts": "test app keeps extra signature/base64 diagnostics for device crypto debugging",
  "health/healthkit.ts": "test app uses tuned HealthKit query settings for rapid device validation",
  "index.ts": "test app export surface includes app-only debugging and validation helpers",
  "linkTrust.ts": "test app keeps verbose trust-boundary diagnostics during deeplink/QR debugging",
  "service.ts": "test app preserves app-specific proof orchestration and local-state behavior",
  "state/presenceState.ts": "test app compresses timing and carries app-only hydration helpers for validation",
  "sync/linkedBindings.ts": "test app records detailed linked-sync diagnostics and stricter debug guardrails",
};

const allowedMissingInTestApp = new Set([
  "ui/screens/ConnectionFlowScreen.tsx",
]);

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, base, out);
      continue;
    }
    out.push(path.relative(base, fullPath).replace(/\\/g, "/"));
  }
  return out;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

const mobileFiles = new Set(walk(mobileRoot));
const testAppFiles = new Set(walk(testAppRoot));
const duplicatedPaths = [...mobileFiles].filter((relPath) => testAppFiles.has(relPath)).sort();
const categorizedPaths = new Set([
  ...mirroredDuplicates,
  ...Object.keys(intentionalForks),
]);
const errors = [];

for (const relPath of duplicatedPaths) {
  assert(
    categorizedPaths.has(relPath),
    `Uncategorized duplicate source file: ${relPath}`,
    errors
  );
}

for (const relPath of mirroredDuplicates) {
  const mobileFile = path.join(mobileRoot, relPath);
  const testFile = path.join(testAppRoot, relPath);
  assert(existsSync(mobileFile), `Missing mirrored mobile file: ${relPath}`, errors);
  assert(existsSync(testFile), `Missing mirrored test-app file: ${relPath}`, errors);
  if (!existsSync(mobileFile) || !existsSync(testFile)) continue;
  assert(
    sha256(mobileFile) === sha256(testFile),
    `Mirrored file drifted: ${relPath}`,
    errors
  );
}

for (const [relPath, reason] of Object.entries(intentionalForks)) {
  const mobileFile = path.join(mobileRoot, relPath);
  const testFile = path.join(testAppRoot, relPath);
  assert(existsSync(mobileFile), `Missing intentional mobile fork target: ${relPath}`, errors);
  assert(existsSync(testFile), `Missing intentional test-app fork file: ${relPath}`, errors);
  if (!existsSync(testFile)) continue;

  const testFileText = readFileSync(testFile, "utf8");
  assert(
    testFileText.includes("INTENTIONAL_FORK:"),
    `Intentional fork file is missing the required INTENTIONAL_FORK marker: ${relPath}`,
    errors
  );
  assert(
    testFileText.toLowerCase().includes(reason.split(" ")[0]),
    `Intentional fork comment looks stale for ${relPath}; expected reason: ${reason}`,
    errors
  );
}

for (const relPath of allowedMissingInTestApp) {
  assert(mobileFiles.has(relPath), `Allowed mobile-only file is missing in mobile: ${relPath}`, errors);
  assert(!testAppFiles.has(relPath), `Mobile-only file unexpectedly exists in test app: ${relPath}`, errors);
}

const unexpectedMissingInTestApp = [...mobileFiles]
  .filter((relPath) => !testAppFiles.has(relPath) && !allowedMissingInTestApp.has(relPath))
  .sort();

for (const relPath of unexpectedMissingInTestApp) {
  errors.push(`Unexpected mobile-only file without explicit allowlist entry: ${relPath}`);
}

if (errors.length > 0) {
  console.error("presence-mobile / presence-test-app sync guard failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `presence-mobile / presence-test-app sync guard passed: ${mirroredDuplicates.length} mirrored files, ${Object.keys(intentionalForks).length} intentional forks.`
);
