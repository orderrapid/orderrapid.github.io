// Reading the Excel files people upload.
// Pure functions: they take rows (array of arrays) from SheetJS and
// return clean records, so the same code runs in the browser and in tests.

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Accepted column headings, compared without spaces/brackets/capitals.
export const COLUMNS = {
  sales: {
    date:   ['date', 'billdate', 'saledate', 'invoicedate'],
    time:   ['saledatetime', 'billdatetime', 'saletime', 'billtime', 'invoicetime', 'datetime', 'time'],
    bill:   ['billno', 'billnumber', 'invoiceno', 'invoicenumber', 'billnum'],
    mobile: ['mobileno', 'mobile', 'mobilenumber', 'phone', 'phoneno', 'customermobile'],
    name:   ['medicinesname', 'medicinename', 'itemname', 'productname', 'medicine'],
    pack:   ['packsize', 'pack'],
    qty:    ['totalquantitystrip', 'totalquantity', 'quantity', 'qty', 'qtystrip'],
    amount: ['totalinvoiceamount', 'invoiceamount', 'amount', 'netamount'],
  },
  stock: {
    name:  ['medicinesname', 'medicinename', 'itemname', 'productname', 'medicine'],
    pack:  ['packsize', 'pack'],
    loose: ['stockinloose', 'currentstockloose', 'loosestock', 'stockloose', 'closingstockloose',
            'loose', 'currentstock', 'stock'],
  },
  purchase: {
    date:   ['date', 'billdate', 'invoicedate', 'purchasedate'],
    bill:   ['billno', 'invoiceno', 'billnumber', 'invoicenumber', 'challanno'],
    dist:   ['distributorname', 'distributor', 'suppliername', 'supplier', 'partyname', 'party'],
    name:   ['medicinename', 'medicinesname', 'itemname', 'productname', 'medicine'],
    pack:   ['packsize', 'pack'],
    amount: ['invamount', 'invoiceamount', 'totalinvoiceamount', 'amount', 'netamount'],
    qty:    ['qty', 'quantity', 'totalquantity', 'qtystrip'],
    // optional: when the goods arrived (from the purchase register) — used for Turn Around Time
    arrival: ['arrivaltime', 'arrivaldatetime', 'arrivedat', 'entrytime', 'entrydatetime', 'receivedtime', 'receiveddatetime',
              'receivedat', 'inwardtime', 'inwarddatetime', 'grntime', 'grndatetime', 'deliverytime', 'deliverydatetime'],
  },
  details: {
    name:         ['medicinename', 'medicinesname', 'itemname', 'productname', 'medicine'],
    pack:         ['packsize', 'pack'],
    category:     ['category', 'shopbycategory', 'medicinecategory'],
    ailment:      ['typeofailment', 'ailment', 'ailmenttype', 'therapeuticailmenttype', 'therapeutictype'],
    brand:        ['brandname', 'brand'],
    manufacturer: ['manufacturer', 'manufacturername', 'companyname', 'company'],
    chronic:      ['chronic', 'type', 'chronicacute'],
  },
  dupes: {
    name:     ['itemname', 'medicinesname', 'medicinename', 'productname'],
    pack:     ['packsize', 'pack'],
    decision: ['decision', 'status', 'action'],
  },
  items: {
    name:  ['itemname', 'medicinesname', 'medicinename', 'productname', 'medicine'],
    pack:  ['packsize', 'pack'],
    loose: ['qtyinloose', 'looseperstrip', 'qtyloose', 'looseqty', 'loose'],
  },
};

const REQUIRED = {
  sales: ['date', 'bill', 'name', 'pack', 'qty'],
  stock: ['name', 'pack', 'loose'],
  items: ['name', 'pack', 'loose'],
  purchase: ['date', 'bill', 'dist', 'name', 'pack', 'qty'],
  dupes: ['name', 'pack', 'decision'],
  details: ['name', 'pack'],
};
// besides the required columns, a sheet must have at least one of these
const ANY_OF = { details: ['category', 'ailment', 'brand', 'manufacturer', 'chronic'] };

// Some exports have a title block above the real headings (row 7 in the
// daily report), so look through the first 25 rows for the heading row.
export function findColumns(rows, kind) {
  const spec = COLUMNS[kind];
  for (let r = 0; r < Math.min(rows.length, 25); r++) {
    const cells = (rows[r] || []).map(norm);
    const map = {};
    for (const [field, aliases] of Object.entries(spec)) {
      // aliases are in priority order; the first matching column wins
      for (const a of aliases) {
        const idx = cells.indexOf(a);
        if (idx !== -1) { map[field] = idx; break; }
      }
    }
    if (REQUIRED[kind].every((f) => f in map) && (!ANY_OF[kind] || ANY_OF[kind].some((f) => f in map))) return { headerRow: r, map };
  }
  const want = REQUIRED[kind].map((f) => spec[f][0]).join(', ');
  throw new Error(`Could not find the column headings. The file needs columns like: ${want}.`);
}

