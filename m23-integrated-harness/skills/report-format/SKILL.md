---
name: report-format
description: Loads the canonical integrated-harness evidence report format.
---

# report-format

When asked to write the integrated-harness evidence report, emit exactly this 4-line format:

```
TITLE=Integrated Harness Evidence
FACT_ONE=Append-only events support cold projection.
FACT_TWO=Tool policy runs before execution.
STATUS=VERIFIED
```

Do not add headings, commentary, or extra lines. Write it to `report.txt`, then read it back to confirm.
