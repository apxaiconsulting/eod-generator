/* EOD Generator: paste raw notes, get a role-aligned End-of-Day report.
   Everything is stored in this browser. The only network call is the
   request to the AI worker when a report or extra output is generated. */
'use strict';

const STORE_KEY = 'eod-generator.v1';
const DEFAULT_ENDPOINT = 'https://studyforge-api.apx-jqnn.workers.dev';
const TZ = 'America/Chicago';          // the workday that matters is Central, not the device clock
const AI_TIMEOUT_MS = 120000;          // a full report measured about 40s

const MODES = [
  { id:'shipped',  name:'AI / System Work Shipped Today' },
  { id:'research', name:'Research Output' },
  { id:'win',      name:'Win for the Day' },
  { id:'self',     name:'Performance Self-Assessment' },
  { id:'role',     name:'Role Reconstruction Assessment' },
  { id:'pending',  name:'Pending Tasks' },
];

/* Appended to the instructions on every request. The report gets pasted into
   chat and email, so it has to be plain text. */
const OUTPUT_RULES = [
  '',
  '## Output format for this app',
  '',
  'These rules win over anything above that conflicts with them.',
  '',
  '- Write plain text only. No Markdown: no #, no ** and no tables.',
  '- Never use em dashes or en dashes. Use commas, periods or colons.',
  '- KISS: plain everyday words, short sentences, no filler, no corporate phrasing. Say each thing once.',
  '- Every sentence about my work must have "I" as its written subject: "I corrected the bug", never "Corrected the bug".',
  '- Add no detail that is not in the notes, not even a small descriptive one.',
  '- A full EOD report is: the first line exactly "End-of-Day Report: <the report date written out>", a blank line,',
  '  then two to four short paragraphs separated by blank lines, 120 to 180 words in total.',
  '  No section headings, no labels on their own line, no bullet lists.',
  '  If anything is unfinished or blocked, the last paragraph starts with "Pending:" and covers it in one or two sentences.',
  '- An additional output (not the full report) may use a short hyphen list when it is a list by nature. Keep it brief.',
  '- Do not add a preamble or a closing remark. Output only what was asked for.',
  '- If you must ask a clarification question, put it on the last line, starting with "Question:".',
].join('\n');

const $ = s => document.querySelector(s);
let DEFAULT_INSTRUCTIONS = '';
let S = load();
let busy = false;

/* ---------- storage ---------- */
function load(){
  let s = {};
  try{ s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; }catch(e){}
  return {
    days: (s.days && typeof s.days === 'object') ? s.days : {},
    instructions: typeof s.instructions === 'string' ? s.instructions : null,
    endpoint: typeof s.endpoint === 'string' && s.endpoint ? s.endpoint : DEFAULT_ENDPOINT,
  };
}
function save(){
  try{ localStorage.setItem(STORE_KEY, JSON.stringify(S)); }
  catch(e){ toast('Could not save on this device'); }
}
function day(d){
  if(!S.days[d]) S.days[d] = { notes:'', report:'', extras:{}, updated:0 };
  if(!S.days[d].extras) S.days[d].extras = {};
  return S.days[d];
}
function pruneEmpty(){
  for(const d of Object.keys(S.days)){
    const x = S.days[d];
    if(!x.notes && !x.report && !Object.keys(x.extras||{}).length) delete S.days[d];
  }
}

