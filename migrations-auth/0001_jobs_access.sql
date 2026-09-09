-- 0001_jobs_access.sql
-- xeplr-jobs' own access definitions — roles, menus, and APIs for what
-- lib/jobRouter.js actually exposes. jobs itself has no auth concept of its
-- own (see bin/server.js: it trusts whatever tenant headers front it) — this
-- file exists purely so a CONSUMING app's auth database (via its
-- AUTH_EXT_MIGRATIONS_DIR) can know jobs' pages/APIs exist at all, discover
-- them, and grant roles access. jobs never runs this itself.
--
-- Same idempotent, insert-if-absent shape as xeplr-workflow's own
-- migrations-auth/0001_workflow_access.sql — role/menu/api names are shared
-- vocabulary across every consuming app, so running this against a database
-- that already has a "CompanyAdmin" role (seeded by the host app, or by
-- another consuming app's own extension migration) extends that SAME role
-- rather than creating a parallel one.

INSERT INTO "roles" (id, name, "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, true, '*', now(), now()
FROM (VALUES ('Super Admin'), ('CompanyAdmin'), ('Creator'), ('Viewer')) AS v(name)
WHERE NOT EXISTS (SELECT 1 FROM "roles" r WHERE r.name = v.name);

INSERT INTO "menus" (id, name, "menuGroup", "isPublic", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", false, true, '*', now(), now()
FROM (VALUES
  ('Jobs', 'jobs:view'),
  ('Job Runs', 'jobs:view')
) AS v(name, "group")
WHERE NOT EXISTS (SELECT 1 FROM "menus" m WHERE m.name = v.name);

-- One row per route in lib/jobRouter.js.
INSERT INTO "apis" (id, name, "apiGroup", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", true, '*', now(), now()
FROM (VALUES
  ('List jobs', 'jobs:view'),
  ('Get job', 'jobs:view'),
  ('List job occurrences', 'jobs:view'),
  ('Get job occurrence', 'jobs:view'),
  ('List actions', 'jobs:view'),
  ('Save job', 'jobs:create'),
  ('Delete job', 'jobs:create'),
  ('Trigger job', 'jobs:run'),
  ('Batch trigger jobs', 'jobs:run'),
  ('Pause job', 'jobs:manage'),
  ('Resume job', 'jobs:manage')
) AS v(name, "group")
WHERE NOT EXISTS (SELECT 1 FROM "apis" a WHERE a."apiGroup" = v."group" AND a.name = v.name);

-- Super Admin → everything that now exists.
INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Super Admin'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

INSERT INTO "menuRolesMapping" (id, "menuId", "roleId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), m.id, r.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "menus" m
WHERE r.name = 'Super Admin'
  AND NOT EXISTS (SELECT 1 FROM "menuRolesMapping" x WHERE x."roleId" = r.id AND x."menuId" = m.id);

-- CompanyAdmin: jobs:* (prefix) — including jobs:manage (pause/resume a
-- schedule), which Creator deliberately does not get below.
INSERT INTO "menuRolesMapping" (id, "menuId", "roleId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), m.id, r.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "menus" m
WHERE r.name = 'CompanyAdmin'
  AND m."menuGroup" LIKE 'jobs:%'
  AND NOT EXISTS (SELECT 1 FROM "menuRolesMapping" x WHERE x."roleId" = r.id AND x."menuId" = m.id);

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'CompanyAdmin'
  AND a."apiGroup" LIKE 'jobs:%'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

-- Creator: can see, build and run — same "running has side effects, seeing
-- does not" split workflow's own matrix already makes. Deliberately no
-- jobs:manage — pausing/resuming a schedule is CompanyAdmin's call, not a
-- Creator's.
INSERT INTO "menuRolesMapping" (id, "menuId", "roleId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), m.id, r.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "menus" m
WHERE r.name = 'Creator'
  AND m."menuGroup" IN ('jobs:view', 'jobs:create', 'jobs:run')
  AND NOT EXISTS (SELECT 1 FROM "menuRolesMapping" x WHERE x."roleId" = r.id AND x."menuId" = m.id);

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Creator'
  AND a."apiGroup" IN ('jobs:view', 'jobs:create', 'jobs:run')
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);

-- Viewer: jobs:view (exact). Sees jobs and their run history; triggers and
-- schedules nothing.
INSERT INTO "menuRolesMapping" (id, "menuId", "roleId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), m.id, r.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "menus" m
WHERE r.name = 'Viewer'
  AND m."menuGroup" = 'jobs:view'
  AND NOT EXISTS (SELECT 1 FROM "menuRolesMapping" x WHERE x."roleId" = r.id AND x."menuId" = m.id);

INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "roles" r CROSS JOIN "apis" a
WHERE r.name = 'Viewer'
  AND a."apiGroup" = 'jobs:view'
  AND NOT EXISTS (SELECT 1 FROM "apisRolesMapping" m WHERE m."roleId" = r.id AND m."apiId" = a.id);
