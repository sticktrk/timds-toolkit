<!-- timds:emdash-site -->
## Website (`site/`)

This system's own website is the EmDash site in `site/`. It has no pin: it
serves the pages of the website design `src/designs/__DESIGN_ID__/` and reads
the system's tokens and stylesheets from their source files, so a change to
the system is a change to the site at its next build. Read `site/AGENTS.md`
before changing the site.

| Change | Where |
| --- | --- |
| A page's content, layout, header, or footer | The design, `src/designs/__DESIGN_ID__/` |
| Colors, fonts, spacing, component styles | The system's tokens and `src/styles/` |
| A style the site needs that the system lacks | Added to the system in the same change; never an existing token or rule changed |
| Articles, topics, media | EmDash (its admin, REST API, or MCP server), never a commit |
| Article routes, site configuration, dependencies | `site/`, a developer change |

Run from the repository root, this checks the site both ways: it rewrites a
literal that equals one system token and lists every style the system lacks.

```bash
__CHECK_COMMAND__
```

A designer's change to the site follows the `timds-consume-design-system`
skill (`__SKILLS_PATH__timds-consume-design-system/`); porting an article
route the system does not style yet, or bringing the site's templates
forward, follows `timds-update-design-system`. The site is its own npm
package: run npm in `site/`, and never add its packages to the root
`package.json`. The workspace scaffold wrote this section and records it in
`site/.timds/emdash.json`.
<!-- /timds:emdash-site -->
