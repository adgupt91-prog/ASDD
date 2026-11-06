/**
 * ASDD Re-verification – Oracle backend (Vercel serverless function)
 * Same actions and same JSON shapes as the old Google Apps Script, so the website only needs a new URL.
 *
 *   GET  ?action=get&ps=N      answers of one PS          { ok, data: { EPIC: [9 values] } }
 *   GET  ?action=summary       per-PS counts              { ok, data: { ps: {done,residing,notResiding,f6yes,f6no,frozen} } }
 *   GET  ?action=resall        every Residing elector     { ok, resall:true, data: { ps: [[sno,name,epic,[8]]] } }
 *   GET  ?action=ping          connection test            { ok, v:3, db:true }
 *   GET  ?action=count         row counts (for checking the migration)
 *   GET  ?action=setup&key=K   creates the tables once (K = MIGRATE_KEY)
 *   POST {ps, blo, partName, v:2, rows:[...]}             save (same body as before)
 *   POST {action:'migrate', key, rows:[[rowNo, A..Z]]}     bulk import from the Google Sheet
 *
 * Secrets come from Vercel environment variables:
 *   ORACLE_USER, ORACLE_PASSWORD, ORACLE_CONNECT, ORACLE_WALLET_PEM, ORACLE_WALLET_PASSWORD, MIGRATE_KEY
 *
 * Answer array (8 values): [status, form6, enumDates, reverifDates, reasonEF, reasonNoForm6, refusedName, refusedMobile]
 */
const oracledb = require('oracledb');
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchArraySize = 5000;

const MOB_RE = /^[6-9]\d{9}$/;
const MAX = 1000;
const str = v => (v == null ? '' : String(v).trim());

