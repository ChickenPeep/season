import fs from 'node:fs';
import path from 'node:path';

/**
 * Canvas REST client + normalizer.
 * Produces one board-shaped payload:
 *   { courses, items, announcements, fetchedAt, source }
 * items are planner items (assignments, quizzes, discussions, events) in a window
 * around today, with submission state folded in.
 */

const PER_PAGE = 100;

export function parseLinkHeader(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

async function getAll(base, token, pathname, params = {}, { maxPages = 10, timeoutMs = 20000 } = {}) {
  const url = new URL(base + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
    else if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  url.searchParams.set('per_page', String(PER_PAGE));

  const results = [];
  let next = url.toString();
  let pages = 0;
  while (next && pages < maxPages) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(next, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) throw new CanvasError('Canvas rejected the token (401). Generate a new one under Account → Settings → Approved Integrations.', 401);
    if (!res.ok) throw new CanvasError(`Canvas returned ${res.status} for ${pathname}`, res.status);
    const body = await res.json();
    if (Array.isArray(body)) results.push(...body);
    else results.push(body);
    next = parseLinkHeader(res.headers.get('link')).next;
    pages += 1;
  }
  return results;
}

export class CanvasError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * A course is "current" when its term name contains the configured semester name
 * (Canvas terms are often prefixed, e.g. "OSHFall 2026"), or when the term's own
 * date range contains today. Untermed utility courses ("Default Term") are not current.
 */
export function isCurrentTerm(term, semesterName, now = new Date()) {
  if (!term) return false;
  if (semesterName && squash(term.name).includes(squash(semesterName))) return true;
  if (term.start_at && term.end_at) return new Date(term.start_at) <= now && now <= new Date(term.end_at);
  return false;
}

export function normalizeCourse(c, semesterName) {
  const enrollment = (c.enrollments || []).find((e) => e.type === 'student') || (c.enrollments || [])[0] || {};
  return {
    id: c.id,
    name: c.name || c.course_code || `Course ${c.id}`,
    code: c.course_code || '',
    term: c.term?.name || '',
    current: isCurrentTerm(c.term, semesterName),
    score: enrollment.computed_current_score ?? null,
    grade: enrollment.computed_current_grade ?? null,
    url: c.html_url || null,
  };
}

export function normalizeItem(p, baseUrl) {
  const pl = p.plannable || {};
  const sub = p.submissions && typeof p.submissions === 'object' ? p.submissions : null;
  const due = pl.due_at || p.plannable_date || null;
  return {
    id: `${p.plannable_type}:${p.plannable_id}`,
    type: p.plannable_type,
    title: pl.title || pl.name || '(untitled)',
    courseId: p.course_id ?? null,
    contextName: p.context_name || '',
    dueAt: due,
    points: pl.points_possible ?? null,
    url: p.html_url ? (p.html_url.startsWith('http') ? p.html_url : baseUrl.replace(/\/api\/v1$/, '') + p.html_url) : null,
    submitted: !!(sub && (sub.submitted || sub.graded)),
    graded: !!(sub && sub.graded),
    late: !!(sub && sub.late),
    missing: !!(sub && sub.missing),
    excused: !!(sub && sub.excused),
    complete: !!(p.planner_override && p.planner_override.marked_complete) || !!(sub && (sub.submitted || sub.graded)),
  };
}

export async function fetchCanvas({ url, token }, { lookBackDays = 7, lookAheadDays = 28, semesterName = '' } = {}) {
  const now = new Date();
  const start = new Date(now.getTime() - lookBackDays * 86400000);
  const end = new Date(now.getTime() + lookAheadDays * 86400000);

  const rawCourses = await getAll(url, token, '/courses', {
    enrollment_state: 'active',
    'include[]': ['total_scores', 'term'],
  });
  const courses = rawCourses.filter((c) => !c.access_restricted_by_date).map((c) => normalizeCourse(c, semesterName));
  const courseIds = new Set(courses.map((c) => c.id));

  const [rawItems, rawAnnouncements] = await Promise.all([
    getAll(url, token, '/planner/items', {
      start_date: start.toISOString(),
      end_date: end.toISOString(),
    }),
    courses.length
      ? getAll(url, token, '/announcements', {
          'context_codes[]': courses.map((c) => `course_${c.id}`),
          start_date: isoDate(new Date(now.getTime() - 21 * 86400000)),
          end_date: isoDate(new Date(now.getTime() + 1 * 86400000)),
        })
      : Promise.resolve([]),
  ]);

  const items = rawItems
    .filter((p) => p.plannable_type !== 'announcement')
    .map((p) => normalizeItem(p, url))
    .filter((i) => i.dueAt && (i.courseId === null || courseIds.has(i.courseId)));

  const announcements = rawAnnouncements.map((a) => ({
    id: a.id,
    title: a.title,
    courseId: Number(String(a.context_code || '').replace('course_', '')) || null,
    postedAt: a.posted_at,
    url: a.html_url,
    excerpt: stripHtml(a.message).slice(0, 280),
  }));
  announcements.sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt));

  return { courses, items, announcements, fetchedAt: now.toISOString(), source: 'canvas' };
}

