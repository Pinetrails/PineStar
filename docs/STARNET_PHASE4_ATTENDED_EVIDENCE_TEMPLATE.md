# StarNet Phase 4 Attended Evidence Template

Copy this shape into `.dogfood/phase4-attended-evidence.json` after the live UI
cutover trial has been run. The Phase 4 runner treats this file as the human
evidence packet for gates that cannot be proven headlessly.

```json
{
  "generatedAt": "2026-06-26T00:00:00.000Z",
  "operator": "andro",
  "sameWorkTrial": {
    "passed": false,
    "screenshots": [],
    "runIds": [],
    "transcriptIds": [],
    "artifactPaths": [],
    "ledgerRows": [],
    "notes": ""
  },
  "soak": {
    "freshPass": false,
    "restartPass": false,
    "transcriptPreserved": false,
    "ledgerPreserved": false,
    "artifactsPreserved": false,
    "memoryPreserved": false,
    "stationStatePreserved": false,
    "notes": ""
  },
  "failureRecovery": {
    "cancelPassed": false,
    "budgetPassed": false,
    "deniedConsentPassed": false,
    "toolErrorPassed": false,
    "checkpointRestorePassed": false,
    "notes": ""
  }
}
```

Final go/no-go is recorded separately in `.dogfood/phase4-decision.json`:

```json
{
  "decision": "ready-to-replace",
  "acceptedBy": "andro",
  "acceptedAt": "2026-06-26T00:00:00.000Z",
  "notes": "StarNet is approved as the main harness.",
  "acceptedPilotGaps": []
}
```

Allowed `decision` values:

- `ready-to-replace`
- `limited-pilot`
- `blocked`
- `not-ready`