/* ------------------------------------------------------------------ connection */
// Repairs a PEM that lost its line breaks when pasted into the Vercel form
function fixPem(p){
  p = String(p || '').replace(/\\n/g, '\n').replace(/\r/g, '').trim();
  return p.replace(/(-----BEGIN [^-]+-----)([\s\S]*?)(-----END [^-]+-----)/g, (_, b, body, e) => {
    const clean = body.replace(/\s+/g, '');
    return b + '\n' + (clean.match(/.{1,64}/g) || []).join('\n') + '\n' + e;
  });
}
const connectString = () => str(process.env.ORACLE_CONNECT).replace(/^\s*[\w.-]+\s*=\s*(?=\()/, '');

let poolPromise = null;
function pool(){
  if(!poolPromise){
    poolPromise = oracledb.createPool({
      user: process.env.ORACLE_USER || 'ADMIN',
      password: process.env.ORACLE_PASSWORD,
      connectString: connectString(),
      walletContent: fixPem(process.env.ORACLE_WALLET_PEM),
      walletPassword: process.env.ORACLE_WALLET_PASSWORD,
      connectTimeout: 15, poolMin: 0, poolMax: 3, poolIncrement: 1, poolTimeout: 60, queueTimeout: 20000, poolPingInterval: 30
    }).catch(e => { poolPromise = null; throw e; });
  }
  return poolPromise;
}
async function getConn(){
  try{ return await (await pool()).getConnection(); }
  catch(e){
    // A pool that cannot connect (e.g. it was created while the database was starting) is thrown away,
    // and one fresh direct connection is tried before giving up.
    const old = poolPromise; poolPromise = null;
    if(old) old.then(p => p.close(0)).catch(() => {});
    return await (await pool()).getConnection();
  }
}
async function withConn(fn){
  const c = await getConn();
  try{ return await fn(c); } finally{ try{ await c.close(); }catch(_){} }
}

/* ------------------------------------------------------------------ same rules as the Apps Script */
function norm(a){
  a = (a || []).slice(0, 8).map(str); while(a.length < 8) a.push('');
  if(a[0] === 'Not Residing') a[0] = 'ASDD';
  if(a[0] !== 'Residing' && a[0] !== 'ASDD') a[0] = '';
  if(a[1] !== 'Yes' && a[1] !== 'No') a[1] = '';
  if(a[0] === 'ASDD' || !a[0]){ a[1] = a[4] = a[5] = a[6] = a[7] = ''; }
  else if(a[1] === 'Yes'){ a[5] = a[6] = a[7] = ''; }
  a[2] = a[2].slice(0, 200); a[3] = a[3].slice(0, 200);    // multiple visit dates allowed (comma-separated)
  a[4] = a[4].slice(0, 200); a[5] = a[5].slice(0, 200); a[6] = a[6].slice(0, 100); a[7] = a[7].replace(/\D/g, '').slice(0, 10);
  return a;
}
// Keep only the first date of a comma-separated list ("05-11-2026, 07-11-2026" -> "05-11-2026")
const firstDate = v => str(String(v || '').split(',')[0]).slice(0, 200);
function complete(a){
  if(!a[2] || !a[3]) return false;
  if(a[0] === 'ASDD') return true;
  if(a[0] !== 'Residing' || !a[4] || !a[1]) return false;
  if(a[1] === 'Yes') return true;
  return !!(a[5] && a[6] && MOB_RE.test(a[7]));
}
// DB row -> website answer (9 values; 9th = old Remarks). Reason Form-6 not obtained falls back to the old Remarks.
function fromRow(r){
  const a = norm([r.STATUS, r.FORM6, r.ENUM_DATES, r.REVERIF_DATES, r.REASON_EF,
                  str(r.REASON_NO_F6) || str(r.OLD_REMARKS), r.REFUSED_NAME, r.REFUSED_MOBILE]);
  a.push(str(r.OLD_REMARKS));
  return a;
}
const ANS_COLS = 'status, form6, old_remarks, reason_no_f6, enum_dates, reverif_dates, reason_ef, refused_name, refused_mobile';

/* ------------------------------------------------------------------ setup */
const DDL = [
  `CREATE TABLE IF NOT EXISTS asdd_elector (
     epic           VARCHAR2(30) PRIMARY KEY,
     row_no         NUMBER,
     updated_at     TIMESTAMP,
     district       VARCHAR2(100), ac_no VARCHAR2(20), ac_name VARCHAR2(100),
     ps             VARCHAR2(20),  part_name VARCHAR2(200), blo VARCHAR2(200),
     sno            VARCHAR2(30),  name VARCHAR2(300), rel_type VARCHAR2(50), rel_name VARCHAR2(300),
     old_part       VARCHAR2(30),  old_serial VARCHAR2(30), age VARCHAR2(20), gender VARCHAR2(20),
     asdd_list_status VARCHAR2(200),
     status         VARCHAR2(30),  form6 VARCHAR2(10),
     old_remarks    VARCHAR2(1000), reason_no_f6 VARCHAR2(1000),
     enum_dates     VARCHAR2(1000), reverif_dates VARCHAR2(1000), reason_ef VARCHAR2(1000),
     refused_name   VARCHAR2(1000), refused_mobile VARCHAR2(100))`,
  `CREATE INDEX IF NOT EXISTS asdd_elector_ps ON asdd_elector (ps)`,
  `CREATE INDEX IF NOT EXISTS asdd_elector_status ON asdd_elector (status, ps)`,
  `CREATE TABLE IF NOT EXISTS asdd_edit_log (
     id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     at TIMESTAMP DEFAULT CAST(SYSTIMESTAMP AT TIME ZONE 'Asia/Kolkata' AS TIMESTAMP), ps VARCHAR2(20), blo VARCHAR2(200), epic VARCHAR2(30), name VARCHAR2(300),
     old_status VARCHAR2(30), old_form6 VARCHAR2(10), old_details VARCHAR2(2000),
     new_status VARCHAR2(30), new_form6 VARCHAR2(10), new_details VARCHAR2(2000))`
];
async function setup(){
  return withConn(async c => { for(const s of DDL) await c.execute(s); return { ok:true, created:true }; });
}

/* ------------------------------------------------------------------ reads */
async function getPS(ps){
  if(!ps) return { ok:false, error:'ps missing' };
  return withConn(async c => {
    const r = await c.execute(`SELECT epic, ${ANS_COLS} FROM asdd_elector WHERE ps = :ps`, [ps]);
    const data = {};
    for(const row of r.rows) data[row.EPIC] = fromRow(row);
    return { ok:true, data };
  });
}

// Per-PS counts, worked out inside the database (one small result instead of 80k rows).
// Same rules as complete(): both visit dates; ASDD done; Residing needs reason EF + Form-6, and for Form-6 No
// also reason (or old remarks), refused-by name and a valid 10-digit mobile.
const SUMMARY_SQL = `
  WITH e AS (
    SELECT ps,
           CASE WHEN TRIM(status) IN ('ASDD','Not Residing') THEN 'ASDD' WHEN TRIM(status) = 'Residing' THEN 'Residing' END st,
           CASE WHEN TRIM(form6) IN ('Yes','No') THEN TRIM(form6) END f6,
           enum_dates, reverif_dates, reason_ef, NVL(TRIM(reason_no_f6), old_remarks) rsn, refused_name,
           REGEXP_REPLACE(refused_mobile, '[^0-9]', '') mob
    FROM asdd_elector)
  SELECT ps,
         SUM(CASE WHEN TRIM(enum_dates) IS NOT NULL AND TRIM(reverif_dates) IS NOT NULL AND (
                     st = 'ASDD'
                  OR (st = 'Residing' AND TRIM(reason_ef) IS NOT NULL AND f6 = 'Yes')
                  OR (st = 'Residing' AND TRIM(reason_ef) IS NOT NULL AND f6 = 'No' AND TRIM(rsn) IS NOT NULL
                      AND TRIM(refused_name) IS NOT NULL AND REGEXP_LIKE(SUBSTR(mob, 1, 10), '^[6-9][0-9]{9}$')))
             THEN 1 ELSE 0 END) done,
         SUM(CASE WHEN st = 'Residing' THEN 1 ELSE 0 END) residing,
         SUM(CASE WHEN st = 'ASDD' THEN 1 ELSE 0 END) not_residing,
         SUM(CASE WHEN st = 'Residing' AND f6 = 'Yes' THEN 1 ELSE 0 END) f6yes,
         SUM(CASE WHEN st = 'Residing' AND f6 = 'No' THEN 1 ELSE 0 END) f6no,
         -- "started": the BLO has filled at least one field of the elector (status ASDD alone does not count,
         -- because every elector came pre-marked ASDD)
         SUM(CASE WHEN st = 'Residing' OR f6 IS NOT NULL OR TRIM(enum_dates) IS NOT NULL OR TRIM(reverif_dates) IS NOT NULL
                    OR TRIM(reason_ef) IS NOT NULL OR TRIM(rsn) IS NOT NULL OR TRIM(refused_name) IS NOT NULL OR mob IS NOT NULL
             THEN 1 ELSE 0 END) started
  FROM e WHERE ps IS NOT NULL GROUP BY ps`;

let sumCache = null, sumAt = 0;
async function summary(){
  if(sumCache && Date.now() - sumAt < 30000) return sumCache;
  const res = await withConn(async c => {
    const r = await c.execute(SUMMARY_SQL);
    const data = {};
    for(const row of r.rows)
      data[str(row.PS)] = { done: row.DONE, residing: row.RESIDING, notResiding: row.NOT_RESIDING, f6yes: row.F6YES, f6no: row.F6NO, started: row.STARTED, frozen:false };
    return { ok:true, data };
  });
  sumCache = res; sumAt = Date.now();
  return res;
}

// Old way (all rows into JS) – kept only to cross-check the SQL version: ?action=summarycheck
async function summaryCheck(){
  const fast = (sumCache = null, await summary()).data;
  const slow = await withConn(async c => {
    const r = await c.execute(`SELECT ps, ${ANS_COLS} FROM asdd_elector WHERE status IS NOT NULL`);
    const data = {};
    for(const row of r.rows){
      const a = fromRow(row), p = str(row.PS); if(!a[0] || !p) continue;
      const o = data[p] || (data[p] = { done:0, residing:0, notResiding:0, f6yes:0, f6no:0, frozen:false });
      if(complete(a)) o.done++;
      if(a[0] === 'Residing'){ o.residing++; if(a[1] === 'Yes') o.f6yes++; else if(a[1] === 'No') o.f6no++; }
      else o.notResiding++;
    }
    return data;
  });
  const diffs = [];
  for(const ps of new Set([...Object.keys(fast), ...Object.keys(slow)]))
    for(const k of ['done','residing','notResiding','f6yes','f6no'])
      if((fast[ps] || {})[k] !== (slow[ps] || {})[k]) diffs.push({ ps, k, sql: (fast[ps] || {})[k], js: (slow[ps] || {})[k] });
  return { ok:true, match: !diffs.length, psCount: Object.keys(fast).length, diffs: diffs.slice(0, 20) };
}

async function resAll(){
  return withConn(async c => {
    const r = await c.execute(`SELECT ps, sno, name, epic, ${ANS_COLS} FROM asdd_elector
                               WHERE status = 'Residing' ORDER BY row_no DESC NULLS FIRST`);
    const data = {};
    for(const row of r.rows){
      const a = fromRow(row); if(a[0] !== 'Residing') continue;
      const p = str(row.PS); (data[p] || (data[p] = [])).push([str(row.SNO), str(row.NAME), row.EPIC, a.slice(0, 8)]);
    }
    return { ok:true, resall:true, data };
  });
}

async function count(){
  return withConn(async c => {
    const r = await c.execute(`SELECT COUNT(*) total, COUNT(status) filled,
        SUM(CASE WHEN status='Residing' THEN 1 ELSE 0 END) residing,
        SUM(CASE WHEN status IN ('ASDD','Not Residing') THEN 1 ELSE 0 END) asdd,
        SUM(CASE WHEN status='Residing' AND form6='Yes' THEN 1 ELSE 0 END) f6yes,
        COUNT(DISTINCT ps) ps_count, MAX(updated_at) last_update FROM asdd_elector`);
    return { ok:true, ...r.rows[0] };
  });
}

/* ------------------------------------------------------------------ save (website Submit) */
function details(a){
  return ['Enum dates: ' + (a[2]||'-'), 'Re-verif dates: ' + (a[3]||'-'), 'Reason EF: ' + (a[4]||'-'),
          'Reason no F6: ' + (a[5]||'-'), 'Refused by: ' + (a[6]||'-') + ' ' + (a[7]||'')].join(' | ');
}
const cut = (v, n = MAX) => str(v).slice(0, n);

/* ------------------------------------------------------------------ save log (who saved, from where) */
// One row per Submit: time, PS, BLO, IP address, approximate location (from Vercel), device and browser.
let saveLogReady = false;
async function ensureSaveLog(c){
  if(saveLogReady) return;
  const t = await c.execute(`SELECT COUNT(*) n FROM user_tables WHERE table_name = 'ASDD_SAVE_LOG'`);
  if(!t.rows[0].N){
    await c.execute(`CREATE TABLE asdd_save_log (
      id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      at TIMESTAMP DEFAULT CAST(SYSTIMESTAMP AT TIME ZONE 'Asia/Kolkata' AS TIMESTAMP), ps VARCHAR2(20), blo VARCHAR2(200), part_name VARCHAR2(200),
      rows_sent NUMBER, rows_saved NUMBER, rows_changed NUMBER,
      ip VARCHAR2(64), city VARCHAR2(100), region VARCHAR2(100), country VARCHAR2(10),
      device VARCHAR2(100), user_agent VARCHAR2(500))`);
    await c.execute(`CREATE INDEX asdd_save_log_ps ON asdd_save_log (ps, at)`);
    await c.execute(`CREATE INDEX asdd_save_log_ip ON asdd_save_log (ip, at)`);
  }
  saveLogReady = true;
}
const hdr = (req, k) => { const v = req.headers[k]; return str(Array.isArray(v) ? v[0] : v); };
const dec = v => { try{ return decodeURIComponent(v); }catch(_){ return v; } };
function deviceOf(ua){
  const os = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android'
           : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const br = /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera'
           : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Other';
  const model = (ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/) || [])[1];
  return (os + ' ' + br + (model && model !== 'K' ? ' (' + model.trim() + ')' : '')).slice(0, 100);
}
function clientMeta(req){
  const ua = hdr(req, 'user-agent');
  const ip = (hdr(req, 'x-forwarded-for').split(',')[0] || hdr(req, 'x-real-ip')).trim();
  return { ip: ip.slice(0, 64), city: dec(hdr(req, 'x-vercel-ip-city')).slice(0, 100),
           region: dec(hdr(req, 'x-vercel-ip-country-region')).slice(0, 100), country: hdr(req, 'x-vercel-ip-country').slice(0, 10),
           device: deviceOf(ua), ua: ua.slice(0, 500) };
}

