# Performance Review Overlay
summary: Domain-specific performance checks activated when optimization/latency signals are detected.
type: review-overlay

## Required checks

| Area | What to verify |
|------|---------------|
| Hot path | Identify and define the critical execution path |
| Metrics | Baseline metric, target metric, workload definition |
| Complexity | Time-space complexity of changed algorithms |
| Queries | N+1 detection, query plan review, slow query identification |
| Caching | Caching opportunities, invalidation risks, cache coherence |
| Concurrency | Batching, async patterns, concurrency safety, memory pressure |
| Benchmarks | Reproducibility of benchmark setup and methodology |
| Guardrails | Regression detection for non-target metrics |

## Trigger signals

- Prompt keywords: performance, latency, slow, benchmark, query, cache, memory, cpu, throughput, p95, p99, optimize, bottleneck, profile
- Touched paths: hot path code, DB queries, caching layer, concurrency primitives
- Repeated runtime FAIL with performance symptoms
