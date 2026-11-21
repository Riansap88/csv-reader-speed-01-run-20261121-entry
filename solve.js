// Fast drop-in for csv-reader 1.0.0 (make.fun).
//
// Same answer as the reference for every input {text, header}:
// {columns, rows, errors}. Semantics (mirroring the reference exactly):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field opening with a quote runs to the next non-doubled quote; "" inside
//   is one quote; each CRLF or lone CR inside is read as LF; what follows the
//   closing quote up to the next comma/line-break is appended as-is
//   (quote_junk, when the field ends); a quote that never closes is a literal
//   char and the text after it is re-read as unquoted (unterminated_quote).
// - A quote inside an unquoted field is a literal char. Fields stay strings.
// - columns = first record when header is true else null; rows = the rest
//   (every record when header is false), each padded with "" (short_row, with
//   fields: its field count) or cut (long_row, with extra: the cut fields) to
//   the first record's width.
// - Each error is {code, line, row}, in the order met; a record's short_row /
//   long_row when it ends. line = 1-based line its record starts on, counting
//   every LF, CRLF and lone CR inside quotes; row = its index in rows, null
//   for the header.
//
// Speed strategy (vs the reference's per-character loop with per-character
// string concatenation): bulk native scans. Unquoted fields are found with
// one regex scan for ',', LF and CR and sliced in one go; whole records
// with no quote and no stray CR are split natively with String.split;
// quoted fields locate their closing quote with indexOf and only walk
// character by character over segments that actually contain a line break.
// Nothing is kept from one run() call to the next.

const DELIM_RE = /[,\n\r]/g;
const QC_RE = /["\r]/g;

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const s = String(input.text);
  const header = input.header === true;
  const n = s.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (n > 0 && s.charCodeAt(0) === 0xfeff) pos = 1;

  // Append s[a..b) to value, reading each CRLF or lone CR inside it as one
  // LF and counting every line break into `line`. Fast path when the segment
  // holds no line break at all. Only used for quoted-field segments.
  function appendSegment(value, a, b) {
    const ni = s.indexOf('\n', a);
    if (ni === -1 || ni >= b) {
      const ri = s.indexOf('\r', a);
      if (ri === -1 || ri >= b) return value + s.slice(a, b);
    }
    let v = value;
    let i = a;
    while (i < b) {
      const c = s.charCodeAt(i);
      if (c === 13) {
        v += '\n';
        line += 1;
        i += s.charCodeAt(i + 1) === 10 ? 2 : 1;
      } else if (c === 10) {
        v += '\n';
        line += 1;
        i += 1;
      } else {
        let j = i + 1;
        while (j < b) {
          const d = s.charCodeAt(j);
          if (d === 13 || d === 10) break;
          j += 1;
        }
        v += s.slice(i, j);
        i = j;
      }
    }
    return v;
  }

  // Finish one record's fields: header capture, or short/long-row handling
  // and the push into rows. Returns true when the caller should continue
  // with the next record (always true; kept as a function to share the code
  // between the fast path and the general path).
  function finishRecord(fields, recordLine, recordRow) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = s.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && s.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // --- Fast path: a whole record with no quote and no stray CR. ---
    // Find the end of this line first; if no quote and no CR (other than a
    // trailing CRLF) occurs before it, the line holds only unquoted fields.
    const nl = s.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    QC_RE.lastIndex = pos;
    const qc = QC_RE.exec(s);
    const qcIdx = qc === null ? -1 : qc.index;
    const trailingCr = qc !== null && qc[0] === '\r' && nl !== -1 && qcIdx === lineEnd - 1;
    if (qcIdx === -1 || qcIdx >= lineEnd || trailingCr) {
      {
        const end = trailingCr ? lineEnd - 1 : lineEnd;
        const fields = s.slice(pos, end).split(',');
        if (nl === -1) {
          pos = n;
        } else {
          pos = nl + 1;
          line += 1;
        }
        // A single empty field here cannot happen (blank lines are skipped
        // above, and a lone-CR line is not a fast-path line), but keep the
        // reference's no-record rule for safety.
        if (fields.length === 1 && fields[0] === '') continue;
        finishRecord(fields, recordLine, recordRow);
        continue;
      }
    }

    // --- General path: field by field. ---
    const fields = [];
    let ended = END;
    let quoted = false;
    do {
      quoted = s.charCodeAt(pos) === 34;
      let value = '';
      let needUnquoted = !quoted;
      let junkMode = false;
      let initialLen = 0;

      if (quoted) {
        // Parse a quoted field. open/openLine let an unterminated quote be
        // re-read as unquoted, exactly as the reference does.
        const open = pos;
        const openLine = line;
        let segStart = pos + 1;
        let p = pos + 1;
        let closed = false;
        while (true) {
          const q = s.indexOf('"', p);
          if (q === -1) {
            // Never closes: literal quote, text after it re-read unquoted.
            pos = open + 1;
            line = openLine;
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            value = '"';
            initialLen = 1;
            needUnquoted = true;
            junkMode = false;
            break;
          }
          if (s.charCodeAt(q + 1) === 34) {
            // Doubled quote: segment + one quote, keep scanning.
            value = appendSegment(value, segStart, q);
            value += '"';
            p = q + 2;
            segStart = q + 2;
            continue;
          }
          value = appendSegment(value, segStart, q);
          pos = q + 1;
          closed = true;
          break;
        }
        if (closed) {
          if (pos >= n) {
            ended = END;
            needUnquoted = false;
          } else {
            const c = s.charCodeAt(pos);
            if (c === 44) {
              pos += 1;
              ended = COMMA;
              needUnquoted = false;
            } else if (c === 10) {
              pos += 1;
              line += 1;
              ended = LINE_BREAK;
              needUnquoted = false;
            } else if (c === 13 && s.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              ended = LINE_BREAK;
              needUnquoted = false;
            } else {
              // Junk follows the closing quote: appended as-is by the
              // unquoted scan below; quote_junk iff anything was kept.
              initialLen = value.length;
              needUnquoted = true;
              junkMode = true;
            }
          }
        }
      }

      if (needUnquoted) {
        // One unquoted scan, used for plain fields, for junk after a closing
        // quote, and for the re-read after an unterminated quote. Stray CRs
        // are dropped (stray_cr); CRLF ends the record as one line break.
        while (true) {
          DELIM_RE.lastIndex = pos;
          const dm = DELIM_RE.exec(s);
          let m = -1;
          let kind = -1;
          if (dm !== null) {
            m = dm.index;
            const dc = dm[0];
            kind = dc === ',' ? 0 : dc === '\n' ? 1 : 2;
          }
          if (m === -1) {
            value += s.slice(pos);
            pos = n;
            ended = END;
            break;
          }
          if (kind === 0) {
            value += s.slice(pos, m);
            pos = m + 1;
            ended = COMMA;
            break;
          }
          if (kind === 1) {
            value += s.slice(pos, m);
            pos = m + 1;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          // kind === 2: CR.
          if (s.charCodeAt(m + 1) === 10) {
            value += s.slice(pos, m);
            pos = m + 2;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          value += s.slice(pos, m);
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          pos = m + 1;
        }
        if (junkMode && value.length - initialLen > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
      }

      fields.push(value);
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    finishRecord(fields, recordLine, recordRow);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
