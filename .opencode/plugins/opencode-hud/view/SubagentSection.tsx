// ─── UI 层：子代理卡片（运行中任务卡 + 已停止紧凑行） ───
// 两级结构：运行中 = 抬升底色 + 绿色左侧强调线 + 两行（标题 / 耗时 · 消耗）；
//           已停止 = 单行紧凑列表，结局点按 outcome 上色。
// 结局来自宿主 SessionInfo.outcome（succeeded/failed/interrupted），不用 running=false 推断成功。
// ⚠️ 响应式约束：组件函数体只执行一次，禁止 props 快照 const；
//    所有取值必须发生在 JSX 表达式位置（Solid 编译器包装为响应式 getter）。
/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, Index, Show, type JSX } from "solid-js"
import {
  AGENT_ELAPSED_WIDTH,
  AGENT_RUNNING_TITLE_MAX,
  AGENT_TITLE_MAX,
  AGENT_TOKENS_WIDTH,
} from "./layout.ts"
import {
  headingOf,
  statusGlyph,
  subagentCounts,
  totalTokensText,
  visibleRows,
  type SubagentRow,
  type SubagentState,
} from "../model/subagent.ts"
import { fmtElapsed, fmtPerf, fmtTokens, padStartVisual, truncateVisual } from "../shared/format.ts"
import { DashboardCard } from "./Card.tsx"
import { TaskInspector } from "./TaskInspector.tsx"
import {
  ERROR_COLOR,
  MUTED_COLOR,
  RAISED_COLOR,
  SECONDARY_COLOR,
  SECTION_SUBAGENT_TITLE,
  SUCCESS_COLOR,
  TEXT_COLOR,
  WARNING_COLOR,
} from "./theme.ts"

// 状态色（v3.1.0 约定）：运行中 = 绿，已停止 = 黄；失败仍红（红色只给真实错误）。
// 成功 / 中断 / 未知结局都属「已停止」，共用黄，不再按结局细分色阶。
export function stateColor(state: SubagentState): string {
  switch (state) {
    case "running":
      return SUCCESS_COLOR
    case "failed":
      return ERROR_COLOR
    case "succeeded":
    case "interrupted":
    case "stopped":
      return WARNING_COLOR
  }
}

// 运行中：抬升底色的三行任务卡（标题 / 耗时·消耗 / 首字·速度），左侧绿色强调线
function RunningRow(props: { row: SubagentRow; frame: number; onToggle: () => void }): JSX.Element {
  return (
    <box
      flexDirection="column"
      backgroundColor={RAISED_COLOR}
      border={["left"]}
      borderColor={stateColor("running")}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" height={1} onMouseDown={props.onToggle}>
        <text fg={stateColor("running")}>{statusGlyph(true, props.frame) + " "}</text>
        <text fg={TEXT_COLOR} wrapMode="none">
          <b>{truncateVisual(headingOf(props.row), AGENT_RUNNING_TITLE_MAX)}</b>
        </text>
        <box flexGrow={1} />
        <text fg={MUTED_COLOR}>{props.row.expanded ? "▾" : "▸"}</text>
      </box>
      <box flexDirection="row" height={1} onMouseDown={props.onToggle}>
        <text fg={SECONDARY_COLOR} wrapMode="none">
          {`${fmtElapsed(props.row.elapsedMs)} · ${fmtTokens(props.row.tokens)}`}
        </text>
      </box>
      {/* 首字/速度：还没有可算样本时整行不渲染（不画空行、不显示占位） */}
      <Show when={fmtPerf(props.row.ttftMs, props.row.tps)}>
        {(text) => (
          <box flexDirection="row" height={1} onMouseDown={props.onToggle}>
            <text fg={SECONDARY_COLOR} wrapMode="none">{text()}</text>
          </box>
        )}
      </Show>
      <Show when={props.row.expanded}>
        <TaskInspector row={props.row} />
      </Show>
    </box>
  )
}

// 已停止：单行紧凑列表（右侧数字列与运行中块外的行对齐）
function StoppedRow(props: { row: SubagentRow; onToggle: () => void }): JSX.Element {
  return (
    <box flexDirection="column">
      <box flexDirection="row" height={1} onMouseDown={props.onToggle}>
        <text fg={MUTED_COLOR}>{props.row.expanded ? "▼ " : "▶ "}</text>
        <text fg={stateColor(props.row.state)}>{statusGlyph(false, 0) + " "}</text>
        <text fg={SECONDARY_COLOR} wrapMode="none">
          {truncateVisual(headingOf(props.row), AGENT_TITLE_MAX)}
        </text>
        <box flexGrow={1} />
        <text fg={MUTED_COLOR}>{padStartVisual(fmtElapsed(props.row.elapsedMs), AGENT_ELAPSED_WIDTH)}</text>
        <text> </text>
        <text fg={SECONDARY_COLOR}>
          {padStartVisual(fmtTokens(props.row.tokens), AGENT_TOKENS_WIDTH)}
        </text>
      </box>
      <Show when={props.row.expanded}>
        <TaskInspector row={props.row} />
      </Show>
    </box>
  )
}

