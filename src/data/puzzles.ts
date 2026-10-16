import type { Catalog, Feature } from '../lib/types'

async function read<T>(url: string): Promise<T> {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error('The puzzle could not be loaded. Please retry.')
  return response.json() as Promise<T>
}

let catalog: Promise<Catalog> | undefined
const features = new Map<string, Feature>()
const pending = new Map<string, Promise<Feature>>()

export const loadCatalog = () =>
  (catalog ??= read<Catalog>('/puzzles/index.json').catch((error) => {
    catalog = undefined
    throw error
  }))

export const cachedFeature = (id: string) => features.get(id) ?? null

export function loadFeature(id: string): Promise<Feature> {
  const cached = features.get(id)
  if (cached) return Promise.resolve(cached)
  if (!pending.has(id))
    pending.set(
      id,
      read<Feature>(`/puzzles/${encodeURIComponent(id)}.json`)
        .then((feature) => {
          features.set(id, feature)
          return feature
        })
        .finally(() => pending.delete(id)),
    )
  return pending.get(id)!
}
