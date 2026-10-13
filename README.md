# decision-model-frontend

A small web UI for typed **decision models** like [Clef](https://blog.cloudflare.com/clef-decision-models/) / Clef-flash (Cloudflare).
You give it a *state* (text or JSON) and a set of *typed questions*; it returns a
decision for each question together with per-option probabilities — ready to route,
escalate, score or classify in agentic workflows.

Default backend: the BlaBlador gateway (`https://api.blablador.fz-juelich.de/v1/systemone`, model `alias-clef`), but any Clef-compatible endpoint works.

## Quickstart

```sh
cp .env.example .env   # fill in CLEF_API_TOKEN
uv run python server.py
open http://127.0.0.1:8787
```

`server.py` serves the UI (from `static/`) and proxies `/v1/*` to the upstream
API. The proxy exists because the upstream sends no CORS headers and the API
token must stay out of the browser.

## Configuration

| Variable         | Default                                    | Meaning                          |
| ---------------- | ------------------------------------------ | -------------------------------- |
| `CLEF_API_BASE`  | `https://api.blablador.fz-juelich.de`       | Upstream API base URL            |
| `CLEF_API_TOKEN` | —                                          | Bearer token for the upstream API |

CLI flags: `--host` (default `127.0.0.1`) and `--port` (default `8787`).
`.env` is read from the repo root and never overrides real environment variables.

## The API in one screen

`POST /v1/systemone` with `model`, `state` and 1–64 `questions` (ids: letters,
digits, `_`):

```json
{
  "model": "alias-clef",
  "state": "Checkout has been failing for every customer for the last hour.",
  "questions": {
    "urgent":   { "type": "noul",   "instructions": "Is this support request urgent?" },
    "team":     { "type": "choice", "instructions": "Which team should handle this?",
                  "criteria": { "billing": "Payments, invoices, and refunds",
                                "technical": "Outages, errors, and configuration" } },
    "severity": { "type": "score",  "instructions": "How severe is the impact?",
                  "criteria": ["No impact", "Minor", "Major", "Critical"] }
  }
}
```

Question types:

| Type     | `criteria`              | Answer                                        |
| -------- | ----------------------- | --------------------------------------------- |
| `noul`   | none                    | `noul`: probability of yes (0–1)              |
| `choice` | object: option → text   | `choice` winner + `probabilities` + `confidence` |
| `score`  | array of level texts    | `score` (probability-weighted level), `legend`, `probabilities`, `confidence` |

Response shape: `{ "model", "answers": { <question_id>: {...} }, "usage": { "input_tokens", "output_tokens" } }`.
The UI renders each answer type with probability bars and shows the raw JSON underneath.

## Layout

```
server.py         stdlib HTTP server: static files + /v1/* proxy (no deps)
static/index.html UI shell
static/app.js     question builder + result rendering
static/style.css  styling
.env.example      configuration template (the real .env is gitignored)
```