import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Popover } from "@opencode-ai/ui/popover"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { useMutation, useQuery, useQueryClient } from "@tanstack/solid-query"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import type { Event } from "@opencode-ai/sdk/v2/client"

type ScheduleInfo = {
  id: string
  expression: string
  message: string
  nextRun: number | null
  lastRanAt: number | null
  lastRunStatus: "ran" | "skipped" | null
}

const SCHEDULE_QUERY_KEY = ["session", "schedules"] as const
const SCHEDULE_EVENTS = new Set(["schedule.created", "schedule.deleted", "schedule.ran"])

function formatRelativeTime(language: ReturnType<typeof useLanguage>, ts: number | null) {
  if (ts === null) return null
  return new Date(ts).toLocaleString(language.intl())
}

function scheduleEventSessionID(event: Event) {
  if (!SCHEDULE_EVENTS.has(event.type)) return
  const properties = event.properties
  if (!properties || typeof properties !== "object" || !("sessionID" in properties)) return
  const sessionID = properties.sessionID
  if (typeof sessionID === "string") return sessionID
}

export function SessionScheduleButton() {
  const language = useLanguage()
  const sdk = useSDK()
  const { params } = useSessionLayout()
  const queryClient = useQueryClient()
  const [shown, setShown] = createSignal(false)

  const sessionID = createMemo(() => params.id)

  createEffect(() => {
    const id = sessionID()
    if (!id) return

    const subscriptions = [...SCHEDULE_EVENTS].map((event) =>
      sdk.event.on(event as Event["type"], (payload) => {
        if (scheduleEventSessionID(payload) !== id) return
        queryClient.invalidateQueries({ queryKey: [...SCHEDULE_QUERY_KEY, id] })
      }),
    )
    onCleanup(() => subscriptions.forEach((unsubscribe) => unsubscribe()))
  })

  const schedulesQuery = useQuery(() => ({
    queryKey: [...SCHEDULE_QUERY_KEY, sessionID()],
    enabled: !!sessionID(),
    queryFn: async () => {
      const id = sessionID()
      if (!id) return [] as ScheduleInfo[]
      const result = await sdk.client.session.schedules({ sessionID: id })
      return ((result?.data as ScheduleInfo[] | undefined) ?? []) as ScheduleInfo[]
    },
    refetchInterval: 10_000,
    staleTime: 5_000,
  }))

  const deleteMutation = useMutation(() => ({
    mutationFn: async (scheduleID: string) => {
      const id = sessionID()
      if (!id) return
      await sdk.client.session.deleteSchedule({ sessionID: id, scheduleID })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...SCHEDULE_QUERY_KEY, sessionID()] })
    },
  }))

  const schedules = createMemo(() => schedulesQuery.data ?? [])
  const count = createMemo(() => schedules().length)

  return (
    <Show when={sessionID() && count() > 0}>
      <Popover
        open={shown()}
        onOpenChange={setShown}
        triggerAs={Button}
        triggerProps={{
          variant: "ghost",
          class: "titlebar-icon w-8 h-6 p-0 box-border",
          "aria-label": language.t("schedule.button.label", { count: count() }),
          style: { scale: 1 },
        }}
        trigger={
          <div class="relative flex items-center justify-center">
            <Icon name="clock" size="small" />
            <Show when={count() > 1}>
              <span class="absolute -top-1 -right-2 min-w-3.5 h-3.5 px-1 rounded-full bg-icon-info-base text-text-invert-strong text-12-medium leading-none flex items-center justify-center">
                {count()}
              </span>
            </Show>
          </div>
        }
        class="[&_[data-slot=popover-body]]:p-0 w-[360px] max-w-[calc(100vw-40px)] bg-background-strong border border-border-weak-base shadow-lg rounded-xl"
        gutter={4}
        placement="bottom-end"
      >
        <Show when={shown()}>
          <div class="flex flex-col">
            <div class="px-4 py-3 border-b border-border-weak-base">
              <div class="text-14-medium text-text-strong">{language.t("schedule.popover.title")}</div>
              <div class="text-12-regular text-text-weak mt-0.5">
                {language.t("schedule.popover.subtitle", { count: count() })}
              </div>
            </div>
            <div class="max-h-[400px] overflow-y-auto">
              <For each={schedules()}>
                {(item) => (
                  <ScheduleRow
                    item={item}
                    onDelete={() => deleteMutation.mutate(item.id)}
                    deleting={deleteMutation.isPending && deleteMutation.variables === item.id}
                  />
                )}
              </For>
            </div>
          </div>
        </Show>
      </Popover>
    </Show>
  )
}

function ScheduleRow(props: { item: ScheduleInfo; onDelete: () => void; deleting: boolean }) {
  const language = useLanguage()
  const lastRan = createMemo(() => formatRelativeTime(language, props.item.lastRanAt))
  const nextRun = createMemo(() => formatRelativeTime(language, props.item.nextRun))

  const tooltipContent = () => (
    <div class="flex flex-col gap-1 text-12-regular">
      <div class="flex items-center gap-2">
        <span class="text-text-invert-base">{language.t("schedule.tooltip.last")}</span>
        <Show
          when={lastRan()}
          fallback={<span class="text-text-invert-weak">{language.t("schedule.tooltip.never")}</span>}
        >
          <span class="text-text-invert-strong">{lastRan()}</span>
          <Show when={props.item.lastRunStatus === "skipped"}>
            <span class="text-icon-warning-base">{language.t("schedule.tooltip.skipped")}</span>
          </Show>
        </Show>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-text-invert-base">{language.t("schedule.tooltip.next")}</span>
        <Show
          when={nextRun()}
          fallback={<span class="text-text-invert-weak">{language.t("schedule.tooltip.never")}</span>}
        >
          <span class="text-text-invert-strong">{nextRun()}</span>
        </Show>
      </div>
    </div>
  )

  return (
    <div class="group flex items-start gap-2 px-4 py-3 border-b border-border-weak-base last:border-b-0 hover:bg-background-base">
      <div class="flex-1 min-w-0">
        <div class="font-mono text-12-regular text-text-weak mb-0.5">{props.item.expression}</div>
        <div class="text-12-regular text-text-base truncate" title={props.item.message}>
          {props.item.message}
        </div>
      </div>
      <Tooltip value={tooltipContent()} placement="left">
        <Button
          type="button"
          variant="ghost"
          class="size-5 opacity-60 hover:opacity-100"
          aria-label={language.t("schedule.row.info")}
        >
          <Icon name="help" size="small" />
        </Button>
      </Tooltip>
      <Button
        type="button"
        variant="ghost"
        class="size-5 opacity-0 group-hover:opacity-100 transition-opacity"
        aria-label={language.t("schedule.row.delete")}
        onClick={props.onDelete}
        disabled={props.deleting}
      >
        <Icon name="close" size="small" />
      </Button>
    </div>
  )
}
