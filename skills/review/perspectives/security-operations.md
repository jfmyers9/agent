# Security And Operations

Apply only when trust boundaries, secrets, persistence, concurrency,
deployment, resource use, or production dependencies changed.

- Check authorization, validation, injection, traversal, disclosure, and unsafe
  deserialization at boundaries.
- Check races, atomicity, idempotency, retries, timeouts, and partial failure.
- Check rollout and rollback compatibility, observability, resource bounds,
  dependency failure, and incident diagnosability.
- Distinguish realistic introduced risk from generic hardening advice.

For each candidate, return the exploit or failure path, blast radius, evidence,
and mitigation.