const pad = (n) => String(n).padStart(2, '0');

// Excel stores some dates as numbers (days since 1900) and, in the same
// column, others as text like "08/04/2026". Text is always day first.
export function toISODate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === 'number' && isFinite(v)) {
    if (v < 20000 || v > 80000) return null; // not a plausible date serial
    const ms = Math.round((Math.floor(v) - 25569) * 86400000);
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m.map(Number);
    if (y < 100) y += 2000;
    return valid(y, mo, d);
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  m = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-,]+(\d{4})/);
  if (m && months[m[2].toLowerCase()]) return valid(+m[3], months[m[2].toLowerCase()], +m[1]);
  return null;
}

// Time of sale as 'HH:MM:SS'. Accepts an Excel date-time number
// (46001.6 = 2:24 PM), a time-only number (0.6), or text like
// "08/04/2026 00:33:24", "14:35" or "2:35 PM".
export function toTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return `${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  if (typeof v === 'number' && isFinite(v)) {
    const frac = v - Math.floor(v);
    if (frac === 0 && v >= 1) return null; // a date with no time part
    const secs = Math.round(frac * 86400) % 86400;
    return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}:${pad(secs % 60)}`;
  }
  const m = String(v).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i);
  if (!m) return null;
  let h = +m[1];
  const mi = +m[2], se = +(m[3] || 0), ap = (m[4] || '').toLowerCase()[0];
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || mi > 59 || se > 59) return null;
  return `${pad(h)}:${pad(mi)}:${pad(se)}`;
}

function valid(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCDate() !== d) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[,\s₹]/g, ''));
  return isFinite(n) ? n : null;
}

const text = (v) => (v === null || v === undefined ? '' : String(v).trim());

function cleanMobile(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(Math.round(v)) : String(v);
  s = s.replace(/\D/g, '');
  if (s.length > 10 && (s.startsWith('91') || s.startsWith('0'))) s = s.slice(-10);
  return s;
}

// Skip the "-" totals line and fully blank lines.
const isJunk = (name) => name === '' || name === '-' || /^total/i.test(name);

export function parseSales(rows) {
  const { headerRow, map } = findColumns(rows, 'sales');
  const out = [];
  const problems = [];
  let first = null, last = null, noMobile = 0, withTime = 0;
  const bills = new Set(), medicines = new Set(), days = new Map();

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const n = text(row[map.name]);
    if (isJunk(n) && !row[map.bill]) continue;
    const d = toISODate(row[map.date]);
    const b = text(row[map.bill]);
    const q = toNumber(row[map.qty]);
    // time from the Sale Date Time column; if there isn't one, from the Date cell itself
    const t = toTime(map.time !== undefined ? row[map.time] : row[map.date]);
    const rec = {
      d, b, n, t,
      m: map.mobile !== undefined ? cleanMobile(row[map.mobile]) : '',
      p: text(row[map.pack]),
      q,
      a: map.amount !== undefined ? toNumber(row[map.amount]) : null,
    };
    if (!d || !b || !n || q === null) {
      if (problems.length < 50) problems.push({ row: r + 1, why: !d ? 'date not readable' : !b ? 'no bill number' : !n ? 'no medicine name' : 'quantity not a number', value: row });
      else problems.length++;
      continue;
    }
    if (!rec.m) noMobile++;
    if (t) withTime++;
    out.push(rec);
    if (!first || d < first) first = d;
    if (!last || d > last) last = d;
    bills.add(d + '|' + b);
    medicines.add(norm(n) + '|' + norm(rec.p));
    days.set(d, (days.get(d) || 0) + 1);
  }
  return {
    rows: out,
    summary: {
      lines: out.length, bills: bills.size, medicines: medicines.size, days: days.size,
      firstDate: first, lastDate: last, noMobile, withTime, problems: problems.length,
      perDay: [...days.entries()].sort(),
    },
    problems: problems.slice(0, 50),
    headerRow,
  };
}

