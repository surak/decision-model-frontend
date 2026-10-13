"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const MAX_QUESTIONS = 64; // input schema limit of the decision models

const PRESETS = [
  {
    name: "Route selection (CUDA kernels)",
    model: "alias-clef",
    stateMode: "text",
    state: "Write an extremely ultra advanced script optimizing multi-threaded CUDA kernels for matrix multiplication.",
    questions: {
      route_selection: {
        type: "choice",
        instructions: "Which capability tier is required to successfully fulfill this request?",
        criteria: {
          fast_tier: "Simple coding scripts, basic factual lookups, and clear formatting tasks.",
          heavy_tier: "Highly complex logic, multi-threaded optimization, math proofs, programming, or ambiguous system architecture queries.",
        },
      },
    },
  },
  {
    name: "Support triage (noul + choice + score)",
    model: "alias-clef",
    stateMode: "json",
    state: '{"ticket": "Checkout has been failing for every customer for the last hour.", "customer_tier": "enterprise"}',
    questions: {
      urgent: { type: "noul", instructions: "Is this support request urgent?" },
      team: {
        type: "choice",
        instructions: "Which team should handle this request?",
        criteria: {
          billing: "Payments, invoices, and refunds",
          technical: "Outages, errors, and configuration",
          sales: "Plans and upgrades",
        },
      },
      severity: {
        type: "score",
        instructions: "How severe is the customer impact?",
        criteria: ["No impact", "Minor", "Major", "Critical"],
      },
    },
  },
  {
    name: "Blank starter",
    model: "alias-clef",
    stateMode: "text",
    state: "",
    questions: {
      question_1: { type: "noul", instructions: "" },
    },
  },
];

/* ---------- question builder ---------- */

function buildQuestionCard({ id, type = "noul", instructions = "", criteria = null }) {
  const card = document.createElement("div");
  card.className = "q-card";
  card.innerHTML = `
    <div class="q-head">
      <input class="q-id" placeholder="question_id" spellcheck="false">
      <select class="q-type">
        <option value="noul">noul (yes/no)</option>
        <option value="choice">choice</option>
        <option value="score">score</option>
      </select>
      <button class="q-del ghost" title="Remove question">×</button>
    </div>
    <textarea class="q-instructions" rows="2" placeholder="Instructions — what should the model decide?"></textarea>
    <div class="q-criteria"></div>`;
  $(".q-id", card).value = id;
  $(".q-type", card).value = type;
  $(".q-instructions", card).value = instructions;
  renderCriteria(card, type, criteria);
  $(".q-type", card).addEventListener("change", (e) => renderCriteria(card, e.target.value, null));
  $(".q-del", card).addEventListener("click", () => { card.remove(); updateCount(); });
  return card;
}

function renderCriteria(card, type, criteria) {
  const box = $(".q-criteria", card);
  box.innerHTML = "";
  if (type === "noul") {
    box.innerHTML = `<p class="hint">No criteria — the answer is the probability of "yes" (0–1).</p>`;
    return;
  }
  const list = document.createElement("div");
  list.className = "crit-list";
  const add = document.createElement("button");
  add.className = "ghost small";

  if (type === "choice") {
    const entries = criteria && !Array.isArray(criteria) && Object.keys(criteria).length
      ? Object.entries(criteria)
      : [["", ""]];
    for (const [key, val] of entries) addChoiceRow(list, key, val);
    add.textContent = "+ option";
    add.addEventListener("click", () => addChoiceRow(list, "", ""));
  } else {
    const levels = Array.isArray(criteria) && criteria.length ? criteria : ["", ""];
    for (const level of levels) addScoreRow(list, level);
    add.textContent = "+ level";
    add.addEventListener("click", () => { addScoreRow(list, ""); relabelScores(list); });
  }
  box.append(list, add);
  relabelScores(list);
}

function addChoiceRow(list, key, val) {
  const row = document.createElement("div");
  row.className = "crit-row";
  row.innerHTML = `
    <input class="c-key" placeholder="option_id" spellcheck="false">
    <input class="c-val" placeholder="description">
    <button class="q-del ghost" title="Remove">×</button>`;
  $(".c-key", row).value = key;
  $(".c-val", row).value = val;
  $(".q-del", row).addEventListener("click", () => row.remove());
  list.appendChild(row);
}

