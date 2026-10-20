import { expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { createCollectionWorkbook } from "../src/collection-workbook";

test("creates a readable Excel attachment with frozen, filterable sheets and text cells", async () => {
  const data = ['=HYPERLINK("https://example.com","titre")', "+SUM(1,2)", "@test", "-1+1"];
  const attachment = await createCollectionWorkbook({
    runId: "run-1",
    date: "2026-10-20",
    tables: [
      { name: "Articles", rows: [["Titre", "Résumé", "Motif", "Description"], data] },
      {
        name: "Sources",
        rows: [
          ["Source", "Statut"],
          ["Flux RSS", "Échec"],
        ],
      },
      {
        name: "Exécution",
        rows: [
          ["Information", "Valeur"],
          ["Fuseau", "Europe/Paris"],
        ],
      },
    ],
  });
  expect(attachment.filename).toBe("DailyBrief-2026-10-20-run-1.xlsx");
  expect(attachment.contentType).toContain("spreadsheetml");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(attachment.content).buffer);
  expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
    "Articles",
    "Sources",
    "Exécution",
  ]);
  const sheet = workbook.getWorksheet("Articles")!;
  for (const [index, value] of data.entries()) {
    expect(sheet.getCell(2, index + 1).value).toBe(value);
    expect(sheet.getCell(2, index + 1).type).toBe(ExcelJS.ValueType.String);
  }
  expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  expect(sheet.autoFilter).toBeTruthy();
});

test("long fields continue in adjacent columns without losing text or splitting emoji", async () => {
  const description = "a".repeat(31999) + "😀" + "é".repeat(32000) + "FIN_IMPORTANTE";
  const attachment = await createCollectionWorkbook({
    runId: "test",
    date: "2026-10-20",
    tables: [
      {
        name: "Articles",
        rows: [
          ["Description", "Résumé"],
          [description, "Résumé fidèle"],
        ],
      },
    ],
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(attachment.content).buffer);
  const sheet = workbook.getWorksheet("Articles")!;
  expect(sheet.getCell("B1").value).toBe("Description (suite 2)");
  expect(sheet.getCell("C1").value).toBe("Description (suite 3)");
  expect(["A2", "B2", "C2"].map((cell) => sheet.getCell(cell).value).join("")).toBe(description);
  expect(sheet.getCell("D2").value).toBe("Résumé fidèle");
});
