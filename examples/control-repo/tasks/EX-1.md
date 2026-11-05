---
id: EX-1
title: Fix flaky upload retry
repo: example-app
state: todo
priority: 2
blocked_by: []
labels: [backend]
agent_session: null
attempts: 0
last_event_at: null
---

## Task

The upload retry occasionally gives up after the first failure instead of
retrying three times. Find the off-by-one and fix it.

## Acceptance criteria

- [ ] A failing upload is retried up to 3 times before surfacing an error.
- [ ] A regression test reproduces the original bug and now passes.
