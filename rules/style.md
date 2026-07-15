---
paths:
  - "**/*.{ts,js,py,go,rs,sh,lua}"
---

# Coding Preferences

- Prefer simple, readable code over clever abstractions
- Avoid over-engineering - only build what's needed now
- Use meaningful variable and function names
- Keep functions small and focused on one thing
- Write code that's easy to delete, not easy to extend
- Delete superseded code when compatibility, rollout, or migration constraints
  do not require it
- No semantic prefix/suffix (OptimizedX, FastY, ClientImpl)
- No versioned names (processV2, handleNew, ClientOld)
- Add migration or compatibility code only when required by the requested
  behavior, existing project policy, or supported consumers
