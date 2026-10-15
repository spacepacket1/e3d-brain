// The built-in cognition jobs. Later phases add `gaps` here.

import type { CognitionJob } from '../run.js';
import { CONSOLIDATE_JOB } from './consolidate.js';
import { FORGET_JOB } from './forget.js';
import { REFLECT_JOB } from './reflect.js';
import { SELFTEST_JOB } from './selftest.js';
import { SUPERSEDE_JOB } from './supersede.js';

export const JOBS: readonly CognitionJob[] = [SELFTEST_JOB, SUPERSEDE_JOB, CONSOLIDATE_JOB, REFLECT_JOB, FORGET_JOB];

export function findJob(name: string): CognitionJob | undefined {
  return JOBS.find((j) => j.name === name);
}
