import type { Catalog, Feature } from '../lib/types'

async function read<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error('The puzzle could not be loaded. Please retry.')
  return response.json() as Promise<T>
}

export const loadCatalog = () => read<Catalog>('/puzzles/index.json')
export const loadFeature = (id: string) =>
  read<Feature>(`/puzzles/${encodeURIComponent(id)}.json`)
