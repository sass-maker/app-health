import { lazy, Suspense, type ComponentProps } from 'react';
import type {
  DataTable as LibraryTable,
  DataTableSkeleton as LibrarySkeleton,
} from '@saas-maker/ui/components/data-table';
import { Skeleton, SkeletonContainer } from '@saas-maker/ui/components/skeleton';
import {
  DataTable as TestTable,
  DataTableSkeleton as TestSkeleton,
} from '@saas-maker/ui/components/data-table';

export type { DataColumn } from '@saas-maker/ui/components/data-table';

const AsyncTable = lazy(() =>
  import('@saas-maker/ui/components/data-table').then((module) => ({ default: module.DataTable })),
);
const AsyncSkeleton = lazy(() =>
  import('@saas-maker/ui/components/data-table').then((module) => ({
    default: module.DataTableSkeleton,
  })),
);

// Public pages do not need the table engine. Keep the synchronous unit-test
// surface while Vite removes the eager import from the production build.
const Table = (import.meta.env.MODE === 'test' ? TestTable : AsyncTable) as typeof LibraryTable;
const TableSkeleton = import.meta.env.MODE === 'test' ? TestSkeleton : AsyncSkeleton;

function TablePlaceholder({ rows = 5 }: { rows?: number }) {
  return (
    <SkeletonContainer>
      <Skeleton style={{ height: `${2.75 + (rows + 1) * 2.5}rem` }} />
    </SkeletonContainer>
  );
}

export const DataTable: typeof LibraryTable = (props) => {
  return (
    <Suspense fallback={<TablePlaceholder rows={props.data.length} />}>
      <Table {...props} />
    </Suspense>
  );
};

export function DataTableSkeleton(props: ComponentProps<typeof LibrarySkeleton>) {
  return (
    <Suspense fallback={<TablePlaceholder rows={props.rows ?? 8} />}>
      <TableSkeleton {...props} />
    </Suspense>
  );
}