// 卡片头：左「● N 运行中  N 已停止  N 失败」/ 右「合计 X」（各取所需，不合并语义）。
// 计数区可收缩（flexShrink + minWidth 0）：33 列塞不下时先裁计数，右端信息始终可见。
function Counts(props: {
  counts: { running: number; stopped: number; failed: number }
  total?: string
  /** 有逐条展开或历史段全展开 */
  canCollapse: boolean
  onCollapse: () => void
}): JSX.Element {
  return (
    <box flexDirection="row" height={1}>
      <box flexDirection="row" flexShrink={1} minWidth={0}>
        {/* 运行中 / 已停止常驻，0 也显示：全停与全跑必须在计数行一眼能区分 */}
        <text fg={SUCCESS_COLOR} wrapMode="none">{`● ${props.counts.running} 运行中`}</text>
        <text> </text>
        <text fg={WARNING_COLOR} wrapMode="none">{`${props.counts.stopped} 已停止`}</text>
        <Show when={props.counts.failed > 0}>
          <text fg={ERROR_COLOR} wrapMode="none">{`  ${props.counts.failed} 失败`}</text>
        </Show>
      </box>
      <box flexGrow={1} />
      {/* 收起固定在卡片头：列表展开后其尾部可以很长，控件放表尾就得先滚到底。
          展开是临时态，此时右端让位给「收起」——两者同占 33 列会把计数裁掉。 */}
      <Show
        when={props.canCollapse}
        fallback={
          <Show when={props.total}>
            <text fg={MUTED_COLOR} wrapMode="none">合计</text>
            <text> </text>
            <text fg={SECONDARY_COLOR} wrapMode="none">{props.total}</text>
          </Show>
        }
      >
        <text
          fg={TEXT_COLOR}
          wrapMode="none"
          // 点击落在文本上会先起一段文本选区：这一行左边全是计数，选中就整行高亮。
          // 收起是操作不是内容，不参与选择。
          selectable={false}
          onMouseDown={(event: { stopPropagation(): void }) => {
            event.stopPropagation()
            props.onCollapse()
          }}
        >
          {"收起"}
        </text>
      </Show>
    </box>
  )
}

export function SubagentSection(props: {
  rows: readonly SubagentRow[]
  /** 动画帧号；由 Sidebar 的运行态心跳驱动 */
  frame: number
  onToggle: (id: string) => void
  onCollapseAll: () => void
}): JSX.Element {
  const anyExpanded = () => props.rows.some((row) => row.expanded)

  // 「还有 N 条已完成」折叠行的展开态：内存态，与逐条展开互不影响。
  // 子代理多时默认只留 VISIBLE_DONE_ROWS 条已完成的，否则列表会把上方卡片挤出视野。
  const [showAllDone, setShowAllDone] = createSignal(false)
  const parts = createMemo(() => visibleRows(props.rows))
  // 「收起」两个对象一起收：只收逐条展开、留着折叠段全展开，读起来是没收干净
  const anythingExpanded = () => anyExpanded() || showAllDone()
  const counts = createMemo(() => subagentCounts(props.rows))
  const total = createMemo(() => totalTokensText(props.rows))

  // 无子代理 → 整块不渲染（不给「无子代理」占位）
  return (
    <Show when={props.rows.length > 0}>
      <DashboardCard title={SECTION_SUBAGENT_TITLE}>
        <Counts
          counts={counts()}
          total={total()}
          canCollapse={anythingExpanded()}
          onCollapse={() => {
            setShowAllDone(false)
            props.onCollapseAll()
          }}
        />

        <box flexDirection="column">
          {/* Index 按位置复用节点：For 按引用比较，每秒重算的新对象会让整行销毁重建，
              导致用户在该区块选中/滚动的文字被刷新掉 */}
          <Index each={parts().head}>
            {(row) => (
              <Show
                when={row().running}
                fallback={<StoppedRow row={row()} onToggle={() => props.onToggle(row().id)} />}
              >
                <RunningRow row={row()} frame={props.frame} onToggle={() => props.onToggle(row().id)} />
              </Show>
            )}
          </Index>
          {/* 折叠行：条数为 0 时整行不渲染 */}
          <Show when={parts().tail.length > 0}>
            <box flexDirection="row" height={1} onMouseDown={() => setShowAllDone((v) => !v)}>
              <text fg={MUTED_COLOR}>{showAllDone() ? "▼ " : "▶ "}</text>
              <text fg={MUTED_COLOR}>{`还有 ${parts().tail.length} 条已完成`}</text>
            </box>
            <Show when={showAllDone()}>
              <Index each={parts().tail}>
                {(row) => (
                  <Show
                    when={row().running}
                    fallback={<StoppedRow row={row()} onToggle={() => props.onToggle(row().id)} />}
                  >
                    <RunningRow row={row()} frame={props.frame} onToggle={() => props.onToggle(row().id)} />
                  </Show>
                )}
              </Index>
            </Show>
          </Show>
        </box>
      </DashboardCard>
    </Show>
  )
}
