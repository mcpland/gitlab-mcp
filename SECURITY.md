# Security Policy

## Supported versions

Security fixes are applied to the latest published release and the default branch. Upgrade to the newest release before reporting an issue that is already fixed there.

## Reporting a vulnerability

Please use this repository's **Security → Report a vulnerability** workflow to submit a private GitHub Security Advisory. Do not include tokens, cookies, private GitLab URLs, project data, or exploit details in a public issue.

Include:

- the affected version and transport (`stdio`, Streamable HTTP, or legacy SSE);
- the relevant authentication and policy settings, with every credential redacted;
- minimal reproduction steps and the expected security boundary;
- impact and any known mitigations.

You should receive an acknowledgement within five business days. A fix and disclosure timeline will be coordinated in the private advisory.

## Operational baseline

- Keep GitLab and MCP credentials out of command arguments, logs, prompts, and issue attachments.
- Bind HTTP to loopback unless inbound authentication, Host/Origin allowlists, and TLS termination are configured.
- Use `GITLAB_ALLOWED_PROJECT_IDS`, read-only mode, capability restrictions, and compact toolsets to grant only the required access.
- Run `pnpm audit --prod` and the repository test suite before deploying an updated dependency set.
