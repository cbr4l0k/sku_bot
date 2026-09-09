// A minimal .xlsx writer: enough of SpreadsheetML to hand an organizer a workbook.
//
// An .xlsx file is a ZIP of XML parts, and the parts a spreadsheet actually needs
// are few, so this is a couple hundred lines rather than a dependency in the image
// that only one maintenance script ever imports.
//
// Strings are written inline instead of through a shared-string table: the export
// is read once and thrown away, so the size saved is not worth the second pass.
import { deflateRawSync } from "node:zlib";

/** Numbers land in Excel as numbers and so can be summed; everything else is text. */
export type Cell = string | number | null | undefined;

export type Sheet = {
  /** Excel caps tab names at 31 chars and rejects []:*?/\ — both are handled here. */
  name: string;
  columns: string[];
  rows: Cell[][];
  /** Filter dropdowns on the header. Off for sheets that are not a table of records. */
  filter?: boolean;
};

const escapeXml = (value: string): string =>
  // Control characters are not representable in XML 1.0 at all, so they go rather
  // than being escaped: a stray one in a Telegram display name would otherwise
  // produce a workbook Excel refuses to open.
  value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** 0 -> A, 25 -> Z, 26 -> AA. */
const columnName = (index: number): string => {
  let name = "";
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1) name = String.fromCharCode(65 + (n % 26)) + name;
  return name;
};

const sheetName = (name: string, index: number): string => {
  const cleaned = name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31);
  return cleaned === "" ? `Sheet${index + 1}` : cleaned;
};

const cellXml = (ref: string, value: Cell, style: number): string => {
  if (value === null || value === undefined || value === "") return "";
  const s = style === 0 ? "" : ` s="${style}"`;
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  const text = escapeXml(String(value));
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
};

const rowXml = (cells: Cell[], rowNumber: number, style: number): string => {
  const body = cells.map((cell, index) => cellXml(`${columnName(index)}${rowNumber}`, cell, style)).join("");
  return `<row r="${rowNumber}">${body}</row>`;
};

/** Width in characters, from the widest value in the column, within sane bounds. */
const columnWidths = (sheet: Sheet): number[] =>
  sheet.columns.map((heading, index) => {
    let widest = heading.length;
    for (const row of sheet.rows) {
      const value = row[index];
      if (value === null || value === undefined) continue;
      const length = String(value).length;
      if (length > widest) widest = length;
    }
    return Math.min(60, Math.max(9, widest + 2));
  });

const worksheetXml = (sheet: Sheet): string => {
  const lastColumn = columnName(Math.max(0, sheet.columns.length - 1));
  const lastRow = sheet.rows.length + 1;
  const cols = columnWidths(sheet)
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join("");
  const body = sheet.rows.map((row, index) => rowXml(row, index + 2, 0)).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\
<dimension ref="A1:${lastColumn}${lastRow}"/>\
<sheetViews><sheetView workbookViewId="0">\
<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>\
</sheetView></sheetViews>\
<sheetFormatPr defaultRowHeight="15"/>\
<cols>${cols}</cols>\
<sheetData>${rowXml(sheet.columns, 1, 1)}${body}</sheetData>\
${sheet.filter === false ? "" : `<autoFilter ref="A1:${lastColumn}${lastRow}"/>`}\
</worksheet>`;
};

/** Two formats only: normal, and the bold used for the header row. */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>\
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>\
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>\
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>\
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>\
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>\
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>\
</styleSheet>`;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = (data: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

type Entry = { name: string; data: Uint8Array };

/** A ZIP archive, deflated, with no ZIP64 extensions — an export never gets near 4 GB. */
const zip = (entries: Entry[]): Uint8Array => {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const compressed = new Uint8Array(deflateRawSync(entry.data));
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, 8, true); // deflate
    localView.setUint16(10, 0, true); // modification time
    localView.setUint16(12, 0x21, true); // modification date: 1980-01-01
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressed.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(10, 8, true); // deflate
    centralView.setUint16(12, 0, true); // modification time
    centralView.setUint16(14, 0x21, true); // modification date
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressed.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, end];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
};

/** Builds a workbook, one tab per sheet, with a frozen bold header and filters. */
export const buildXlsx = (sheets: Sheet[]): Uint8Array => {
  if (sheets.length === 0) throw new Error("A workbook needs at least one sheet.");
  const encoder = new TextEncoder();
  const names = sheets.map((sheet, index) => sheetName(sheet.name, index));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\
<Default Extension="xml" ContentType="application/xml"/>\
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>\
${sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}\
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>\
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\
<sheets>${names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>\
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\
${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join("")}\
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\
</Relationships>`;

  return zip([
    { name: "[Content_Types].xml", data: encoder.encode(contentTypes) },
    { name: "_rels/.rels", data: encoder.encode(rootRels) },
    { name: "xl/workbook.xml", data: encoder.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRels) },
    { name: "xl/styles.xml", data: encoder.encode(STYLES_XML) },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: encoder.encode(worksheetXml(sheet)),
    })),
  ]);
};