async function save(body, meta){
  const ps = str(body.ps), blo = str(body.blo), part = str(body.partName), list = body.rows || [];
  if(!ps || !list.length) return { ok:false, error:'nothing to save' };
  if(body.v !== 2 || list.some(r => !Array.isArray(r) || r.length < 18))
    return { ok:false, error:'Website updated – please refresh the page and submit again' };

  return withConn(async c => {
    const epics = [...new Set(list.map(r => str(r[1])).filter(Boolean))];
    const old = {};
    for(let i = 0; i < epics.length; i += 900){
      const chunk = epics.slice(i, i + 900), binds = {};
      chunk.forEach((e, k) => { binds['e' + k] = e; });
      const r = await c.execute(`SELECT epic, ${ANS_COLS} FROM asdd_elector WHERE epic IN (${chunk.map((_, k) => ':e' + k).join(',')})`, binds);
      for(const row of r.rows) old[row.EPIC] = fromRow(row);
    }

    const ups = [], logs = [], skipped = [];
    for(const r of list){
      const epic = str(r[1]); if(!epic) continue;
      const a = norm(r.slice(10, 18));
      if(!a[0]){ skipped.push(epic); continue; }
      // epic, ps, part, blo, sno, name, relType, relName, oldPart, oldSerial, age, gender, asddList, R,S,U,V,W,X,Y,Z
      ups.push([epic, ps, cut(part), cut(blo), cut(r[0]), cut(r[2]), cut(r[3]), cut(r[4]), cut(r[5]), cut(r[6]), cut(r[7]), cut(r[8]), cut(r[9]),
                a[0], a[1], a[5], a[2], a[3], a[4], a[6], a[7]]);
      const o = old[epic];
      if(o && o[0] && o.slice(0, 8).join('|') !== a.join('|'))
        logs.push([ps, cut(blo, 200), epic, cut(r[2], 300), o[0], o[1], details(o).slice(0, 2000), a[0], a[1], details(a).slice(0, 2000)]);
    }

    if(ups.length){
      await c.executeMany(
        `MERGE INTO asdd_elector t
         USING (SELECT :1 epic, :2 ps, :3 part_name, :4 blo, :5 sno, :6 name, :7 rel_type, :8 rel_name, :9 old_part, :10 old_serial,
                       :11 age, :12 gender, :13 asdd_list_status, :14 status, :15 form6, :16 reason_no_f6, :17 enum_dates,
                       :18 reverif_dates, :19 reason_ef, :20 refused_name, :21 refused_mobile FROM dual) s
         ON (t.epic = s.epic)
         WHEN MATCHED THEN UPDATE SET
           t.updated_at = SYSTIMESTAMP, t.district = 'CENTRAL', t.ac_no = '24', t.ac_name = 'PATEL NAGAR',
           t.ps = s.ps, t.part_name = s.part_name, t.blo = s.blo, t.sno = s.sno, t.name = s.name, t.rel_type = s.rel_type,
           t.rel_name = s.rel_name, t.old_part = s.old_part, t.old_serial = s.old_serial, t.age = s.age, t.gender = s.gender,
           t.asdd_list_status = s.asdd_list_status, t.status = s.status, t.form6 = s.form6, t.reason_no_f6 = s.reason_no_f6,
           t.enum_dates = s.enum_dates, t.reverif_dates = s.reverif_dates, t.reason_ef = s.reason_ef,
           t.refused_name = s.refused_name, t.refused_mobile = s.refused_mobile
         WHEN NOT MATCHED THEN INSERT
           (epic, updated_at, district, ac_no, ac_name, ps, part_name, blo, sno, name, rel_type, rel_name, old_part, old_serial,
            age, gender, asdd_list_status, status, form6, reason_no_f6, enum_dates, reverif_dates, reason_ef, refused_name, refused_mobile)
         VALUES (s.epic, SYSTIMESTAMP, 'CENTRAL', '24', 'PATEL NAGAR', s.ps, s.part_name, s.blo, s.sno, s.name, s.rel_type, s.rel_name,
                 s.old_part, s.old_serial, s.age, s.gender, s.asdd_list_status, s.status, s.form6, s.reason_no_f6, s.enum_dates,
                 s.reverif_dates, s.reason_ef, s.refused_name, s.refused_mobile)`,
        ups, { bindDefs: Array.from({ length: 21 }, () => ({ type: oracledb.STRING, maxSize: MAX })) });
    }
    if(logs.length){
      await c.executeMany(
        `INSERT INTO asdd_edit_log (ps, blo, epic, name, old_status, old_form6, old_details, new_status, new_form6, new_details)
         VALUES (:1, :2, :3, :4, :5, :6, :7, :8, :9, :10)`,
        logs, { bindDefs: Array.from({ length: 10 }, () => ({ type: oracledb.STRING, maxSize: 2000 })) });
    }
    try{
      await ensureSaveLog(c);
      await c.execute(
        `INSERT INTO asdd_save_log (ps, blo, part_name, rows_sent, rows_saved, rows_changed, ip, city, region, country, device, user_agent)
         VALUES (:ps, :blo, :part, :sent, :saved, :changed, :ip, :city, :region, :country, :device, :ua)`,
        { ps, blo: cut(blo, 200), part: cut(part, 200), sent: list.length, saved: ups.length, changed: logs.length,
          ip: meta.ip, city: meta.city, region: meta.region, country: meta.country, device: meta.device, ua: meta.ua });
    }catch(e){ saveLogReady = false; console.error('save log failed:', e.message); }   // never block a BLO's save
    await c.commit();
    sumCache = null;
    return { ok:true, saved: list.length - skipped.length, skipped };
  });
}

