# Security And Operations

Apply only activated subsections. Record which trigger applies before review:

- **Trust and input:** authorization, validation, injection, traversal, secrets,
  disclosure, and unsafe deserialization.
- **State and concurrency:** persistence, races, atomicity, idempotency, retries,
  timeouts, and partial failure.
- **Delivery and resources:** rollout/rollback safety, observability, resource
  bounds, dependency failure, and incident diagnosability.
- Distinguish realistic introduced risk from generic hardening advice.

Do not inspect an inactive subsection merely because another trigger applies.

For each candidate, return the exploit or failure path, blast radius, evidence,
and mitigation.
