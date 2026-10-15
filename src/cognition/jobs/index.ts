// The built-in cognition jobs. Later phases add `forget` and `gaps` here.

import type { CognitionJob } from '../run.js';
import { CONSOLIDATE_JOB } from './consolidate.js';
import { REFLECT_JOB } from './reflect.js';
import { SELFTEST_JOB } from './selftest.js';
import { SUPERSEDE_JOB } from './supersede.js';

export const JOBS: readonly CognitionJob[] = [SELFTEST_JOB, SUPERSEDE_JOB, CONSOLIDATE_JOB, REFLECT_JOB];

export function findJob(name: string): CognitionJob | undefined {
  return JOBS.find((j) => j.name === name);
}
