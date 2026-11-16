# Contributing to Lexi

Thank you for helping improve Lexi. Please discuss significant changes in an issue before implementing them.

## License and sign-off

Lexi is free software under the [GNU General Public License v3.0 or later](LICENSE). Your
contribution is licensed under the same terms: by submitting it, you agree that it may be
distributed under GPL-3.0-or-later. You keep the copyright in your own work; there is no
contributor license agreement.

Every commit must carry a `Signed-off-by` line, which certifies the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): that you wrote the
change or otherwise have the right to submit it under the project's license. Git adds the line
for you:

```bash
git commit -s -m "Fix plural handling for Polish"
```

Use your real name or a name you are known by in the community. If you forgot, amend with
`git commit --amend -s` (or `git rebase --signoff main` for several commits) and force-push
the branch. If your employer has rights in what you write, make sure you are allowed to
contribute it under the GPL.

## Development and review

Node 24.21.0 (pinned in `.nvmrc`; `>= 22.22.3` works).

```bash
npm ci
npm run dev          # Fastify on :4317 + ng serve on :4200
npm test             # every workspace
npm run typecheck
npm run lint
npm run build        # web, server and license files into apps/server/public
npm start            # lexi [path] [--port 4317] [--no-open]
```

New source files start with the project's copyright and SPDX lines:

```ts
// Copyright (c) 2026 Patrick Glück
// SPDX-License-Identifier: GPL-3.0-or-later
```

- Make focused changes and explain the user-facing reason.
- Use synthetic XLIFF examples; never include customer texts or credentials.
- Preserve IDs, inline tags, placeholders and relevant metadata; add meaningful regression coverage for behavior changes.
- Identify third-party code, licenses and any AI-assisted material with relevant provenance or restrictions. Review all generated output yourself.
- Include relevant author/coauthor attribution (`Co-authored-by:`); every author signs off their own commits.
- Run the documented checks and describe what you tested.
- Update documentation and known limitations when behavior changes.

The maintainer checks sign-offs, provenance and technical quality before merge. A sign-off does not guarantee that a patch is accepted.

Please communicate respectfully. Do not use issues to disclose vulnerabilities; follow SECURITY.md instead.
