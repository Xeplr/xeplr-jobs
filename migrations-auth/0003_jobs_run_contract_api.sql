-- 0003_jobs_run_contract_api.sql
-- GET /jobs/run-contract — what every run of a job receives (its window: a
-- start and an end), so a job's form can offer them in dropdowns instead of
-- asking anybody to type a binding. Read-only, so jobs:view, granted to every
-- role that already holds a jobs:view api — the same rule 0002 follows.
-- Idempotent.

INSERT INTO "apis" (id, name, "apiGroup", "isActive", "mtId1", "recordCreatedDate", "recordModifiedDate")
SELECT encode(gen_random_bytes(12), 'hex'), name, "group", true, '*', now(), now()
FROM (VALUES
  ('Get job run contract', 'jobs:view')
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
WHERE a.name = 'Get job run contract' AND a."apiGroup" = 'jobs:view'
  AND NOT EXISTS (
    SELECT 1 FROM "apisRolesMapping" x WHERE x."roleId" = r.id AND x."apiId" = a.id
  );
