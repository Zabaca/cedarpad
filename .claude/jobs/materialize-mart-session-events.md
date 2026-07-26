---
name: materialize-mart-session-events
description: Materialize mart_session_events from this workspace's Claude session JSONL and rewrite its parquet + freshness sidecar in R2.
schedule: daily
target: warehouse
---

Materialize `mart_session_events`.
