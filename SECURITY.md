# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately with GitHub private vulnerability reporting:

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem, the affected version or commit, and the steps to
   reproduce it.

Responses are best-effort. This is experimental reference code with no
supported release line.

## Deployment note

Hercules runs coding agents and exposes a control API. Do not expose it on
the open internet. Keep `HERCULES_TOKEN` set, and put the server behind a
private network or an authenticated tunnel (see `SPEC.md` §10).
