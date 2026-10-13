# decision-model-frontend

A small web UI for typed **decision models** like [Clef](https://blog.cloudflare.com/clef-decision-models/) / Clef-flash (Cloudflare).
You give it a *state* (text or JSON) and a set of *typed questions*; it returns a
decision for each question together with per-option probabilities — ready to route,
escalate, score or classify in agentic workflows.

Default backend: the BlaBlador gateway (`https://api.blablador.fz-juelich.de/v1/systemone`, model `alias-clef`), but any Clef-compatible endpoint works.

## Quickstart

```sh
./run.sh               # first run creates .env from .env.example — fill in CLEF_API_TOKEN
open http://127.0.0.1:8787
```

`run.sh` bootstraps `.env` and starts `server.py`; any extra flags (e.g. `--port 8788`) pass straight through.

## Example presets

The UI ships with 27 presets covering the model's three question types:

- **Hello world: spam or not?** — the smallest possible decision model: one noul question
- **Hello world: review sentiment** — one score question (Negative / Neutral / Positive)
- **Hello world: which language?** — one choice question with 5 options
- **Hello world: fruit basket** — a toy choice so the mechanics are obvious
- **Hello world: take an umbrella?** — daily-life noul
- **LLM router** — picks the model for a request out of the 14 live BlaBlador models (`/v1/models` lineup: GPT-OSS, MiniMax-M2.7, Qwen3.8 family, EVE-Instruct, GLM-5.3, Kimi-K3, DeepSeek-V4.1, MiMo-V2.6, Apertus, Muse Glimmer, Kolibri-1)
- **Tool router** — which service family runs a pipeline step (chat LLM / decision model / PII anonymizer / image gen / speech-to-text / embeddings)
- **Route selection** — fast vs. heavy capability tier for a coding request
- **Support triage** — noul + choice + score together (urgency, team, severity)
- **SLURM failure triage** — user error vs. OOM vs. transient infra vs. framework bug, restartability, severity
- **Prompt-injection detector** — yes/no + attack pattern + severity score
- **Email triage** — does it need a reply, urgency score, next action
- **GitHub issue triage** — bug/feature/question/infra/docs label, priority score, needs a reproduction?
- **PR merge gate** — merge as-is (noul), review depth (rubber stamp / normal / deep dive), risk score
- **Incident severity & paging** — SEV score, page the on-call (noul), first move (rollback / restart / scale / upstream / watch)
- **GDPR / DSGVO classification** — personal data (noul), category (identity / health / financial / location...), sensitivity score
- **ML experiment: what next?** — more data / tune / fix bug / scale / ship / abandon, confidence score, needs GPU allocation
- **Flaky vs real test failure** — flaky (noul), root cause, fix action (rerun / quarantine / fix test / fix code)
- **SLURM pre-flight** — safe to submit (noul), tightness score, likely bottleneck (GPU mem / time / CPU / IO / quota)
- **Content moderation** — safe to publish (noul), policy category, severity score
- **Business: expense report approval** — approve as-is, issue (over limit / missing receipts / suspicious), handling score
- **Business: sales lead scoring** — Cold/Warm/Hot score, prioritize today (noul), owner routing
- **Business: refund decision** — grant (noul), action (full / partial / credit / deny), trust score
- **Business: contract clause risk** — risky (noul), clause area (termination / liability / IP...), escalation score
- **Business: meeting or async?** — needs live meeting (noul), right format, prep score
- **Business: job application routing** — role fit choice, seniority score, worth a call (noul)
- **Blank starter**

## Throughput benchmark

`bench_throughput.py` measures how many decisions per second the API really
does, using the UI presets above as workloads (extracted verbatim from
`static/app.js`):

```sh
uv run python bench_throughput.py                      # full run: sweep + ramp 1→32
uv run python bench_throughput.py --concurrencies 1 8 32 --duration 20
```

Phase 1 sends every preset sequentially a couple of times (per-preset latency,
also warms the model). Phase 2 drives mixed presets round-robin at each
concurrency level for `--duration` seconds and reports req/s, p50/p95 latency
and input tok/s. Connections are kept alive (one per load thread) so TLS
handshakes don't pollute the numbers. Reading the ramp: if req/s stays flat
while concurrency grows and latency scales linearly, the backend is serving
requests serially — concurrency is only buying queueing.

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

## Hosting

Live on GitHub Pages: **https://surak.github.io/decision-model-frontend/** — built
from `static/` by `.github/workflows/pages.yml` on every push to `main`.

Pages is UI-only: the decision API needs a real backend because the upstream
gateway sends no CORS headers and the auth token must never reach the browser.
Three levels of deployment:

1. **Showcase (what Pages gives you)**: presets, builder and rendering all work;
   the Run button shows instructions instead of a call.
2. **Local full app**: `./run.sh` and open http://127.0.0.1:8787 — token stays in
   gitignored `.env`, server-side.
3. **Public full app**: `deploy/` is a Cloudflare Worker holding the token as a
   `CLEF_TOKEN` secret, serving `static/` and proxying `/v1/*` same-origin (the
   UI works unmodified). `cd deploy && wrangler deploy && wrangler secret put
   CLEF_TOKEN`. Anyone who reaches the worker can spend your quota — put Cloudflare
   Access or a rate limit in front of it before sharing the link.

## Layout

```
run.sh            one-shot start: bootstraps .env, runs server.py
server.py         stdlib HTTP server: static files + /v1/* proxy (no deps)
bench_throughput.py  decisions/sec benchmark against /v1/systemone (presets as workloads)
static/index.html UI shell
static/app.js     question builder + result rendering
static/style.css  styling
.env.example      configuration template (the real .env is gitignored)
```