function addScoreRow(list, val) {
  const row = document.createElement("div");
  row.className = "crit-row";
  row.innerHTML = `
    <span class="lvl"></span>
    <input class="c-val" placeholder="level description">
    <button class="q-del ghost" title="Remove">×</button>`;
  $(".c-val", row).value = val;
  $(".q-del", row).addEventListener("click", () => { row.remove(); relabelScores(list); });
  list.appendChild(row);
}

function relabelScores(list) {
  $$(".crit-row .lvl", list).forEach((el, i) => { el.textContent = "L" + i; });
}

function collectQuestion(card) {
  const id = $(".q-id", card).value.trim();
  const type = $(".q-type", card).value;
  const instructions = $(".q-instructions", card).value.trim();
  if (!/^[A-Za-z0-9_]+$/.test(id)) throw new Error(`Invalid question id "${id}" — use letters, digits and underscores.`);
  if (!instructions) throw new Error(`Question "${id}" needs instructions.`);
  if (type === "choice") {
    const criteria = {};
    for (const row of $$(".crit-row", card)) {
      const key = $(".c-key", row).value.trim();
      const val = $(".c-val", row).value.trim() || key;
      if (!key) throw new Error(`Question "${id}": every option needs an id.`);
      criteria[key] = val;
    }
    if (!Object.keys(criteria).length) throw new Error(`Question "${id}": add at least one option.`);
    return [id, { type, instructions, criteria }];
  }
  if (type === "score") {
    const criteria = $$(".crit-row .c-val", card).map((i) => i.value.trim()).filter(Boolean);
    if (criteria.length < 2) throw new Error(`Question "${id}": add at least two levels.`);
    return [id, { type, instructions, criteria }];
  }
  return [id, { type, instructions }];
}

function updateCount() {
  const n = $$(".q-card").length;
  $("#q-count").textContent = `${n} / ${MAX_QUESTIONS}`;
  $("#add-question").disabled = n >= MAX_QUESTIONS;
}

/* ---------- run ---------- */

function buildPayload() {
  const model = $("#model").value.trim();
  const rawState = $("#state").value;
  if (!model) throw new Error("Model is required.");
  if (!rawState.trim()) throw new Error("State is required.");
  let state = rawState;
  if ($("#state-mode").value === "json") {
    try {
      state = JSON.parse(rawState);
    } catch {
      throw new Error("State is set to JSON but does not parse as JSON.");
    }
  }
  const cards = $$(".q-card");
  if (!cards.length) throw new Error("Add at least one question.");
  const questions = {};
  for (const card of cards) {
    const [id, q] = collectQuestion(card);
    if (id in questions) throw new Error(`Duplicate question id "${id}".`);
    questions[id] = q;
  }
  return { model, state, questions };
}

