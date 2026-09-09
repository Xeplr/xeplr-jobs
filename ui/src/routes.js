// The paths this package's pages live at, in ONE place.
//
// A host mounts these inside its own <Routes>, so the path here is relative to
// wherever the host put them — see registerJobsUI's `basePath`. Kept as
// functions rather than string constants for the same reason the rest of the
// suite does: a path that takes an id later does not become a different kind
// of thing to call.
export const ROUTES = {
  jobs: (base) => (base || '') + '/jobs'
};

// Where the standalone app puts them. A host overrides this — xeplr-bi mounts
// at /workspace/jobs, because in that product a job belongs to a workspace.
export const DEFAULT_BASE = '';
