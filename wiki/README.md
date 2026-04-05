# Page Gen Wiki

AI-driven HTML page generation from a source URL. The pipeline uses Claude to produce a self-contained Tailwind CSS page that visually replicates the source across layout, copy, images, and theme.

## Quick links

- [Project overview](/project) — purpose, CLI flags, output structure
- [Pipeline overview](/pipeline) — all stages from crawl to final assembly
- [Configuration](/config) — models and quality budgets
- [Observability](/observability) — scoring, metrics, logging, reports

## Running the tool

```bash
npm run generate -- <url>                        # standard single-pass
npm run generate -- <url> --correction           # with correction loop
npm run generate -- <url> --quality quality      # max correction budget
npm run generate -- <url> --baseline --correction --name my-run
npm run report <output-dir>                      # build HTML report
npm run wiki                                     # serve this wiki
```

## Adding pages

Drop a `.md` file in `wiki/` and add a link to `_sidebar.md`. Docsify picks it up with no build step.
