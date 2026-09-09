-- GET /jobs/active — the endpoint a screen polls for what is running now.
--
-- jobs:view, not jobs:run. It reads occurrence rows and starts nothing, so it
-- belongs with "List job occurrences" rather than with "Trigger job". Anyone
-- who can see the run history can see that a run is in progress; that is the
-- same fact, a few seconds earlier.
--
-- No menus row: this is polled by a screen that is already registered, not
-- navigated to.
--
-- Idempotent on (name, apiGroup), the same shape as 0001, so re-running this
-- against a database that already has the row is a no-op.
INSERT INTO "apis" (id, name, "apiGroup", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", true, '*', now(), now()
FROM (VALUES
  ('List active job runs', 'jobs:view')
) AS v(name, "group")
WHERE NOT EXISTS (
  SELECT 1 FROM "apis" a WHERE a.name = v.name AND a."apiGroup" = v."group"
);

-- Grant it to every role that already holds jobs:view. Written as a join over
-- the existing grants rather than naming Admin/Creator/Viewer again, so a role
-- an app added of its own does not silently miss the new route.
INSERT INTO "apisRolesMapping" (id, "roleId", "apiId", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), r.id, a.id, true, '*', now(), now()
FROM "apis" a
CROSS JOIN LATERAL (
  SELECT DISTINCT m."roleId" AS id
  FROM "apisRolesMapping" m
  JOIN "apis" existing ON existing.id = m."apiId"
  WHERE existing."apiGroup" = 'jobs:view'
) r
WHERE a.name = 'List active job runs' AND a."apiGroup" = 'jobs:view'
  AND NOT EXISTS (
    SELECT 1 FROM "apisRolesMapping" x WHERE x."roleId" = r.id AND x."apiId" = a.id
  );
