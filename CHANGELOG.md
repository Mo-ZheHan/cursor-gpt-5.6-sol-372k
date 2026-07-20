# Changelog

## 0.0.1 - 2026-07-20

- Create a separately signed `Cursor 372K.app` without modifying the official
  application.
- Make GPT-5.6 Sol's native `272K` selection behave as `372K` through Cursor's
  long-context route and `372K` checkpoint accounting.
- Invoke Cursor's native summarizer at 90% before submissions and background
  task resumes, preserving its requeue/Resume recovery path.
- Preserve explicit `1M` selections, other models, prompts, settings, measured
  usage, and unrelated request fields.
- Validate every patch point, checksum, and signature before replacing an
  existing copy.
