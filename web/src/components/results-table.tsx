import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type Row = Record<string, string | number | null>;

function isNumeric(v: unknown): v is number {
  return typeof v === "number";
}

// Numbers/ids render monospace + right-aligned; labels render normally.
export function ResultsTable({ columns, rows }: { columns: string[]; rows: Row[] }) {
  const numericCol = (col: string) => rows.length > 0 && isNumeric(rows[0][col]);

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {columns.map((col) => (
            <TableHead key={col} className={cn(numericCol(col) && "text-right")}>
              {col}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => (
          <TableRow key={i}>
            {columns.map((col) => {
              const v = row[col];
              const numeric = isNumeric(v);
              return (
                <TableCell
                  key={col}
                  className={cn(
                    numeric ? "text-right font-mono tabular-nums" : "text-foreground",
                    v === null && "text-muted-foreground",
                  )}
                >
                  {v === null ? "null" : numeric ? v.toLocaleString() : v}
                </TableCell>
              );
            })}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
