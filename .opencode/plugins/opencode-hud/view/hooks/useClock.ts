// ─── ViewModel 片段：共享秒级时钟（HUD 心跳） ───
// 所有额度组共用一条 interval，不为每个供应商各开一个；首个消费者启动，最后一个退订即停
// （宿主按会话重建侧边栏，不释放会在切会话后留下多个计时器）。
// 值永远是 Date.now() 的绝对时刻：倒计时用「截止时刻 − now」算，定时器延迟或系统休眠
// 后自动对齐，不会像「每秒减一」那样累积漂移。
import { createSignal, onCleanup, type Accessor } from "solid-js"

const [nowMs, setNowMs] = createSignal(Date.now())

let consumers = 0
let timer: ReturnType<typeof setInterval> | undefined

function start() {
  if (timer !== undefined) return
  setNowMs(Date.now()) // 停过一段时间的旧值不能当成现在
  timer = setInterval(() => setNowMs(Date.now()), 1_000)
}

function stop() {
  if (timer === undefined) return
  clearInterval(timer)
  timer = undefined
}

/** 取共享时钟（每秒变化的绝对毫秒时间戳）；组件卸载时自动退订。 */
export function useSecondClock(): Accessor<number> {
  consumers++
  start()
  onCleanup(() => {
    consumers = Math.max(0, consumers - 1)
    if (consumers === 0) stop()
  })
  return nowMs
}
