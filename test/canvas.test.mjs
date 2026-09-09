import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLinkHeader, normalizeItem, normalizeCourse, mockCanvas } from '../lib/canvas.mjs';
import { readEnvFile } from '../lib/env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('parses Canvas Link header pagination', () => {
  const h = '<https://x.edu/api/v1/courses?page=2&per_page=100>; rel="next",<https://x.edu/api/v1/courses?page=1&per_page=100>; rel="first"';
  const links = parseLinkHeader(h);
  assert.equal(links.next, 'https://x.edu/api/v1/courses?page=2&per_page=100');
  assert.equal(parseLinkHeader(null).next, undefined);
});

test('normalizes a planner item with a submission', () => {
  const item = normalizeItem(
    {
      plannable_type: 'assignment',
      plannable_id: 7,
      course_id: 3,
      context_name: 'CS 3300',
      plannable_date: '2026-09-10T04:59:00Z',
      plannable: { title: 'Design doc', points_possible: 50, due_at: '2026-09-10T04:59:00Z' },
      html_url: '/courses/3/assignments/7',
      submissions: { submitted: true, graded: false, late: true },
      planner_override: null,
    },
    'https://x.edu/api/v1'
  );
  assert.equal(item.id, 'assignment:7');
  assert.equal(item.url, 'https://x.edu/courses/3/assignments/7');
  assert.equal(item.submitted, true);
  assert.equal(item.late, true);
  assert.equal(item.complete, true);
});

test('planner override marks an item complete without a submission', () => {
  const item = normalizeItem(
    { plannable_type: 'calendar_event', plannable_id: 1, plannable_date: '2026-09-10T00:00:00Z', plannable: { title: 'Talk' }, submissions: false, planner_override: { marked_complete: true } },
    'https://x.edu/api/v1'
  );
  assert.equal(item.complete, true);
  assert.equal(item.submitted, false);
});

test('normalizes a course with a student enrollment score', () => {
  const c = normalizeCourse({ id: 1, name: 'Stats', course_code: 'MATH 2350', term: { name: 'Fall 2026' }, enrollments: [{ type: 'student', computed_current_score: 91.4, computed_current_grade: 'A-' }] });
  assert.equal(c.score, 91.4);
  assert.equal(c.grade, 'A-');
});

test('mock data is relative to today', () => {
  const m = mockCanvas();
  assert.ok(m.courses.length >= 4);
  const now = Date.now();
  assert.ok(m.items.every((i) => Math.abs(new Date(i.dueAt) - now) < 40 * 86400000));
});

test('reads a dotenv file, ignoring comments and quotes', () => {
  const f = path.join(os.tmpdir(), `season-env-${process.pid}.env`);
  fs.writeFileSync(f, '# comment\nCANVAS_API_TOKEN="abc123"\nCANVAS_API_URL=https://x.edu/api/v1\n\nBAD LINE\n');
  const env = readEnvFile(f);
  fs.unlinkSync(f);
  assert.equal(env.CANVAS_API_TOKEN, 'abc123');
  assert.equal(env.CANVAS_API_URL, 'https://x.edu/api/v1');
});

test('current-term detection tolerates campus prefixes and falls back to term dates', async () => {
  const { isCurrentTerm } = await import('../lib/canvas.mjs');
  const now = new Date('2026-09-08T12:00:00Z');
  assert.equal(isCurrentTerm({ name: 'OSHFall 2026' }, 'Fall 2026', now), true);
  assert.equal(isCurrentTerm({ name: 'OSHFall 2024' }, 'Fall 2026', now), false);
  assert.equal(isCurrentTerm({ name: 'Default Term' }, 'Fall 2026', now), false);
  assert.equal(isCurrentTerm({ name: 'Term 7', start_at: '2026-08-20T00:00:00Z', end_at: '2026-12-20T00:00:00Z' }, 'Fall 2026', now), true);
  assert.equal(isCurrentTerm(null, 'Fall 2026', now), false);
});
