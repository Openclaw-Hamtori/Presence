import AsyncStorage from "@react-native-async-storage/async-storage";
import type { MeasureResult } from "../service";
import type { ServiceBinding } from "../types/index";

const STORAGE_KEY = "@presence:linked-sync-queue:v1";
const MAX_LINKED_BINDING_SYNC_ATTEMPTS = 5;

export type LinkedBindingSyncJobKind = "verify";

export interface LinkedBindingSyncJob {
  binding: ServiceBinding;
  measurement: MeasureResult;
  kind: LinkedBindingSyncJobKind;
  enqueuedAt: number;
  lastAttemptAt?: number;
  attempts: number;
  lastError?: string;
}

export async function loadLinkedBindingSyncJobs(): Promise<LinkedBindingSyncJob[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as LinkedBindingSyncJob[];
  } catch {
    return [];
  }
}

export async function hasPendingLinkedBindingSyncJobs(): Promise<boolean> {
  const jobs = await loadLinkedBindingSyncJobs();
  return jobs.length > 0;
}

export async function clearLinkedBindingSyncQueue(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

export async function upsertLinkedBindingSyncJob(params: {
  binding: ServiceBinding;
  measurement: MeasureResult;
}): Promise<LinkedBindingSyncJob | null> {
  const kind = inferJobKind(params.binding, params.measurement);
  if (!kind) {
    await removeLinkedBindingSyncJob(params.binding.bindingId);
    return null;
  }

  const jobs = await loadLinkedBindingSyncJobs();
  const existing = jobs.find((job) => job.binding.bindingId === params.binding.bindingId);
  if (existing && existing.measurement.capturedAt > params.measurement.capturedAt) {
    return existing;
  }

  const nextJob: LinkedBindingSyncJob = {
    binding: { ...params.binding },
    measurement: {
      ...params.measurement,
      state: params.measurement.state ? { ...params.measurement.state } : null,
      signals: [...params.measurement.signals],
    },
    kind,
    enqueuedAt: existing?.enqueuedAt ?? Math.floor(Date.now() / 1000),
    lastAttemptAt: existing?.lastAttemptAt,
    attempts: existing?.attempts ?? 0,
    lastError: existing?.lastError,
  };

  const filtered = jobs.filter((job) => job.binding.bindingId !== params.binding.bindingId);
  filtered.push(nextJob);
  await saveLinkedBindingSyncJobs(filtered);
  return nextJob;
}

export async function removeLinkedBindingSyncJob(bindingId: string): Promise<void> {
  const jobs = await loadLinkedBindingSyncJobs();
  const filtered = jobs.filter((job) => job.binding.bindingId !== bindingId);
  await saveLinkedBindingSyncJobs(filtered);
}

export async function recordLinkedBindingSyncFailure(bindingId: string, message: string): Promise<boolean> {
  const jobs = await loadLinkedBindingSyncJobs();
  const now = Math.floor(Date.now() / 1000);
  let exhausted = false;
  const next = jobs.flatMap((job) => {
    if (job.binding.bindingId !== bindingId) return [job];

    const failedJob = {
      ...job,
      lastAttemptAt: now,
      attempts: job.attempts + 1,
      lastError: message,
    };

    exhausted = failedJob.attempts >= MAX_LINKED_BINDING_SYNC_ATTEMPTS;
    return exhausted ? [] : [failedJob];
  });
  await saveLinkedBindingSyncJobs(next);
  return exhausted;
}

export function hasRemainingLinkedBindingSyncAttempts(job: LinkedBindingSyncJob): boolean {
  return job.attempts < MAX_LINKED_BINDING_SYNC_ATTEMPTS;
}

async function saveLinkedBindingSyncJobs(jobs: LinkedBindingSyncJob[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
}

function inferJobKind(
  binding: ServiceBinding,
  measurement: MeasureResult
): LinkedBindingSyncJobKind | null {
  if (!binding.sync) return null;
  if (!measurement.pass) return null;
  return binding.sync.nonceUrl && binding.sync.verifyUrl ? "verify" : null;
}
