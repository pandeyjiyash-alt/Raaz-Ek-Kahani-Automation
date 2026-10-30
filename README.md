# Raaz Ek Kahani — AI Video Automation Pipeline

**Author:** Yash Pandey  
**Portfolio:** https://yash-pandey-dev.netlify.app/

A developer portfolio project exploring AI-assisted short-form video production for the *Raaz Ek Kahani* storytelling channel. This repository contains the **Python content scripting pipeline** and a **TypeScript/Node.js production orchestration layer** from the supplied project.

## Architecture

```text
Story idea / prompt
        |
        v
Python scripting pipeline (story / production planning)
        |
        v
Production orchestration (Node.js + TypeScript)
        |
        +--> narration / voice processing
        +--> scene generation / browser automation
        +--> video editing, music and titles
        +--> review / quality checks
        +--> scheduling / publishing integrations
```

## Technology

- **Python:** content scripting, story preparation, schema validation
- **TypeScript / Node.js:** production workflow, automation and orchestration
- **Playwright:** browser-based automation
- **Integrations:** configured external AI and publishing services; availability depends on credentials and provider accounts

## Project structure

| Path | Purpose |
| --- | --- |
| `scripting/pipeline/` | Python story and planning modules |
| `scripting/prompts/` | Content prompt templates |
| `scripting/schema/` | Structured-output schemas |
| `production/src/` | Production and automation implementation |
| `production/src/pipeline/` | Workflow state, scheduling and release logic |
| `production/scripts/` | Supporting scripts |

## Local setup

**Python (3.10+ recommended)**

```bash
cd scripting
python -m venv .venv
# Activate your virtual environment, then:
pip install -r requirements.txt
```

**Node.js (20+ recommended)**

```bash
cd production
npm ci
npm run typecheck
npm test
```

Copy `scripting/.env.example` to `scripting/.env` and supply only your own credentials. Additional external services may require setup and a local browser profile. Review the code and configure provider accounts before attempting end-to-end production.

## Security and publication

This public-source snapshot intentionally excludes local browser profiles, `.git` history, virtual environments, downloaded dependencies, production logs, private media, generated outputs, and runtime credentials. Never commit actual `.env` files, tokens, cookies, session data, or third-party assets without permission.

**Note:** This snapshot has not been validated end-to-end against external services. Features are described as code components, not as a claim of successful unattended deployment.

## Author

**Yash Pandey** — Software Developer | Python, AI Automation & Backend Engineering  
Portfolio: https://yash-pandey-dev.netlify.app/