async function run() {
  let payload;
  try {
    payload = buildPayload();
  } catch (err) {
    showError(err.message);
    return;
  }
  const btn = $("#run");
  btn.disabled = true;
  btn.textContent = "Running…";
  const t0 = performance.now();
  try {
    const resp = await fetch("/v1/systemone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    const latency = Math.round(performance.now() - t0);
    if (!resp.ok) {
      showError(data.error || data.detail || `HTTP ${resp.status}`, latency);
      return;
    }
    renderResults(data, payload.questions, latency);
  } catch (err) {
    showError(`Request failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run";
  }
}

/* ---------- results ---------- */

function clearResults() {
  $("#result-body").innerHTML = '<p class="empty">Run a decision to see typed answers with per-option probabilities.</p>';
}

function showError(msg, latency) {
  $("#result-body").innerHTML = "";
  const box = document.createElement("div");
  box.className = "error";
  box.textContent = msg;
  $("#result-body").appendChild(box);
  if (latency !== undefined) $("#result-body").append(metaLine(null, latency));
}

function metaLine(usage, latency) {
  const p = document.createElement("p");
  p.className = "meta";
  const parts = [`latency ${latency} ms`];
  if (usage) parts.push(`input ${usage.input_tokens} tok`, `output ${usage.output_tokens} tok`);
  p.textContent = parts.join(" · ");
  return p;
}

function renderResults(data, defs, latency) {
  const body = $("#result-body");
  body.innerHTML = "";
  for (const [id, answer] of Object.entries(data.answers || {})) {
    body.appendChild(answerCard(id, answer, defs[id]));
  }
  body.appendChild(metaLine(data.usage, latency));

  const raw = document.createElement("details");
  raw.innerHTML = "<summary>Raw JSON</summary>";
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(data, null, 2);
  raw.appendChild(pre);
  body.appendChild(raw);
}

function answerCard(id, answer, def) {
  const card = document.createElement("div");
  card.className = "answer";
  const head = document.createElement("h3");
  head.innerHTML = `<span class="qname"></span> <span class="tag"></span>`;
  $(".qname", head).textContent = id;
  $(".tag", head).textContent = answer.type;
  card.appendChild(head);
  if (def && def.instructions) card.title = def.instructions;

  if (answer.type === "noul") {
    card.appendChild(big(`${(answer.noul * 100).toFixed(1)}%`, "yes"));
    card.appendChild(barRow("yes", answer.noul, answer.noul >= 0.5));
  } else if (answer.type === "choice") {
    card.appendChild(big(answer.choice, `confidence ${(answer.confidence * 100).toFixed(1)}%`));
    for (const [opt, p] of sortedProbs(answer.probabilities)) {
      card.appendChild(barRow(labelFor(def, opt), p, opt === answer.choice));
    }
  } else if (answer.type === "score") {
    const top = answer.probabilities ? maxKey(answer.probabilities) : null;
    card.appendChild(big(answer.score.toFixed(2), `confidence ${(answer.confidence * 100).toFixed(1)}%`));
    const legend = answer.legend || {};
    for (const [lvl, p] of sortedProbs(answer.probabilities, true)) {
      card.appendChild(barRow(`L${lvl} · ${legend[lvl] ?? ""}`, p, lvl === top));
    }
  } else {
    card.appendChild(big(JSON.stringify(answer), ""));
  }
  return card;
}

function big(value, sub) {
  const div = document.createElement("div");
  div.className = "big";
  const strong = document.createElement("strong");
  strong.textContent = value;
  div.appendChild(strong);
  if (sub) {
    const small = document.createElement("span");
    small.className = "sub";
    small.textContent = sub;
    div.appendChild(small);
  }
  return div;
}

function barRow(label, p, win) {
  const row = document.createElement("div");
  row.className = "bar-row" + (win ? " win" : "");
  row.innerHTML = `<span class="bar-label"></span><div class="bar"><div class="fill"></div></div><span class="bar-pct"></span>`;
  $(".bar-label", row).textContent = label;
  $(".fill", row).style.width = (p * 100).toFixed(1) + "%";
  $(".bar-pct", row).textContent = (p * 100).toFixed(1) + "%";
  return row;
}

function labelFor(def, key) {
  const desc = def && def.criteria && !Array.isArray(def.criteria) ? def.criteria[key] : null;
  return desc && desc !== key ? `${key} — ${desc}` : key;
}

function sortedProbs(probs, numericKeys = false) {
  const entries = Object.entries(probs || {});
  entries.sort((a, b) => b[1] - a[1]);
  return numericKeys ? entries.sort((a, b) => Number(a[0]) - Number(b[0])) : entries;
}

function maxKey(obj) {
  return Object.entries(obj).sort((a, b) => b[1] - a[1])[0]?.[0];
}

/* ---------- presets + init ---------- */

function applyPreset(preset) {
  $("#model").value = preset.model;
  $("#state-mode").value = preset.stateMode || "text";
  $("#state").value = preset.state;
  const box = $("#questions");
  box.innerHTML = "";
  for (const [id, q] of Object.entries(preset.questions)) {
    box.appendChild(buildQuestionCard({ id, ...q }));
  }
  updateCount();
  clearResults();
}

function init() {
  const select = $("#preset");
  PRESETS.forEach((p, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = p.name;
    select.appendChild(opt);
  });
  select.addEventListener("change", () => applyPreset(PRESETS[select.value]));
  $("#add-question").addEventListener("click", () => {
    $("#questions").appendChild(buildQuestionCard({ id: `question_${$$(".q-card").length + 1}` }));
    updateCount();
  });
  $("#run").addEventListener("click", run);
  applyPreset(PRESETS[0]);
}

init();