function parseThreeColumns(rows, kind, field) {
  const { headerRow, map } = findColumns(rows, kind);
  const out = [];
  const problems = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const n = text(row[map.name]);
    if (isJunk(n)) continue;
    const l = toNumber(row[map.loose]);
    if (l === null || l < 0) {
      problems.push({ row: r + 1, why: `${field} missing or not a number`, value: row });
      continue;
    }
    out.push({ n, p: text(row[map.pack]), l });
  }
  return { rows: out, problems, headerRow };
}

export function parsePurchase(rows) {
  const { headerRow, map } = findColumns(rows, 'purchase');
  const out = [], problems = [];
  let first = null, last = null;
  const bills = new Set(), dists = new Set();
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const n = text(row[map.name]);
    if (isJunk(n) && !row[map.bill]) continue;
    const rec = {
      d: toISODate(row[map.date]), b: text(row[map.bill]), s: text(row[map.dist]).replace(/\s+/g, ' '),
      n, p: text(row[map.pack]), q: toNumber(row[map.qty]),
      a: map.amount !== undefined ? toNumber(row[map.amount]) : null,
    };
    // arrival time: a date+time, or just a time (then the bill date is used). Indian time.
    if (map.arrival !== undefined && rec.d) {
      const v = row[map.arrival], tm = toTime(v);
      const whole = typeof v === 'number' && Number.isInteger(v);   // a date with no time
      const day = typeof v === 'number' && v < 1 ? null : toISODate(v);   // time-only cells: use the bill date
      if (tm && !whole) rec.t = `${day && day >= '2000' ? day : rec.d}T${tm}+05:30`;
    }
    if (!rec.d || !rec.b || !rec.s || !n || rec.q === null) {
      if (problems.length < 50) problems.push({ row: r + 1, why: !rec.d ? 'date not readable' : !rec.b ? 'no bill number' : !rec.s ? 'no distributor' : !n ? 'no medicine name' : 'quantity not a number', value: row });
      continue;
    }
    out.push(rec);
    if (!first || rec.d < first) first = rec.d;
    if (!last || rec.d > last) last = rec.d;
    bills.add(rec.s + '|' + rec.b); dists.add(rec.s.toLowerCase());
  }
  return { rows: out, problems, headerRow,
    summary: { lines: out.length, bills: bills.size, distributors: dists.size, firstDate: first, lastDate: last, problems: problems.length,
      withArrival: out.filter((x) => x.t).length } };
}

export function parseDetails(rows) {
  const { headerRow, map } = findColumns(rows, 'details');
  const out = [];
  const col = (row, f) => (map[f] === undefined ? '' : text(row[map[f]]));
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const n = text(row[map.name]);
    if (isJunk(n)) continue;
    const c = col(row, 'category'), a = col(row, 'ailment'), b = col(row, 'brand'), m = col(row, 'manufacturer'), ch = col(row, 'chronic');
    // "Both / General" in a Type column means not chronic
    out.push({ n, p: text(row[map.pack]), c: c === '0' ? '' : c, a: a === '0' ? '' : a, b: b === '0' ? '' : b, m: m === '0' ? '' : m,
      ch: /^chronic$/i.test(ch) ? 'yes' : /both|general|acute/i.test(ch) ? 'no' : ch });
  }
  const found = ['category', 'ailment', 'brand', 'manufacturer', 'chronic'].filter((f) => f in map);
  return { rows: out, problems: [], headerRow, found };
}

export function parseDupes(rows) {
  const { headerRow, map } = findColumns(rows, 'dupes');
  const out = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const n = text(row[map.name]);
    if (isJunk(n)) continue;
    out.push({ n, p: text(row[map.pack]), x: text(row[map.decision]) });
  }
  return { rows: out, problems: [], headerRow };
}

export const parseStock = (rows) => parseThreeColumns(rows, 'stock', 'Stock in loose');
export const parseItemMaster = (rows) => parseThreeColumns(rows, 'items', 'Qty in Loose');

// Pick the sheet that actually holds the data (first sheet whose
// headings match), so multi-sheet workbooks work too.
export function pickSheet(XLSX, wb, kind) {
  const errors = [];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
    try { findColumns(rows, kind); return { sheet: name, rows }; }
    catch (e) { errors.push(e.message); }
  }
  throw new Error(errors[0] || 'The file is empty.');
}

export function parseWorkbook(XLSX, data, kind) {
  const wb = XLSX.read(data, { type: 'array', cellDates: false, cellFormula: false, cellHTML: false, cellStyles: false });
  const { sheet, rows } = pickSheet(XLSX, wb, kind);
  const parser = { sales: parseSales, stock: parseStock, items: parseItemMaster, purchase: parsePurchase, dupes: parseDupes, details: parseDetails }[kind];
  return { sheet, ...parser(rows) };
}
