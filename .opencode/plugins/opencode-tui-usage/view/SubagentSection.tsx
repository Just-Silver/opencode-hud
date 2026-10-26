// ─── UI 层：子代理区块（纯展示） ───
// 配色固定取 theme.ts 调色板（opencode 主题色，不随宿主主题）。
// ⚠️ 响应式约束：组件函数体只执行一次，禁止 props 快照 const；
//    所有取值必须发生在 JSX 表达式位置（Solid 编译器包装为响应式 getter）。
// 布局见 docs/design-subagent-section.md：默认 1 行/条，展开补 2 行（模型 + 强度 / agent）。
/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, Index, Show, type JSX } from "solid-js"
import {
  headingOf,
  modelLabel,
  statusGlyph,
  statusLights,
  totalTokensText,
  visibleRows,
  type SubagentRow,
} from "../model/subagent.ts"
import { fmtElapsed, fmtPct, fmtTokens, truncateVisual } from "../shared/format.ts"
import { Collapsible } from "./Collapsible.tsx"
import { INPUT_COLOR, MUTED_COLOR, SECTION_SUBAGENT_TITLE, TEXT_COLOR, WARN_COLOR } from "./theme.ts"

// 侧边栏可用内宽：宿主 SESSION_SIDEBAR_WIDTH = 42（ui/layout.ts 硬编码）− 宿主 padding 4
// − 面板边框 2 − 内边距 2 = 34。宿主不支持调宽，所以这里是常量。
// 不要改成 onSizeChange 实测：首帧与组件重建时测量尚未就绪，兜底值 34 与实测 33
// 会让 headMax 在 15/16 间跳一次，标题在「拆…」与「拆分」之间闪。
const ROW_WIDTH = 34
// 行首：展开箭头 1 + 空格 1 + 状态点 1 + 空格 1
const LEAD = 4
// 右侧两列固定宽：耗时 6（`58m05s` 最长）+ 空格 1 + 总消耗 6（`350.5k`/`999.9k` 最长）
const ELAPSED_WIDTH = 6
const TOKENS_WIDTH = 6
const TAIL = ELAPSED_WIDTH + 1 + TOKENS_WIDTH
// 展开行：缩进 2 + 标签「模型」4 + 空格 1
const DETAIL_LEAD = 7

// 状态点：运行中绿、已停止黄（完成与中断共用黄色，避免无谓歧义）
export function statusColor(running: boolean): string {
  return running ? INPUT_COLOR : WARN_COLOR
}

