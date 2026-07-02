---
title: "Docs hosting"
description: "Deploy Desk documentation with Mintlify and host it on docs.desc.cloud"
---

Desk documentation is stored in this repository under `docs/`. Mintlify uses
`docs/docs.json` as the site configuration and deploys from the connected Git
repository when documentation changes are pushed.

## Automated validation

The `Docs` GitHub Actions workflow runs on pull requests and pushes that touch
documentation files. It validates the Mintlify site and keeps the existing
MkDocs build working while both systems are present:

```bash
cd docs
npm exec -y --package=mint@4.2.660 -- mint validate
npm exec -y --package=mint@4.2.660 -- mint broken-links
npm exec -y --package=mint@4.2.660 -- mint a11y
cd ..
python -m mkdocs build --strict
```

## Mintlify dashboard setup

These steps require access to the Mintlify dashboard and the BrainyBlaze GitHub
organization.

1. Create or open the Desk project in Mintlify.
2. Install the Mintlify GitHub App for `BrainyBlaze/desk`.
3. In Git settings, connect the repository to the production branch.
4. Enable the monorepo setting and set the docs directory to `/docs`.
5. Enable pull request previews if the plan supports them.
6. Confirm a push that changes `docs/**` creates a Mintlify deployment.

Mintlify's GitHub App handles hosted rebuilds. The GitHub Actions workflow only
validates the docs before changes merge.

## Custom domain setup

Use the Mintlify custom-domain page for `docs.desc.cloud`.

1. Add `docs.desc.cloud` as the custom domain in Mintlify.
2. Add both TXT verification records shown in the Mintlify dashboard.
3. Wait until Mintlify marks the TXT records verified.
4. Add or update the DNS CNAME:

```text
CNAME | docs | cname.mintlify.builders
```

5. Wait for DNS and TLS provisioning to complete.
6. Confirm `https://docs.desc.cloud` loads the Mintlify site.

If the intended host is `docs.desk.cloud` instead of `docs.desc.cloud`, update
the custom domain in Mintlify and this page before publishing DNS records.
