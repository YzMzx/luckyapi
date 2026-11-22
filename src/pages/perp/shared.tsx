import { useId } from "react";
import type { ReactNode } from "react";

export function Table({
  title,
  columns,
  children,
}: {
  title: string;
  columns: string[];
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div
      role="region"
      tabIndex={0}
      aria-labelledby={id}
      className="mt-3 overflow-x-auto rounded-lg border border-border"
    >
      <table className="w-full whitespace-nowrap text-left text-sm tabular-nums [&_td]:px-3 [&_td]:py-2 [&_tr+tr]:border-t [&_tr+tr]:border-border">
        <caption id={id} className="sr-only">
          {title}
        </caption>
        <thead className="bg-[#182b3c] text-xs text-muted-foreground">
          <tr>
            {columns.map(c => (
              <th key={c} scope="col" className="px-3 py-2 font-semibold">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
