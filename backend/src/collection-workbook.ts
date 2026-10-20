import ExcelJS from "exceljs";
import type { CollectionReport } from "./collection-report";

const cellLimit = 32000;
function textParts(value: string): string[] {
  const parts: string[] = [];
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + cellLimit, value.length);
    const code = value.charCodeAt(end - 1);
    if (end < value.length && code >= 0xd800 && code <= 0xdbff) end--;
    parts.push(value.slice(start, end));
    start = end;
  }
  return parts.length ? parts : [""];
}

export async function createCollectionWorkbook(report: CollectionReport) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "DailyBrief";
  workbook.title = `Rapport de collecte du ${report.date}`;
  for (const table of report.tables) {
    const [headers, ...rows] = table.rows;
    if (!headers) continue;
    // Excel limits text cells to 32,767 characters. Continue long fields in
    // adjacent columns instead of silently truncating descriptions or summaries.
    const cells = rows.map((row) => headers.map((_, index) => textParts(row[index] ?? "")));
    const spans = headers.map((_, index) =>
      cells.reduce((max, row) => Math.max(max, row[index]!.length), 1),
    );
    const sheet = workbook.addWorksheet(table.name, {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    sheet.columns = headers.flatMap((header, index) =>
      Array.from({ length: spans[index]! }, (_, part) => ({
        header: part ? `${header} (suite ${part + 1})` : header,
        width: /Résumé|Description|Motif|Erreur|Valeur|Avertissements|Pourquoi/.test(header)
          ? 70
          : /Source|Lien|Titre|Points clés/.test(header)
            ? 45
            : 25,
      })),
    );
    for (const row of cells) {
      // String values stay text, including titles beginning with =, +, - or @.
      // Never create formula, hyperlink, or external-link objects from article data.
      sheet.addRow(
        headers.flatMap((_, index) =>
          Array.from({ length: spans[index]! }, (_, part) => row[index]?.[part] ?? ""),
        ),
      );
    }
    sheet.eachRow((row, index) => {
      row.alignment = { vertical: "top", wrapText: true };
      if (index === 1) {
        row.font = { bold: true, color: { argb: "FFFFFFFF" } };
        row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF365B42" } };
        row.height = 32;
      }
    });
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: sheet.rowCount, column: sheet.columnCount },
    };
  }
  const content = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    filename: `DailyBrief-${report.date}-${report.runId.replace(/[^a-zA-Z0-9_-]/g, "")}.xlsx`,
    content,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}
