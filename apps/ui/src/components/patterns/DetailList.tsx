import type { ReactNode } from "react";

import { Item, ItemContent, ItemDescription, ItemGroup } from "@/components/ui/item";

export interface DetailListItem {
  label: string;
  value: ReactNode;
}

/** Shared shadcn Item composition for compact label/value metadata. */
export function DetailList({ items }: { items: readonly DetailListItem[] }) {
  return (
    <ItemGroup className="divide-y">
      {items.map(({ label, value }) => (
        <Item key={label} size="sm" className="rounded-none border-0">
          <ItemContent className="max-w-(--sz-10rem) flex-none">
            <ItemDescription>{label}</ItemDescription>
          </ItemContent>
          <ItemContent className="min-w-0 text-foreground">{value}</ItemContent>
        </Item>
      ))}
    </ItemGroup>
  );
}