/* ---------- dates ---------- */
function todayISO(){
  const p = new Intl.DateTimeFormat('en-CA', { timeZone:TZ, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return g('year') + '-' + g('month') + '-' + g('day');
}
function longDate(iso){
  const [y,m,d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m-1, d, 12)).toLocaleDateString('en-US', { timeZone:'UTC', weekday:'long', year:'numeric', month:'long', day:'numeric' });
}
function curDate(){ return $('#date').value || todayISO(); }

/* ---------- AI ---------- */
function instructions(){ return (S.instructions ?? DEFAULT_INSTRUCTIONS) || ''; }

/* The model is told not to use Markdown or long dashes; this catches the
   times it does anyway. Wording is never changed. */
function clean(t){
  return String(t||'')
    .replace(/^```[a-z]*\s*|```\s*$/gi, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[ \t]*[*•]\s+/gm, '- ')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function ask(userText){
  const sys = instructions();
  if(!sys.trim()) throw new Error('the instructions are empty. Check Settings.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
  let res;
  try{
    res = await fetch(S.endpoint, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({
        systemInstruction: { parts:[{ text: sys + '\n' + OUTPUT_RULES }] },
        contents: [{ role:'user', parts:[{ text: userText }] }],
        generationConfig: { maxOutputTokens: 8192, temperature: 0.3 },
      }),
    });
  }catch(e){
    throw new Error(e.name === 'AbortError' ? 'the model took too long. Try again.' : 'the request could not be sent. Check your connection.');
  }finally{ clearTimeout(timer); }

  if(!res.ok){
    let msg = 'HTTP ' + res.status;
    try{ const j = await res.json(); if(j?.error?.message) msg = j.error.message; else if(typeof j?.error === 'string') msg = j.error; }catch(e){}
    throw new Error(msg);
  }
  const data = await res.json();
  const cand = data?.candidates?.[0];
  const raw = (cand?.content?.parts || []).map(p => p.text || '').join('');
  if(!raw.trim()) throw new Error('the model returned nothing');
  const out = clean(raw);
  return cand?.finishReason === 'MAX_TOKENS' ? out + '\n\n[The model stopped early. Regenerate to get the full text.]' : out;
}

function reportPrompt(d, notes){
  return 'Report date: ' + longDate(d) + '\n\n' +
    'Below are my raw daily work notes. Write the complete EOD report for this date.\n\n' +
    '--- RAW NOTES ---\n' + notes.slice(0, 60000);
}
function extraPrompt(d, x, mode){
  return 'Report date: ' + longDate(d) + '\n\n' +
    '--- RAW NOTES ---\n' + x.notes.slice(0, 60000) + '\n\n' +
    '--- EOD REPORT ALREADY WRITTEN ---\n' + x.report + '\n\n' +
    'Now write only this additional output, as defined in the Output Modes section: "' + mode.name + '". ' +
    'Do not repeat the name as a heading. Use only facts found in the notes and the report.';
}

/* ---------- UI helpers ---------- */
let toastTimer;
function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}
async function copy(text){
  try{ await navigator.clipboard.writeText(text); toast('Copied'); }
  catch(e){
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
    ta.select(); try{ document.execCommand('copy'); toast('Copied'); }catch(_){ toast('Copy failed'); } ta.remove();
  }
}
function setStatus(msg, bad){
  const s = $('#status');
  if(!msg){ s.hidden = true; return; }
  s.textContent = msg; s.hidden = false; s.classList.toggle('bad', !!bad);
}
/* Runs one AI call with a visible seconds counter and locked buttons. */
async function run(label, fn){
  if(busy) return;
  busy = true;
  document.querySelectorAll('#genBtn,.modes .btn').forEach(b => b.disabled = true);
  const t0 = Date.now();
  const tick = () => setStatus(label + ' ' + Math.round((Date.now()-t0)/1000) + 's (usually 30 to 60 seconds)');
  tick(); const iv = setInterval(tick, 1000);
  try{ await fn(); setStatus(''); }
  catch(e){ setStatus('Could not generate: ' + e.message, true); }
  finally{
    clearInterval(iv); busy = false;
    document.querySelectorAll('#genBtn,.modes .btn').forEach(b => b.disabled = false);
  }
}

/* ---------- write view ---------- */
function renderDay(){
  const d = curDate(), x = S.days[d] || { notes:'', report:'', extras:{} };
  $('#notes').value = x.notes || '';
  $('#report').value = x.report || '';
  $('#reportCard').hidden = !x.report;
  $('#extrasCard').hidden = !x.report;
  $('#genBtn').textContent = x.report ? 'Regenerate EOD' : 'Generate EOD';
  renderExtras();
  setStatus('');
}
function renderExtras(){
  const x = S.days[curDate()] || { extras:{} };
  const box = $('#extras'); box.textContent = '';
  for(const m of MODES){
    const text = x.extras?.[m.id];
    if(!text) continue;
    const wrap = document.createElement('div'); wrap.className = 'extra';
    const head = document.createElement('div'); head.className = 'row between';
    const h = document.createElement('h3'); h.textContent = m.name;
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = 'Copy';
    b.onclick = () => copy(text);
    head.append(h, b);
    const pre = document.createElement('pre'); pre.textContent = text;
    wrap.append(head, pre); box.append(wrap);
  }
}
function buildModes(){
  const box = $('#modes');
  for(const m of MODES){
    const b = document.createElement('button'); b.className = 'btn'; b.textContent = m.name;
    b.onclick = () => genExtra(m);
    box.append(b);
  }
}

async function generate(){
  const d = curDate(), notes = $('#notes').value.trim();
  if(!notes){ setStatus('Paste your notes first.', true); return; }
  const x = day(d);
  if(x.report && !confirm('Replace the current report for ' + longDate(d) + '?')) return;
  await run('Writing the report…', async () => {
    const out = await ask(reportPrompt(d, notes));
    const y = day(d);
    y.notes = notes; y.report = out; y.extras = {}; y.updated = Date.now();
    save();
    if(curDate() === d){ renderDay(); $('#reportCard').scrollIntoView({ behavior:'smooth', block:'start' }); }
  });
}
async function genExtra(mode){
  const d = curDate(), x = S.days[d];
  if(!x || !x.report) return;
  await run('Writing ' + mode.name + '…', async () => {
    let out = await ask(extraPrompt(d, x, mode));
    /* The card already shows the name, so drop it if the model repeats it. */
    const lines = out.split('\n');
    if(lines[0].replace(/[:\s]+$/,'').toLowerCase() === mode.name.toLowerCase()) out = lines.slice(1).join('\n').trim();
    day(d).extras[mode.id] = out; day(d).updated = Date.now();
    save();
    if(curDate() === d) renderExtras();
  });
}

/* ---------- history ---------- */
function renderHistory(){
  pruneEmpty();
  const box = $('#historyList'); box.textContent = '';
  const dates = Object.keys(S.days).sort().reverse();
  if(!dates.length){
    const e = document.createElement('div'); e.className = 'empty'; e.textContent = 'No reports yet.';
    box.append(e); return;
  }
  for(const d of dates){
    const x = S.days[d];
    const row = document.createElement('div'); row.className = 'hist';
    const meta = document.createElement('div'); meta.className = 'meta';
    const dd = document.createElement('div'); dd.className = 'd'; dd.textContent = longDate(d);
    const ss = document.createElement('div'); ss.className = 's';
    const body = x.report ? x.report.split('\n').filter(l => l.trim())[1] || x.report : 'Notes only, no report yet';
    ss.textContent = body;
    meta.append(dd, ss);
    const open = document.createElement('button'); open.className = 'btn'; open.textContent = 'Open';
    open.onclick = () => { $('#date').value = d; renderDay(); show('write'); };
    const del = document.createElement('button'); del.className = 'btn ghost danger'; del.textContent = 'Delete';
    del.onclick = () => {
      if(!confirm('Delete the notes and report for ' + longDate(d) + '? This cannot be undone.')) return;
      delete S.days[d]; save(); renderHistory(); if(curDate() === d) renderDay();
    };
    row.append(meta, open, del); box.append(row);
  }
}
function exportBackup(){
  const blob = new Blob([JSON.stringify({ app:'eod-generator', version:1, days:S.days }, null, 2)], { type:'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'eod-backup-' + todayISO() + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function importBackup(file){
  try{
    const j = JSON.parse(await file.text());
    if(!j || typeof j.days !== 'object') throw new Error();
    let n = 0;
    for(const [d, x] of Object.entries(j.days)){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(d) || !x || typeof x !== 'object') continue;
      const cur = S.days[d];
      if(cur && (cur.updated||0) >= (x.updated||0)) continue;   // keep the newer copy
      const extras = {};
      for(const m of MODES) if(typeof x.extras?.[m.id] === 'string') extras[m.id] = x.extras[m.id];
      S.days[d] = { notes:String(x.notes||''), report:String(x.report||''), extras, updated:Number(x.updated)||0 };
      n++;
    }
    save(); renderHistory(); renderDay();
    toast(n ? 'Imported ' + n + (n === 1 ? ' day' : ' days') : 'Nothing newer to import');
  }catch(e){ toast('That file is not an EOD backup'); }
}

/* ---------- settings ---------- */
function renderSettings(){
  $('#instructions').value = instructions();
  $('#endpoint').value = S.endpoint;
  $('#instrHint').textContent = S.instructions === null ? 'Using the built-in default.' : 'Using your edited version.';
}

/* ---------- navigation ---------- */
function show(view){
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== 'view-' + view);
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  if(view === 'history') renderHistory();
  if(view === 'settings') renderSettings();
  window.scrollTo(0, 0);
}

/* ---------- wiring ---------- */
async function init(){
  $('#date').value = todayISO();
  buildModes();
  renderDay();

  document.querySelectorAll('.tab').forEach(t => t.onclick = () => show(t.dataset.view));
  $('#date').onchange = () => { if(!$('#date').value) $('#date').value = todayISO(); renderDay(); };

  let saveTimer;
  $('#notes').oninput = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const v = $('#notes').value;
      if(!v && !S.days[curDate()]) return;
      day(curDate()).notes = v; day(curDate()).updated = Date.now(); pruneEmpty(); save();
    }, 400);
  };
  $('#report').oninput = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { day(curDate()).report = $('#report').value; day(curDate()).updated = Date.now(); save(); }, 400);
  };
  $('#genBtn').onclick = generate;
  $('#clearBtn').onclick = () => {
    const d = curDate();
    if(!S.days[d]) { $('#notes').value = ''; return; }
    if(!confirm('Clear the notes and report for ' + longDate(d) + '?')) return;
    delete S.days[d]; save(); renderDay();
  };
  $('#copyReport').onclick = () => copy($('#report').value);

  $('#exportBtn').onclick = exportBackup;
  $('#importBtn').onclick = () => $('#importFile').click();
  $('#importFile').onchange = e => { const f = e.target.files[0]; if(f) importBackup(f); e.target.value = ''; };

  $('#saveInstr').onclick = () => {
    const v = $('#instructions').value;
    S.instructions = (v.trim() === DEFAULT_INSTRUCTIONS.trim()) ? null : v;
    save(); renderSettings(); toast('Instructions saved');
  };
  $('#resetInstr').onclick = () => {
    if(S.instructions !== null && !confirm('Discard your edited instructions and go back to the default?')) return;
    S.instructions = null; save(); renderSettings(); toast('Default restored');
  };
  $('#saveEndpoint').onclick = () => {
    S.endpoint = $('#endpoint').value.trim() || DEFAULT_ENDPOINT;
    save(); renderSettings(); toast('Endpoint saved');
  };

  try{
    const r = await fetch('./instructions.md', { cache:'no-cache' });
    if(r.ok) DEFAULT_INSTRUCTIONS = (await r.text()).trim();
  }catch(e){}
  if(!instructions().trim()) setStatus('The default instructions could not be loaded. Reload the page while online.', true);

  if('serviceWorker' in navigator && location.protocol === 'https:'){
    /* When a new version takes over, load it straight away, unless a report
       is being written right now. Typed notes are already saved. */
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if(hadController && !busy) location.reload(); });
    navigator.serviceWorker.register('sw.js', { updateViaCache:'none' }).then(r => r.update()).catch(() => {});
  }
}
init();
