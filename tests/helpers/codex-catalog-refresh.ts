/** Wait until the catalog refresh under this lease has completed and released it. */
export const waitForCatalogLeaseRelease = async (store: ReadonlyMap<string, unknown>, leaseKey: string): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!store.has(leaseKey)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("catalog refresh did not release its lease");
};
