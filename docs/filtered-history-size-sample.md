# Filtered Codex history size sample

Measured on 2026-10-28 from three selected local Codex rollout snapshots. The normalized value is the UTF-8 byte length of the current `ThreadRecordV1` JSON built from the same source snapshot. The filtered value is the generated JSONL byte length. Media is the sum of unique extracted objects that would be sent to the bucket; it is not included in the filtered JSONL value. This is a local size check, not a database storage or query benchmark. No session content was printed or saved in this report.

| Session (suffix) | Source bytes | Normalized JSON bytes | Filtered JSONL bytes | Bucket media bytes (objects) | Events | Missing or blocked media |
| ---------------- | -----------: | --------------------: | -------------------: | ---------------------------: | -----: | -----------------------: |
| `...5a989`       |    5,522,367 |               493,459 |            5,171,371 |                   57,617 (2) |    930 |                       10 |
| `...e1096f`      |    3,327,226 |               158,754 |            1,661,229 |                  623,214 (1) |    587 |                       14 |
| `...7656`        |   55,967,159 |               267,901 |            6,724,392 |              36,334,634 (42) |  1,405 |                       22 |

The first two source files match the frozen versions used in the earlier history benchmark. The third session continued to grow after that freeze, so these numbers describe its current snapshot and should not be compared with its earlier database row. The media count uses SHA-256 deduplication within each session. A missing marker includes unavailable, outside-scope, invalid, incomplete, or over-limit media; it is not a byte estimate. Four truncated JPEG previews in the first session became missing markers, while two complete images were extracted. File contents already pasted into text and personal data inside images are outside this filter's inspection scope.
