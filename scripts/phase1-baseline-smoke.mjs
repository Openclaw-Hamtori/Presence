#!/usr/bin/env node
import { execSync } from 'node:child_process';

const steps = [
  {
    name: 'workspace check-mobile-sync guard',
    command: 'npm run check:mobile-sync',
  },
  {
    name: 'presence-sdk tests',
    command: 'npm run test -w presence-sdk',
  },
  {
    name: 'presence-verifier tests',
    command: 'npm run test -w presence-verifier',
  },
  {
    name: 'presence-mobile type-check',
    command: 'npm run type-check -w presence-mobile',
  },
  {
    name: 'presence-test-app type-check',
    command: 'npm run type-check -w presence-test-app',
  },
];

let failed = false;

for (const step of steps) {
  console.log(`\n[phase1-smoke] running: ${step.name}`);
  try {
    execSync(step.command, { stdio: 'inherit', shell: '/bin/zsh' });
  } catch (err) {
    failed = true;
    console.error(`[phase1-smoke] FAILED: ${step.name}`);
    break;
  }
}

if (failed) {
  console.error('\nPhase 1 smoke checks failed. Baseline not green.');
  process.exitCode = 1;
} else {
  console.log('\nPhase 1 smoke checks passed. Baseline safe to proceed.');
}