/* ------------------------------------------------------------------ */
/* Cache                                                               */
/* ------------------------------------------------------------------ */

export class CanvasCache {
  constructor(dir) {
    this.file = path.join(dir, 'canvas-cache.json');
    fs.mkdirSync(dir, { recursive: true });
  }
  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }
  write(payload) {
    fs.writeFileSync(this.file, JSON.stringify(payload));
  }
}

/* ------------------------------------------------------------------ */
/* Mock data (relative to today, so the demo always looks alive)       */
/* ------------------------------------------------------------------ */

export function mockCanvas() {
  const now = new Date();
  const day = (n, h = 23, m = 59) => {
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const courses = [
    { id: 101, name: 'Applied Statistics', code: 'MATH 2350', term: 'Fall 2026', current: true, score: 91.4, grade: 'A-', url: 'https://canvas.example.edu/courses/101' },
    { id: 102, name: 'Software Engineering', code: 'CS 3300', term: 'Fall 2026', current: true, score: 88.0, grade: 'B+', url: 'https://canvas.example.edu/courses/102' },
    { id: 103, name: 'Exercise Physiology', code: 'KINE 3310', term: 'Fall 2026', current: true, score: 94.2, grade: 'A', url: 'https://canvas.example.edu/courses/103' },
    { id: 104, name: 'Technical Writing', code: 'ENGL 2210', term: 'Fall 2026', current: true, score: 79.5, grade: 'C+', url: 'https://canvas.example.edu/courses/104' },
    { id: 105, name: 'Entrepreneurship', code: 'BUSI 3340', term: 'Fall 2026', current: true, score: null, grade: null, url: 'https://canvas.example.edu/courses/105' },
  ];
  const mk = (id, type, title, courseId, dueAt, points, extra = {}) => ({
    id: `${type}:${id}`,
    type,
    title,
    courseId,
    contextName: courses.find((c) => c.id === courseId)?.code || '',
    dueAt,
    points,
    url: `https://canvas.example.edu/courses/${courseId}/assignments/${id}`,
    submitted: false,
    graded: false,
    late: false,
    missing: false,
    excused: false,
    complete: false,
    ...extra,
  });
  const items = [
    mk(1, 'assignment', 'Homework 2: Confidence intervals', 101, day(-5), 20, { submitted: true, graded: true, complete: true }),
    mk(2, 'assignment', 'Lab 3: Hypothesis testing', 101, day(-1), 15, { missing: true }),
    mk(3, 'quiz', 'Quiz 3: Sampling distributions', 101, day(2, 11, 0), 10),
    mk(4, 'assignment', 'Homework 3: Regression', 101, day(9), 20),
    mk(5, 'assignment', 'Sprint 1 retrospective', 102, day(0, 17, 0), 10),
    mk(6, 'assignment', 'Design doc: architecture + data model', 102, day(4), 50),
    mk(7, 'discussion_topic', 'Discuss: code review culture', 102, day(6), 5),
    mk(8, 'assignment', 'Sprint 2 demo', 102, day(16), 50),
    mk(9, 'quiz', 'Quiz: energy systems', 103, day(1, 9, 0), 15),
    mk(10, 'assignment', 'Lab report: VO2 max protocol', 103, day(5), 40),
    mk(11, 'assignment', 'Case study: periodization for football', 103, day(13), 60),
    mk(12, 'assignment', 'Instruction set draft', 104, day(-3), 30, { submitted: true, complete: true }),
    mk(13, 'assignment', 'Peer review: instruction sets', 104, day(3), 10),
    mk(14, 'assignment', 'Proposal memo', 104, day(11), 50),
    mk(15, 'assignment', 'Customer discovery interviews (5)', 105, day(7), 25),
    mk(16, 'assignment', 'Lean canvas v1', 105, day(20), 30),
    mk(17, 'calendar_event', 'Guest speaker: founder Q&A', 105, day(8, 13, 0), null),
    mk(18, 'assignment', 'Midterm project checkpoint', 102, day(25), 100),
  ];
  const announcements = [
    { id: 1, title: 'Quiz 3 moved to Thursday', courseId: 101, postedAt: day(-1, 8, 12), url: '#', excerpt: 'Because of the campus power outage we are moving Quiz 3 to Thursday at 11:00. Same material, same format.' },
    { id: 2, title: 'Sprint 1 demos: order posted', courseId: 102, postedAt: day(-2, 15, 30), url: '#', excerpt: 'Demo order for Friday is in Modules. Each team has 8 minutes plus 2 for questions. Have your deployed link ready.' },
    { id: 3, title: 'Lab safety reminder', courseId: 103, postedAt: day(-3, 10, 0), url: '#', excerpt: 'Closed-toe shoes are required in the physiology lab. Bring a water bottle for the VO2 max sessions.' },
    { id: 4, title: 'Office hours this week', courseId: 104, postedAt: day(-4, 9, 45), url: '#', excerpt: 'Office hours move to Wednesday 2-4 this week only. Bring your instruction set drafts.' },
  ];
  return { courses, items, announcements, fetchedAt: now.toISOString(), source: 'mock' };
}
