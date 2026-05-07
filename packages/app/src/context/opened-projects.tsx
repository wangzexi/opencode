import { createSimpleContext } from "@opencode-ai/ui/context"
import { createQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { createSdkForServer } from "@/utils/server"
import { useGlobalSDK } from "./global-sdk"
import { usePlatform } from "./platform"
import { useServer } from "./server"

export type ConfigProjectEntry = {
  worktree: string
  name?: string
  expanded?: boolean
  icon?: {
    color?: string
    override?: string
    emoji?: string
  }
  commands?: {
    start?: string
  }
}

function isLocalHost(url: string) {
  const host = url.replace(/^https?:\/\//, "").split(":")[0]
  if (host === "localhost" || host === "127.0.0.1") return "local"
}

export const { use: useOpenedProjects, provider: OpenedProjectsProvider } = createSimpleContext({
  name: "OpenedProjects",
  gate: false,
  init: () => {
    const server = useServer()
    const platform = usePlatform()
    const globalSDK = useGlobalSDK()
    const queryClient = useQueryClient()

    const [store, setStore, , ready] = persisted(
      Persist.global("opened-projects", ["opened-projects.v1"]),
      createStore({
        expanded: {} as Record<string, boolean>,
        lastProject: {} as Record<string, string>,
      }),
    )

    const getSdk = () => {
      const current = server.current
      if (!current) return
      return createSdkForServer({
        server: current.http,
        fetch: platform.fetch,
      })
    }

    const queryKey = createMemo(() => ["opened-projects", server.key] as const)

    const query = createQuery(() => ({
      queryKey: queryKey(),
      enabled: ready() && !!server.key && !!server.current && server.healthy() === true,
      refetchOnWindowFocus: true,
      queryFn: async () => {
        const sdk = getSdk()
        if (!sdk) return []
        const res = await sdk.global.project.opened.list()
        return Array.isArray(res.data) ? (res.data as ConfigProjectEntry[]) : []
      },
    }))

    const setEntries = (entries: ConfigProjectEntry[]) => {
      queryClient.setQueryData(queryKey(), entries)
    }

    const entries = createMemo(() => query.data ?? [])

    const list = createMemo(() =>
      entries().map((entry) => ({
        ...entry,
        expanded: store.expanded[entry.worktree] ?? true,
      })),
    )

    function lastProjectKey() {
      if (!server.key) return ""
      if (server.key === ("sidecar" as string)) return "local"
      if (isLocalHost(server.key)) return "local"
      return server.key
    }

    const unsub = globalSDK.event.on("global", (event) => {
      if (event.type !== "project.opened.updated") return
      void query.refetch()
    })
    onCleanup(unsub)

    return {
      ready: createMemo(() => ready() && !query.isPending),
      list,
      refresh() {
        return query.refetch()
      },
      open(directory: string) {
        if (entries().some((entry) => entry.worktree === directory)) return
        const next = [{ worktree: directory }, ...entries()]
        setEntries(next)
        setStore("expanded", directory, true)
        void getSdk()?.global.project.opened.open({ worktree: directory }).then((res) => {
          if (Array.isArray(res.data)) setEntries(res.data as ConfigProjectEntry[])
        })
      },
      close(directory: string) {
        const next = entries().filter((entry) => entry.worktree !== directory)
        setEntries(next)
        void getSdk()?.global.project.opened.close({ worktree: directory }).then((res) => {
          if (Array.isArray(res.data)) setEntries(res.data as ConfigProjectEntry[])
        })
      },
      expand(directory: string) {
        setStore("expanded", directory, true)
      },
      collapse(directory: string) {
        setStore("expanded", directory, false)
      },
      move(directory: string, toIndex: number) {
        const fromIndex = entries().findIndex((entry) => entry.worktree === directory)
        if (fromIndex === -1 || fromIndex === toIndex) return
        const next = [...entries()]
        const [item] = next.splice(fromIndex, 1)
        next.splice(toIndex, 0, item)
        setEntries(next)
        void getSdk()?.global.project.opened.reorder({ projects: next }).then((res) => {
          if (Array.isArray(res.data)) setEntries(res.data as ConfigProjectEntry[])
        })
      },
      updateMeta(directory: string, patch: { name?: string; icon?: { color?: string; override?: string } }) {
        const idx = entries().findIndex((entry) => entry.worktree === directory)
        if (idx === -1) return
        const current = entries()[idx]
        const next = [...entries()]
        next[idx] = {
          ...current,
          name: patch.name !== undefined ? patch.name : current.name,
          icon: patch.icon !== undefined ? { ...current.icon, ...patch.icon } : current.icon,
        }
        setEntries(next)
        void getSdk()?.global.project.opened.meta({ worktree: directory, ...patch }).then((res) => {
          if (Array.isArray(res.data)) setEntries(res.data as ConfigProjectEntry[])
        })
      },
      last() {
        const key = lastProjectKey()
        if (!key) return
        return store.lastProject[key]
      },
      touch(directory: string) {
        const key = lastProjectKey()
        if (!key) return
        setStore("lastProject", key, directory)
      },
    }
  },
})
