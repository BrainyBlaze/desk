# Task 1 Review: Security and Storage Foundations

## Initial review

Status: **changes required**.

Findings from independent review:

1. The new helpers were only covered by a standalone target; the production
   build and runtime still used raw storage paths.
2. `*at()` helpers accepted `..` and nested traversal, so a trusted dirfd did
   not bound the resolved path.
3. Stale-lock repair closed the inspected fd before unlinking by name, leaving
   a replacement race.
4. Lock PID parsing accepted values outside the valid `pid_t` range and could
   unlink malformed locks after truncation.
5. `atch_storage_open_file` did not fail closed when `fstat` failed.

Required corrective evidence: focused tests for each item, production build
integration, and a clean full atch regression after the fixes.

## Corrective review

The owner committed `80a11bf` with traversal rejection, malformed-PID
rejection, descriptor cleanup on metadata failure, and inode-checked locked
stale repair. The production build now links the security/storage objects and
the session-directory expansion validates the trusted root. A follow-up local
hardening change also validates directory ownership/mode on open.

Verification: `make -f makefile security-storage-test`, `make -f makefile atch`,
and `git diff --check` pass. The existing full CLI regression remains the
required final gate after integration.
