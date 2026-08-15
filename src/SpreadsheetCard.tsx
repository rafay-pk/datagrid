import { useMemo, useRef, useState } from "react";
import type { SpreadsheetCard as SpreadsheetCardType } from "./types";

interface SpreadsheetCardProps {
  card: SpreadsheetCardType;
  focused: boolean;
  onChange: (card: SpreadsheetCardType) => void;
}

interface CellPosition {
  row: number;
  column: number;
}

interface ColumnRule {
  label: string;
  formula: string;
}

function columnName(index: number): string {
  let value = "";
  for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) {
    value = String.fromCharCode(65 + ((current - 1) % 26)) + value;
  }
  return value;
}

function columnIndex(name: string): number {
  return name.toUpperCase().split("").reduce((sum, character) => sum * 26 + character.charCodeAt(0) - 64, 0) - 1;
}

function dataColumnName(column: number): string {
  return column > 0 ? columnName(column - 1) : "";
}

function dataColumnIndex(name: string): number {
  return columnIndex(name) + 1;
}

function columnRule(value: string): ColumnRule | null {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) return null;
  return { label: value.slice(0, separator).trim(), formula: value.slice(separator + 1).trim() };
}

function evaluateMath(expression: string): string | null {
  if (!/^[\d+\-*/().\s]+$/.test(expression)) return null;
  try {
    const result = Function(`"use strict"; return (${expression})`)() as unknown;
    return typeof result === "number" && Number.isFinite(result) ? String(result) : null;
  } catch {
    return null;
  }
}

function numericCell(cells: string[][], row: number, column: number, visiting = new Set<number>()): number {
  if (row > 0 && column > 0) {
    const rule = columnRule(cells[0]?.[column] ?? "");
    if (rule && !visiting.has(column)) {
      const nextVisiting = new Set(visiting).add(column);
      return Number(evaluateRowFormula(rule.formula, row, cells, nextVisiting)) || 0;
    }
  }
  const raw = cells[row]?.[column] ?? "";
  if (raw.startsWith("=")) return Number(displayValue(raw, cells, visiting)) || 0;
  return Number(raw) || 0;
}

function rangeValues(reference: string, cells: string[][], visiting = new Set<number>()): number[] {
  const cellRange = reference.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  const columnRange = reference.match(/^([A-Z]+):([A-Z]+)$/i);
  const rowRange = reference.match(/^(\d+):(\d+)$/);
  const singleCell = reference.match(/^([A-Z]+)(\d+)$/i);
  const values: number[] = [];

  if (cellRange) {
    const startColumn = dataColumnIndex(cellRange[1]);
    const endColumn = dataColumnIndex(cellRange[3]);
    const startRow = Number(cellRange[2]);
    const endRow = Number(cellRange[4]);
    for (let row = Math.min(startRow, endRow); row <= Math.max(startRow, endRow); row += 1) {
      for (let column = Math.min(startColumn, endColumn); column <= Math.max(startColumn, endColumn); column += 1) {
        values.push(numericCell(cells, row, column, visiting));
      }
    }
  } else if (columnRange) {
    const start = dataColumnIndex(columnRange[1]);
    const end = dataColumnIndex(columnRange[2]);
    for (let row = 1; row < cells.length; row += 1) {
      for (let column = Math.min(start, end); column <= Math.max(start, end); column += 1) {
        values.push(numericCell(cells, row, column, visiting));
      }
    }
  } else if (rowRange) {
    const start = Number(rowRange[1]);
    const end = Number(rowRange[2]);
    for (let row = Math.min(start, end); row <= Math.max(start, end); row += 1) {
      for (let column = 1; column < (cells[row]?.length ?? 0); column += 1) {
        values.push(numericCell(cells, row, column, visiting));
      }
    }
  } else if (singleCell) {
    values.push(numericCell(cells, Number(singleCell[2]), dataColumnIndex(singleCell[1]), visiting));
  }
  return values;
}

function displayValue(value: string, cells: string[][], visiting = new Set<number>()): string {
  if (!value.startsWith("=")) return value;
  const aggregate = value.match(/^=(SUM|AVERAGE|MIN|MAX)\(([^)]+)\)$/i);
  if (aggregate) {
    const values = aggregate[2].split(/[,;]/).flatMap((reference) => rangeValues(reference.trim(), cells, visiting));
    if (!values.length) return "0";
    const operation = aggregate[1].toUpperCase();
    if (operation === "AVERAGE") return String(values.reduce((sum, current) => sum + current, 0) / values.length);
    if (operation === "MIN") return String(Math.min(...values));
    if (operation === "MAX") return String(Math.max(...values));
    return String(values.reduce((sum, current) => sum + current, 0));
  }

  const expression = value.slice(1).replace(/\b([A-Z]+)(\d+)\b/gi, (_, column, row) =>
    String(numericCell(cells, Number(row), dataColumnIndex(column), visiting)));
  return evaluateMath(expression) ?? value;
}