/* ------------------------------------------------------------------ migrate (from the Google Sheet) */
// rows: [[sheetRowNo, A..Z (26 display values; A = ISO timestamp or '')]]
// A row only overwrites an existing one if its Last Updated time is the same or newer,
// so running the import again later never undoes edits already made on the new site.
async function migrate(rows){
  if(!Array.isArray(rows) || !rows.length) return { ok:true, imported:0 };
  const binds = [];
  for(const r of rows){
    const v = r.slice(1).map(x => cut(x)); while(v.length < 26) v.push('');
    if(!v[9]) continue;                                     // column J (EPIC) empty
    const upd = /^\d{4}-\d\d-\d\dT/.test(v[0]) ? v[0].replace('Z', '').slice(0, 23) : '';
    binds.push([v[9], String(r[0]), upd, v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], v[10], v[11], v[12], v[13], v[14], v[15], v[16],
                v[17], v[18], v[19], v[20], v[21], v[22], v[23], v[24], cut(v[25], 100)]);
  }
  if(!binds.length) return { ok:true, imported:0 };
  return withConn(async c => {
    await c.executeMany(
      `MERGE INTO asdd_elector t
       USING (SELECT :1 epic, TO_NUMBER(:2) row_no,
                     TO_TIMESTAMP(:3, 'YYYY-MM-DD"T"HH24:MI:SS.FF3') updated_at,
                     :4 district, :5 ac_no, :6 ac_name, :7 ps, :8 part_name, :9 blo, :10 sno, :11 name, :12 rel_type, :13 rel_name,
                     :14 old_part, :15 old_serial, :16 age, :17 gender, :18 asdd_list_status, :19 status, :20 form6, :21 old_remarks,
                     :22 reason_no_f6, :23 enum_dates, :24 reverif_dates, :25 reason_ef, :26 refused_name, :27 refused_mobile FROM dual) s
       ON (t.epic = s.epic)
       WHEN MATCHED THEN UPDATE SET
         t.row_no = s.row_no, t.updated_at = s.updated_at, t.district = s.district, t.ac_no = s.ac_no, t.ac_name = s.ac_name,
         t.ps = s.ps, t.part_name = s.part_name, t.blo = s.blo, t.sno = s.sno, t.name = s.name, t.rel_type = s.rel_type,
         t.rel_name = s.rel_name, t.old_part = s.old_part, t.old_serial = s.old_serial, t.age = s.age, t.gender = s.gender,
         t.asdd_list_status = s.asdd_list_status, t.status = s.status, t.form6 = s.form6, t.old_remarks = s.old_remarks,
         t.reason_no_f6 = s.reason_no_f6, t.enum_dates = s.enum_dates, t.reverif_dates = s.reverif_dates,
         t.reason_ef = s.reason_ef, t.refused_name = s.refused_name, t.refused_mobile = s.refused_mobile
         WHERE t.updated_at IS NULL OR (s.updated_at IS NOT NULL AND s.updated_at >= t.updated_at)
       WHEN NOT MATCHED THEN INSERT
         (epic, row_no, updated_at, district, ac_no, ac_name, ps, part_name, blo, sno, name, rel_type, rel_name, old_part, old_serial,
          age, gender, asdd_list_status, status, form6, old_remarks, reason_no_f6, enum_dates, reverif_dates, reason_ef, refused_name, refused_mobile)
       VALUES (s.epic, s.row_no, s.updated_at, s.district, s.ac_no, s.ac_name, s.ps, s.part_name, s.blo, s.sno, s.name, s.rel_type, s.rel_name,
               s.old_part, s.old_serial, s.age, s.gender, s.asdd_list_status, s.status, s.form6, s.old_remarks, s.reason_no_f6,
               s.enum_dates, s.reverif_dates, s.reason_ef, s.refused_name, s.refused_mobile)`,
      binds, { bindDefs: Array.from({ length: 27 }, () => ({ type: oracledb.STRING, maxSize: MAX })) });
    await c.commit();
    sumCache = null;
    return { ok:true, imported: binds.length };
  });
}

