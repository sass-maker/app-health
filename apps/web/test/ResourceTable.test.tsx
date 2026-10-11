import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

afterEach(() => vi.unstubAllEnvs());

it('keeps an immediate skeleton while the production table runtime loads', async () => {
  vi.stubEnv('MODE', 'production');
  vi.resetModules();
  const { DataTable, DataTableSkeleton } = await import('../src/components/ResourceTable.js');
  const columns = [
    {
      id: 'name',
      header: 'name',
      value: (row: { name: string }) => row.name,
      sortable: false,
      hideable: false,
    },
  ];
  const { container, rerender } = render(<DataTableSkeleton columns={columns} rows={3} />);
  expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  await waitFor(() =>
    expect(container.querySelector('[data-slot="data-table-skeleton"]')).not.toBeNull(),
  );
  rerender(
    <DataTable
      columns={columns}
      data={[{ name: 'saved result' }]}
      getRowId={(row) => row.name}
      label="retained rows"
    />,
  );
  expect(await screen.findByRole('table', { name: 'retained rows' })).toBeTruthy();
  expect(screen.getByText('saved result')).toBeTruthy();
});