function evaluateRowFormula(formula: string, row: number, cells: string[][], visiting = new Set<number>()): string {
  const expression = formula
    .replace(/\b([A-Z]+)(\d+)\b/gi, (_, column, referencedRow) =>
      String(numericCell(cells, Number(referencedRow), dataColumnIndex(column), visiting)))
    .replace(/\b([A-Z]+)\b/gi, (_, column) =>
      String(numericCell(cells, row, dataColumnIndex(column), visiting)));
  return evaluateMath(expression) ?? formula;
}

function shownValue(cells: string[][], row: number, column: number, focused: boolean): string {
  const value = cells[row]?.[column] ?? "";
  if (row === 0 && column > 0) return focused ? value : columnRule(value)?.label ?? value;
  if (row > 0 && column > 0) {
    const rule = columnRule(cells[0]?.[column] ?? "");
    if (rule) return evaluateRowFormula(rule.formula, row, cells, new Set([column]));
  }
  return focused ? value : displayValue(value, cells);
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function spreadsheetToCsv(card: SpreadsheetCardType): string {
  const cells = Array.from({ length: card.rows }, (_, row) =>
    Array.from({ length: card.columns }, (_, column) => card.cells[row]?.[column] ?? ""));
  const values = cells.map((row, rowIndex) =>
    row.map((_, column) => shownValue(cells, rowIndex, column, false)));

  let lastRow = -1;
  let lastColumn = -1;
  values.forEach((row, rowIndex) => row.forEach((value, column) => {
    if (value === "") return;
    if (rowIndex > lastRow) lastRow = rowIndex;
    if (column > lastColumn) lastColumn = column;
  }));
  if (lastRow === -1 || lastColumn === -1) return "";

  return values
    .slice(0, lastRow + 1)
    .map((row) => row.slice(0, lastColumn + 1).map(csvField).join(","))
    .join("\r\n");
}

export function SpreadsheetCard({ card, focused, onChange }: SpreadsheetCardProps) {
  const [activeCell, setActiveCell] = useState<CellPosition | null>(null);
  const activeInputRef = useRef<HTMLInputElement | null>(null);
  const cells = useMemo(
    () => Array.from({ length: card.rows }, (_, row) =>
      Array.from({ length: card.columns }, (_, column) => card.cells[row]?.[column] ?? "")),
    [card.cells, card.columns, card.rows],
  );

  const updateCell = (row: number, column: number, value: string) => {
    const next = cells.map((values) => [...values]);
    next[row][column] = value;
    onChange({ ...card, cells: next });
  };

  const appendReference = (cellReference: string, columnReference: string, asRange: boolean) => {
    if (!activeCell) return false;
    const current = cells[activeCell.row]?.[activeCell.column] ?? "";
    const headerFormula = activeCell.row === 0 && activeCell.column > 0 && current.includes("=");
    if (!current.startsWith("=") && !headerFormula) return false;
    const reference = headerFormula ? columnReference : cellReference;
    const nextValue = !headerFormula && asRange && /[A-Z]+\d+$/i.test(current)
      ? `${current}:${reference}`
      : `${current}${reference}`;
    updateCell(activeCell.row, activeCell.column, nextValue);
    requestAnimationFrame(() => activeInputRef.current?.focus());
    return true;
  };

  const addRow = () => onChange({
    ...card,
    rows: card.rows + 1,
    cells: [...cells.map((row) => [...row]), Array.from({ length: card.columns }, () => "")],
  });

  const addColumn = () => onChange({
    ...card,
    columns: card.columns + 1,
    cells: cells.map((row) => [...row, ""]),
  });

  const deleteRow = () => {
    if (card.rows <= 2) return;
    const row = activeCell && activeCell.row > 0 ? activeCell.row : card.rows - 1;
    onChange({ ...card, rows: card.rows - 1, cells: cells.filter((_, index) => index !== row) });
    setActiveCell(null);
  };

  const deleteColumn = () => {
    if (card.columns <= 2) return;
    const column = activeCell && activeCell.column > 0 ? activeCell.column : card.columns - 1;
    onChange({
      ...card,
      columns: card.columns - 1,
      cells: cells.map((row) => row.filter((_, index) => index !== column)),
    });
    setActiveCell(null);
  };

  const activeCalculated = Boolean(
    activeCell && activeCell.row > 0 && activeCell.column > 0 && columnRule(cells[0]?.[activeCell.column] ?? ""),
  );
  const activeValue = activeCell
    ? shownValue(cells, activeCell.row, activeCell.column, activeCalculated ? false : true)
    : "";
  const activeName = !activeCell
    ? "Cell"
    : activeCell.row === 0 && activeCell.column === 0
      ? "Header"
      : activeCell.row === 0
        ? `${dataColumnName(activeCell.column)} header`
        : activeCell.column === 0
          ? `Row ${activeCell.row} header`
          : `${dataColumnName(activeCell.column)}${activeCell.row}`;

  return (
    <div className={`sheet-card-content${focused ? " is-focused" : ""}`}>
      {focused && (
        <div className="sheet-formula-bar">
          <span className="formula-name">{activeName}</span>
          <span className="formula-fx">fx</span>
          <input
            aria-label="Formula bar"
            value={activeValue}
            readOnly={activeCalculated}
            placeholder="Select a cell, then enter a value or formula"
            onInput={(event) => {
              if (activeCell && !activeCalculated) updateCell(activeCell.row, activeCell.column, event.currentTarget.value);
            }}
          />
          <button type="button" onClick={addRow}>+ Row</button>
          <button type="button" title="Delete the selected row" onClick={deleteRow} disabled={card.rows <= 2}>− Row</button>
          <button type="button" onClick={addColumn}>+ Column</button>
          <button type="button" title="Delete the selected column" onClick={deleteColumn} disabled={card.columns <= 2}>− Column</button>
        </div>
      )}
      <div
        className={`sheet-editor${focused ? " is-focused" : ""}`}
        style={{ gridTemplateColumns: `${focused ? "38px " : ""}repeat(${card.columns}, minmax(84px, 1fr))` }}
      >
        {focused && <div className="sheet-label corner-label" />}
        {focused && Array.from({ length: card.columns }, (_, column) => (
          <button
            type="button"
            className={`sheet-label column-label${activeCell?.row === 0 && activeCell.column === column && column > 0 ? " is-selected" : ""}`}
            key={`column-${column}`}
            title={column > 0 ? `Select column ${dataColumnName(column)}` : undefined}
            onPointerDown={(event) => {
              if (column <= 0) return;
              if (appendReference(`${dataColumnName(column)}:${dataColumnName(column)}`, dataColumnName(column), event.shiftKey)) {
                event.preventDefault();
              } else {
                setActiveCell({ row: 0, column });
              }
            }}
          >{dataColumnName(column)}</button>
        ))}
        {cells.flatMap((rowValues, row) => [
          ...(focused ? [
            <button
              type="button"
              className={`sheet-label row-label${activeCell?.column === 0 && activeCell.row === row && row > 0 ? " is-selected" : ""}`}
              key={`row-${row}`}
              title={row > 0 ? `Select row ${row}` : undefined}
              onPointerDown={(event) => {
                if (row <= 0) return;
                if (appendReference(`${row}:${row}`, String(row), event.shiftKey)) {
                  event.preventDefault();
                } else {
                  setActiveCell({ row, column: 0 });
                }
              }}
            >{row > 0 ? row : ""}</button>,
          ] : []),
          ...rowValues.map((value, column) => {
            const calculated = row > 0 && column > 0 && Boolean(columnRule(cells[0]?.[column] ?? ""));
            const header = row === 0 || column === 0;
            return (
              <input
                key={`${row}-${column}`}
                ref={activeCell?.row === row && activeCell.column === column ? activeInputRef : undefined}
                className={`sheet-cell${header ? " header-cell" : ""}${calculated ? " calculated-cell" : ""}`}
                value={shownValue(cells, row, column, focused)}
                readOnly={!focused || calculated}
                onFocus={() => setActiveCell({ row, column })}
                onPointerDown={(event) => {
                  if (
                    focused && column > 0 && row > 0 && activeCell &&
                    (activeCell.row !== row || activeCell.column !== column) &&
                    appendReference(`${dataColumnName(column)}${row}`, dataColumnName(column), event.shiftKey)
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }}
                onInput={(event) => {
                  if (!calculated) updateCell(row, column, event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || (event.key === "ArrowDown" && !value.startsWith("="))) {
                    event.preventDefault();
                    const inputs = Array.from(event.currentTarget.closest(".sheet-editor")!.querySelectorAll<HTMLInputElement>("input"));
                    inputs[Math.min(inputs.length - 1, row * card.columns + column + card.columns)]?.focus();
                  }
                  if (event.key === "Tab" && !event.shiftKey && row === card.rows - 1 && column === card.columns - 1) {
                    event.preventDefault();
                    addRow();
                  }
                }}
              />
            );
          }),
        ])}
      </div>
    </div>
  );
}