/* ------------------------------------------------------------------ one-time: one date per field */
// Keeps only the first date in both visit-date columns. The full old value is kept once in *_orig columns,
// so nothing is lost. Safe to run any number of times.
async function fixDates(){
  return withConn(async c => {
    const have = await c.execute(`SELECT column_name FROM user_tab_columns WHERE table_name = 'ASDD_ELECTOR'`);
    const cols = new Set(have.rows.map(r => r.COLUMN_NAME));
    for(const col of ['enum_dates_orig', 'reverif_dates_orig'])
      if(!cols.has(col.toUpperCase())) await c.execute(`ALTER TABLE asdd_elector ADD (${col} VARCHAR2(1000))`);
    const out = {};
    for(const col of ['enum_dates', 'reverif_dates']){
      await c.execute(`UPDATE asdd_elector SET ${col}_orig = ${col} WHERE INSTR(${col}, ',') > 0 AND ${col}_orig IS NULL`);
      const r = await c.execute(`UPDATE asdd_elector SET ${col} = TRIM(REGEXP_SUBSTR(${col}, '[^,]+', 1, 1)) WHERE INSTR(${col}, ',') > 0`);
      out[col] = r.rowsAffected;
    }
    await c.commit();
    const left = await c.execute(`SELECT COUNT(*) n FROM asdd_elector WHERE INSTR(enum_dates, ',') > 0 OR INSTR(reverif_dates, ',') > 0`);
    sumCache = null;
    return { ok:true, fixed: out, stillMultiple: left.rows[0].N };
  });
}

