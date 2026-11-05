/**
 * One-time copy of the Google Sheet "ASDD_Reverification" into the Oracle database.
 *
 * How to use:
 *  1. In the Sheet: Extensions → Apps Script → "+" next to Files → Script → name it MigrateToOracle.
 *  2. Paste this whole file, put your MIGRATE_KEY (the same text you saved in Vercel) below, save (⌘S).
 *  3. Choose the function "migrateToOracle" in the toolbar and press Run. Allow the permission it asks for
 *     (it needs "connect to an external service" to send the rows to asddlist.vercel.app).
 *  4. Open "Execution log". It ends with "DONE". If it says "PAUSED", just press Run again – it continues.
 *
 * Safe to run more than once: a row only replaces what is in Oracle if its "Last Updated" time is the same
 * or newer, so edits already made on the new site are never undone.
 */
const MIGRATE_KEY = 'PASTE_YOUR_MIGRATE_KEY_HERE';
const MIGRATE_API = 'https://asddlist.vercel.app/api/asdd';
const MIGRATE_BATCH = 2000;

function migrateToOracle(){
  if(MIGRATE_KEY.indexOf('PASTE_') === 0) throw new Error('Put your MIGRATE_KEY at the top of this file first.');
  const sh = SpreadsheetApp.getActive().getSheetByName('ASDD_Reverification');
  const n = Math.max(sh.getLastRow(), 1) - 1;
  const props = PropertiesService.getScriptProperties();
  const t0 = Date.now();
  let s = Number(props.getProperty('migrateNext') || 0), sent = 0;

  // Create the tables (does nothing if they already exist)
  const setup = JSON.parse(UrlFetchApp.fetch(MIGRATE_API + '?action=setup&key=' + encodeURIComponent(MIGRATE_KEY), { muteHttpExceptions:true }).getContentText());
  if(!setup.ok) throw new Error('Setup failed: ' + setup.error);

  for(; s < n; s += MIGRATE_BATCH){
    if(Date.now() - t0 > 4.5 * 60 * 1000){
      props.setProperty('migrateNext', String(s));
      Logger.log('PAUSED at sheet row ' + (s + 2) + ' of ' + (n + 1) + ' – press Run again to continue.');
      return;
    }
    const len = Math.min(MIGRATE_BATCH, n - s);
    const disp = sh.getRange(s + 2, 1, len, 26).getDisplayValues();
    const when = sh.getRange(s + 2, 1, len, 1).getValues();
    const rows = disp.map(function(r, i){
      const d = when[i][0];
      r[0] = (d instanceof Date && !isNaN(d)) ? d.toISOString() : '';
      return [s + 2 + i].concat(r);
    });
    let out, tries = 0;
    while(true){
      const resp = UrlFetchApp.fetch(MIGRATE_API, {
        method:'post', contentType:'application/json', muteHttpExceptions:true,
        payload: JSON.stringify({ action:'migrate', key:MIGRATE_KEY, rows:rows })
      });
      try{ out = JSON.parse(resp.getContentText()); }catch(e){ out = { ok:false, error:resp.getContentText().slice(0, 300) }; }
      if(out.ok || ++tries >= 3) break;
      Utilities.sleep(3000);
    }
    if(!out.ok){
      props.setProperty('migrateNext', String(s));
      throw new Error('Rows ' + (s + 2) + '-' + (s + 1 + len) + ' failed: ' + out.error + '  (press Run again to retry from here)');
    }
    sent += out.imported;
    Logger.log('Sheet rows ' + (s + 2) + '-' + (s + 1 + len) + ' copied (' + out.imported + ')');
  }
  props.deleteProperty('migrateNext');
  const c = JSON.parse(UrlFetchApp.fetch(MIGRATE_API + '?action=count', { muteHttpExceptions:true }).getContentText());
  Logger.log('DONE. Oracle now has ' + c.TOTAL + ' electors, ' + c.FILLED + ' filled (' + c.RESIDING + ' Residing, ' + c.ASDD + ' ASDD).');
}

// Run this only if you want to start the copy again from the first row
function migrateRestartFromTop(){ PropertiesService.getScriptProperties().deleteProperty('migrateNext'); Logger.log('Next run starts from the top.'); }
