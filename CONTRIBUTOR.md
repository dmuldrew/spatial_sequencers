# Contributor Guide

Thanks for contributing to Spatial Sequencers (PyroSync). We welcome improvements to the data pipeline, UI, docs, deployment flow, and accessibility.

## Project overview

This project is a browser-based NASA fire-weather observatory that presents wildfire and meteorology data as a spatial, audio-visual timeline. The main runtime is a small Node.js server, while the front end is built in static HTML/CSS/JavaScript and the research data is refreshed with Python scripts.

## Prerequisites

- Node.js 20 or newer
- Python 3
- Git
- Optional: Docker Desktop or Docker Engine for containerized runs

## Local setup

```bash
git clone https://github.com/dmuldrew/spatial_sequencers.git
cd spatial_sequencers
npm install
npm start
```

Then open http://localhost:3000.

To refresh the bundled NASA data:

```bash
python3 scripts/fetch_nasa_data.py
```

To run with Docker:

```bash
docker compose up -d --build
```

## Branching workflow

Work from a feature branch off `main` (or the active development branch in your fork):

```bash
git checkout -b my-feature
```

Before opening a PR:

- Rebase or merge the latest target branch as needed.
- Ensure the app still boots locally.
- Verify the relevant UI or script behavior still works.
- Keep changes focused to a single concern.

## Contribution expectations

### Code changes

- Prefer small, reviewable patches.
- Keep JavaScript and Python code readable and explicit.
- Avoid introducing unrelated dependencies unless necessary.
- Respect the existing file organization and naming conventions.

### Documentation

- Update README or inline comments when behavior changes.
- Document any new environment variables, commands, or deployment steps.

### Data pipeline

If you change dataset generation or visualization assumptions:

- Re-run `python3 scripts/fetch_nasa_data.py` when applicable.
- Verify the generated JSON still matches the expected schema.
- Check that the front end still renders correctly with the updated data.

### Frontend / UX

- Preserve accessibility patterns already used in the app.
- Prefer semantic HTML and keyboard-friendly controls.
- Keep the atmospheric experience readable and responsive across screen sizes.

## Pull request checklist

Before submitting a PR, confirm:

- [ ] The change works locally.
- [ ] The README or relevant docs were updated if needed.
- [ ] Data and deployment flows were checked if the change affects them.
- [ ] The diff is scoped and easy to review.
- [ ] The branch is up to date with the target branch.

## Coding standards

- Use clear, descriptive variable names.
- Favor explicit logic over clever abstractions.
- Keep comments helpful and limited to non-obvious behavior.
- Match the existing formatting style in the surrounding files.

## Questions or ideas

If you are unsure whether an idea fits the project, open a discussion or draft a PR and ask for feedback early. We are happy to help shape ideas before they become large changes.

Thank you for helping improve Spatial Sequencers.