/* ------------------------------------------------------------------ one-time: restore trimmed visit dates */
// Puts back the full multi-date values saved by fixDates() in *_orig – but only where the entry still holds
// exactly the first date that the cleanup left (i.e. nobody has changed that date since). Edited entries are skipped.
// The backup value is cleared once restored, so running this again changes nothing.
async function restoreDates(){
  return withConn(async c => {
    const have = new Set((await c.execute(`SELECT column_name FROM user_tab_columns WHERE table_name = 'ASDD_ELECTOR'`)).rows.map(r => r.COLUMN_NAME));
    if(!have.has('ENUM_DATES_ORIG')) return { ok:false, error:'no backup columns found' };
    const out = {};
    for(const col of ['enum_dates', 'reverif_dates']){
      const r = await c.execute(
        `UPDATE asdd_elector SET ${col} = ${col}_orig, ${col}_orig = NULL
         WHERE ${col}_orig IS NOT NULL AND TRIM(${col}) = TRIM(REGEXP_SUBSTR(${col}_orig, '[^,]+', 1, 1))`);
      const left = await c.execute(`SELECT COUNT(*) n FROM asdd_elector WHERE ${col}_orig IS NOT NULL`);
      out[col] = { restored: r.rowsAffected, skippedEditedSince: left.rows[0].N };
    }
    await c.commit();
    sumCache = null;
    return { ok:true, ...out };
  });
}

