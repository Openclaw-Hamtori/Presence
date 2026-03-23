#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = process.cwd();
const serverPath = join(repoRoot, 'presence-happy-path', 'app', 'server.cjs');
const source = readFileSync(serverPath, 'utf8');

const checks = [
  'endpointContract = {',
  'createSessionPath: "/presence/link-sessions"',
  'completeSessionPath: "/presence/link-sessions/:sessionId/complete"',
  'sessionStatusPath: "/presence/link-sessions/:sessionId"',
  'linkedNoncePath: "/presence/linked-accounts/:accountId/nonce"',
  'verifyLinkedAccountPath: "/presence/linked-accounts/:accountId/verify"',
  'linkedPendingProofRequestsPath: "/presence/linked-accounts/:accountId/pending-proof-requests"',
  'pendingProofRequestPath: "/presence/pending-proof-requests/:requestId"',
  'respondPendingProofRequestPath: "/presence/pending-proof-requests/:requestId/respond"',
  'linkedStatusPath: "/presence/linked-accounts/:accountId/status"',
  'unlinkAccountPath: "/presence/linked-accounts/:accountId/unlink"',
  'auditEventsPath: "/presence/audit-events"',
  'deviceBindingsPath: "/presence/devices/:deviceIss/bindings"',
  'requestPath === "/.well-known/presence.json"',
  'requestPath === "/health"',
  'const pendingMatch = requestPath.match(/^\\/presence\\/linked-accounts\\/([^/]+)\\/pending-proof-requests$/)',
  'const pendingRequestMatch = requestPath.match(/^\\/presence\\/pending-proof-requests\\/([^/]+)$/)',
  'const respondPendingMatch = requestPath.match(/^\\/presence\\/pending-proof-requests\\/([^/]+)\\/respond$/)',
];

const failures = [];

for (const line of checks) {
  if (!source.includes(line)) {
    failures.push(`Expected contract/signature fragment missing from server.cjs: ${line}`);
  }
}

if (failures.length > 0) {
  console.error('presence-happy-path contract guard failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('presence-happy-path contract guard passed: core Presence endpoint shape still present.');