// 单行：展开箭头 + 状态点/spinner + 标题（无标题回退 agent）+ 垫片 + 耗时 + tokens
function Row(props: {
  row: SubagentRow
  /** 动画帧号；由 Sidebar 的运行态心跳驱动 */
  frame: number
  onToggle: () => void
}): JSX.Element {
  // 名称列：预留 1 列与右侧数值列之间的间隔，否则满宽时两列会粘在一起
  const headMax = () => Math.max(4, ROW_WIDTH - LEAD - TAIL - 1)
  const detailMax = () => Math.max(4, ROW_WIDTH - DETAIL_LEAD)

  return (
    <box flexDirection="column">
      <box flexDirection="row" height={1} onMouseDown={props.onToggle}>
        <text fg={MUTED_COLOR}>{props.row.expanded ? "▼ " : "▶ "}</text>
        <text fg={statusColor(props.row.running)}>{statusGlyph(props.row.running, props.frame)} </text>
        <text fg={TEXT_COLOR}>{truncateVisual(headingOf(props.row), headMax())}</text>
        <box flexGrow={1} />
        <text fg={MUTED_COLOR}>{fmtElapsed(props.row.elapsedMs).padStart(ELAPSED_WIDTH)}</text>
        <text> </text>
        <text fg={TEXT_COLOR}>{fmtTokens(props.row.tokens).padStart(TOKENS_WIDTH)}</text>
      </box>
      <Show when={props.row.expanded}>
        <box flexDirection="column">
          {/* 行 1：完整标题。主行的标题必须截断才能给右侧数值列让位，
              展开时补一行不截断的，放不下由终端自动换行。 */}
          <Show when={props.row.title}>
            <box flexDirection="row">
              <text fg={MUTED_COLOR} wrapMode="none" flexShrink={0}>
                {"  标题 "}
              </text>
              <box flexGrow={1} minWidth={0}>
                {/* 中文标题没有空格分隔，word 模式不会断行；按字符断 */}
                <text fg={TEXT_COLOR} wrapMode="char">
                  {props.row.title}
                </text>
              </box>
            </box>
          </Show>
          {/* 行 2：模型 + 思考强度 */}
          <box flexDirection="row" height={1}>
            <text fg={MUTED_COLOR}>{"  模型 "}</text>
            <text fg={TEXT_COLOR}>
              {truncateVisual(modelLabel(props.row.modelID, props.row.variant), detailMax())}
            </text>
          </box>
          {/* 行 3：agent 类型（主行被标题占用，这里补上规格要求的 agent 项） */}
          <box flexDirection="row" height={1}>
            <text fg={MUTED_COLOR}>{"  代理 "}</text>
            <text fg={TEXT_COLOR}>{truncateVisual(props.row.agent, detailMax())}</text>
          </box>
          {/* 行 4：缓存命中率（与会话区块同一口径）；无数据时整行不渲染 */}
          <Show when={props.row.cacheRate !== undefined}>
            <box flexDirection="row" height={1}>
              <text fg={MUTED_COLOR}>{"  命中 "}</text>
              <text fg={TEXT_COLOR}>{fmtPct(props.row.cacheRate)}</text>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
}

// 标题行的状态指示灯：`● 3  ● 1`，**已停止在前、运行中在后**（用户指定顺序）。
// 圆点与数字之间留一个空格（贴死读作形状而非计数）；数量为 0 也显示，
// 否则「全停了」与「全在跑」在视觉上无法区分。
function StatusLights(props: { lights: { running: number; done: number } }): JSX.Element {
  return (
    <>
      <text> </text>
      <text fg={WARN_COLOR}>● </text>
      <text fg={WARN_COLOR}>{String(props.lights.done)}</text>
      <text>  </text>
      <text fg={INPUT_COLOR}>● </text>
      <text fg={INPUT_COLOR}>{String(props.lights.running)}</text>
    </>
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
  // 子代理多时默认只留 VISIBLE_DONE_ROWS 条已完成的，否则列表会一路把
  // 上方的用量/额度区块挤出视野（family() 不会移除已结束的子会话，只增不减）。
  const [showAllDone, setShowAllDone] = createSignal(false)
  const parts = createMemo(() => visibleRows(props.rows))
  // 「收起」两个对象一起收：只收逐条展开、留着折叠段全展开，读起来是没收干净
  const anythingExpanded = () => anyExpanded() || showAllDone()

  // 无子代理 → 整块不渲染（不给「无子代理」占位）
  return (
    <Show when={props.rows.length > 0}>
      <Collapsible
        title={SECTION_SUBAGENT_TITLE}
        badge={
          <Show when={statusLights(props.rows)}>
            {(lights) => <StatusLights lights={lights()} />}
          </Show>
        }
        actions={
          // 常驻：不可用时用弱化灰（与右侧合计同色），可用时提亮为正文白
          <text
            fg={anythingExpanded() ? TEXT_COLOR : MUTED_COLOR}
            onMouseDown={(event: { stopPropagation(): void }) => {
              if (!anythingExpanded()) return
              // 标题行整行是折叠开关，不拦住会连区块一起折叠
              event.stopPropagation()
              setShowAllDone(false)
              props.onCollapseAll()
            }}
          >
            {"收起"}
          </text>
        }
        aside={totalTokensText(props.rows)}
      >
        <box flexDirection="column">
          {/* Index 按位置复用节点：For 按引用比较，每秒重算的新对象会让整行销毁重建，
              导致用户在该区块选中/滚动的文字被刷新掉 */}
          <Index each={parts().head}>
            {(row) => (
              <Row row={row()} frame={props.frame} onToggle={() => props.onToggle(row().id)} />
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
                  <Row row={row()} frame={props.frame} onToggle={() => props.onToggle(row().id)} />
                )}
              </Index>
            </Show>
          </Show>
        </box>
      </Collapsible>
    </Show>
  )
}