/* ------------------------------------------------------------------ one-time: log times in IST */
// The database clock is UTC. Makes the "at" column of both logs store Indian time (UTC+5:30):
// new rows get IST by default, and rows already written are shifted +5:30 exactly once
// (a column comment "IST" marks a table as done, so running this again changes nothing).
async function fixTz(){
  return withConn(async c => {
    const out = {};
    for(const t of ['ASDD_SAVE_LOG', 'ASDD_EDIT_LOG']){
      const ex = await c.execute(`SELECT COUNT(*) n FROM user_tables WHERE table_name = :t`, [t]);
      if(!ex.rows[0].N){ out[t.toLowerCase()] = 'table not created yet'; continue; }
      const cm = await c.execute(`SELECT comments FROM user_col_comments WHERE table_name = :t AND column_name = 'AT'`, [t]);
      if(cm.rows.length && cm.rows[0].COMMENTS === 'IST'){ out[t.toLowerCase()] = 'already IST'; continue; }
      await c.execute(`ALTER TABLE ${t} MODIFY (at DEFAULT CAST(SYSTIMESTAMP AT TIME ZONE 'Asia/Kolkata' AS TIMESTAMP))`);
      const r = await c.execute(`UPDATE ${t} SET at = at + INTERVAL '0 05:30:00' DAY TO SECOND WHERE at IS NOT NULL`);
      await c.execute(`COMMENT ON COLUMN ${t}.at IS 'IST'`);
      await c.commit();
      out[t.toLowerCase()] = r.rowsAffected + ' rows shifted to IST';
    }
    return { ok:true, ...out };
  });
}

/* ------------------------------------------------------------------ indexes */
// Creates the indexes the site's queries use (skips any that already exist) and refreshes table statistics.
async function optimize(){
  return withConn(async c => {
    const want = {
      ASDD_ELECTOR_STATUS: 'CREATE INDEX asdd_elector_status ON asdd_elector (status, ps)',
      ASDD_EDIT_LOG_EPIC:  'CREATE INDEX asdd_edit_log_epic ON asdd_edit_log (epic, at)',
      ASDD_EDIT_LOG_AT:    'CREATE INDEX asdd_edit_log_at ON asdd_edit_log (at)'
    };
    const have = new Set((await c.execute(`SELECT index_name FROM user_indexes`)).rows.map(r => r.INDEX_NAME));
    const created = [];
    for(const [name, sql] of Object.entries(want)) if(!have.has(name)){ await c.execute(sql); created.push(name.toLowerCase()); }
    await c.execute(`BEGIN DBMS_STATS.GATHER_TABLE_STATS(USER, 'ASDD_ELECTOR'); DBMS_STATS.GATHER_TABLE_STATS(USER, 'ASDD_EDIT_LOG'); END;`);
    const all = (await c.execute(`SELECT index_name, table_name FROM user_indexes WHERE table_name IN ('ASDD_ELECTOR','ASDD_EDIT_LOG') ORDER BY 2, 1`)).rows
      .map(r => r.TABLE_NAME.toLowerCase() + '.' + r.INDEX_NAME.toLowerCase());
    sumCache = null;
    return { ok:true, created, indexes: all };
  });
}

