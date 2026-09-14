# Ground Truth Builder V1 (V2.4.9)

Local Node.js 22+ tools. No Wrangler, network access, production writes or model changes.
Run from the application root:

```text
npm run gt:build -- dataset/exports/<raw_id>
npm run gt:validate -- dataset/ground_truth/exports/<gt_id> --source dataset/exports/<raw_id>
npm run gt:stats -- dataset/ground_truth/exports/<gt_id>
```

Build reads only Raw manifest.json, schema.json, raw/events.csv and
raw/sunset_observations.csv. Invalid data fails; observations are never silently
excluded. Ground Truth Schema V1 and Policy V1 are frozen separately from Raw.

PACKAGE_INTERNAL validation proves package self-consistency. SOURCE_LINKED also
checks all source events and observation contributions against the exact Raw
manifest and CSV hashes. Build requires SOURCE_LINKED before atomic publication.

Output defaults to dataset/ground_truth; --output chooses another output root.
Identical exact source packages deduplicate. Existing corrupted packages are
never overwritten. A 10-second lock wait does not delete abandoned locks.
Interrupted/failed staging is retained; successful duplicate staging is removed.

Validate/stats are read-only. --report-dir must be outside the packages and
existing report files are never overwritten. Copy entire GT folders retaining
their ID names. Provide the moved Raw path via --source for linked validation.

Use text import for CSV in spreadsheets and do not resave into the package.
Confidence is a policy consistency score, not calibrated label correctness.
No prediction metrics, train/test split, model fitting or Replay adaptation is
included. See the Chinese operation guide under ref_docs/PRD in the workspace.

New builds use GT Schema V2: contributions begin with event_id, event_date_local,
city, observation_id. Display fields come from the Event and do not affect Policy V1.
V1 packages remain readable and verifiable. Rebuild from the same Raw package to
produce a new gt_v2 package; existing exports are never rewritten.
