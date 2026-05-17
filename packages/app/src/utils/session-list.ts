type SessionListData<T> =
  | T[]
  | {
      items?: T[]
    }
  | undefined

export function sessionListItems<T>(data: SessionListData<T>) {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.items)) return data.items
  return [] as T[]
}