/* ------------------------------------------------------------------ diagnostics (no secrets returned) */
async function diag(){
  const pem = fixPem(process.env.ORACLE_WALLET_PEM), cs = connectString();
  const info = {
    user: process.env.ORACLE_USER || '(missing)',
    passwordSet: !!process.env.ORACLE_PASSWORD,
    walletPasswordSet: !!process.env.ORACLE_WALLET_PASSWORD,
    migrateKeySet: !!process.env.MIGRATE_KEY,
    pemBlocks: (pem.match(/-----BEGIN [^-]+-----/g) || []),
    pemLength: pem.length,
    connectStartsOk: /^\(description=/i.test(cs),
    connectEndsOk: /\)\s*$/.test(cs),
    connectHost: (cs.match(/host=([^)]+)/i) || [])[1] || '(not found)',
    connectPort: (cs.match(/port=([^)]+)/i) || [])[1] || '(not found)',
    connectService: ((cs.match(/service_name=([^)]+)/i) || [])[1] || '(not found)').replace(/^[^_]+_/, '…_'),
    region: process.env.VERCEL_REGION || ''
  };
  const t = Date.now();
  try{
    const c = await oracledb.getConnection({ user: process.env.ORACLE_USER || 'ADMIN', password: process.env.ORACLE_PASSWORD,
      connectString: cs, walletContent: pem, walletPassword: process.env.ORACLE_WALLET_PASSWORD, connectTimeout: 15 });
    await c.execute('SELECT 1 FROM dual'); await c.close();
    return { ok:true, connected:true, ms: Date.now() - t, info };
  }catch(e){
    return { ok:false, connected:false, ms: Date.now() - t, error: String(e && e.message || e), info };
  }
}

/* ------------------------------------------------------------------ handler */
const keyOk = k => !!process.env.MIGRATE_KEY && str(k) === str(process.env.MIGRATE_KEY);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if(req.method === 'OPTIONS'){ res.setHeader('Access-Control-Allow-Headers', 'Content-Type'); return res.status(204).end(); }
  const send = o => res.status(200).json(o);
  try{
    if(req.method === 'GET'){
      const q = req.query || {}, act = q.action || 'get';
      if(act === 'get')     return send(await getPS(str(q.ps)));
      if(act === 'summary') return send(await summary());
      if(act === 'resall')  return send(await resAll());
      if(act === 'count')   return send(await count());
      if(act === 'ping')    return send(await withConn(async c => { await c.execute('SELECT 1 FROM dual'); return { ok:true, v:3, db:true }; }));
      if(act === 'summarycheck') return send(await summaryCheck());
      if(act === 'restoredates') return send(await restoreDates());
      if(act === 'fixtz') return send(await fixTz());
      if(act === 'optimize') return send(await optimize());
      if(act === 'fixdates') return send(await fixDates());
      if(act === 'diag')    return send(await diag());
      if(act === 'setup')   return keyOk(q.key) ? send(await setup()) : send({ ok:false, error:'wrong key' });
      return send({ ok:false, error:'unknown action ' + act });
    }
    if(req.method === 'POST'){
      let body = req.body;
      if(typeof body === 'string') body = JSON.parse(body || '{}');
      if(Buffer.isBuffer(body)) body = JSON.parse(body.toString('utf8') || '{}');
      body = body || {};
      if(body.action === 'freeze')  return send({ ok:false, error:'Freeze is disabled' });
      if(body.action === 'migrate') return keyOk(body.key) ? send(await migrate(body.rows)) : send({ ok:false, error:'wrong key' });
      return send(await save(body, clientMeta(req)));
    }
    return res.status(405).json({ ok:false, error:'method not allowed' });
  }catch(err){
    const msg = String(err && err.message || err);
    // Connection-level problems are reported as "busy" so the website retries quietly
    const busy = /NJS-040|NJS-500|NJS-503|ORA-12516|ORA-12520|ORA-00018|ORA-03113|timeout/i.test(msg);
    return send({ ok:false, busy, error: msg });
  }
};
