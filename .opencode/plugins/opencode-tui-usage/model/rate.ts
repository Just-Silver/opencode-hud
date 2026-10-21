// ─── 模型层：实时速率的卡尔曼估计（纯逻辑，可单测） ───
// 状态 [累计 token, 速率]，观测是每批采样时的累计估算 token。
//
// 关键设计（见 docs/design-performance-footer.md §7.7）：
//   速率是「跳变过程」而非「平滑漂移」——工具调用、步结束、新内容段都会让它跳。
//   因此 Q=0（不建模连续漂移），改由「可观测事件」触发 P 重置为冷启动先验。
//   事件之间速率近似恒定这一假设，已用真实日志验证：最优小 Q 对应每 250ms 波动
//   约 0.05 tok/s（相对中位 193 的 0.03%），即步内漂移统计上为零。
//
// 无待调参数：Q 来自「事件间恒定」，P 重置量来自「冷启动先验」，事件集合来自架构。

// 状态维度固定为 2（累计 token / 速率）
const STATE_DIM = 2
// 冷启动先验方差：表示「速率完全未知」
const PRIOR_VARIANCE = 1e4
// 观测噪声初值（方差）：估算分子的失配误差，置信度随样本自适应
const INITIAL_OBS_VARIANCE = 4
// 新息 EMA 的平滑系数（变化检测用；报警阈值属误报预算，非滤波参数）
const INNOV_EMA_ALPHA = 0.15

export type RateSample = { at: number; tok: number }

export type RateEstimate = {
  rate: number
  // 估计可信度（速率方差），可用于诊断
  variance: number
}

export type RateFilter = {
  update(sample: RateSample): RateEstimate
  // 可观测事件：速率先验作废，P 重置回冷启动先验（幂等）
  reset(): void
  // 变化检测：归一化新息 EMA 持续超阈时返回 true（漏检事件的安全网）
  driftDetected(): boolean
  estimate(): RateEstimate | undefined
}

export function createRateFilter(): RateFilter {
  let x = [0, 0]
  let P: number[][] = [
    [PRIOR_VARIANCE, 0],
    [0, PRIOR_VARIANCE],
  ]
  let obsVariance = INITIAL_OBS_VARIANCE
  let prevAt: number | undefined
  let last: RateEstimate | undefined
  // 归一化新息的 EMA：用于 detectDrift（轻量 CUSUM 的等价物）
  let innovEma = 0
  let innovEmaVar = 0

  return {
    update(sample) {
      if (prevAt === undefined) {
        // 首个观测：直接立状态，不产生速率信息
        prevAt = sample.at
        x = [sample.tok, 0]
        return { rate: 0, variance: P[1][1] }
      }
      const dt = Math.max(1, sample.at - prevAt) / 1000
      prevAt = sample.at

      // 预测（匀速：token += rate·dt，rate 不变，Q=0）
      const xp = [x[0] + dt * x[1], x[1]]
      const Pp = [
        [P[0][0] + dt * (P[1][0] + P[0][1]) + dt * dt * P[1][1], P[0][1] + dt * P[1][1]],
        [P[1][0] + dt * P[1][1], P[1][1]],
      ]

      // 更新（H = [1, 0]）
      const S = Pp[0][0] + obsVariance
      const K = [Pp[0][0] / S, Pp[1][0] / S]
      const innov = sample.tok - xp[0]
      x = [xp[0] + K[0] * innov, xp[1] + K[1] * innov]
      P = [
        [Pp[0][0] - K[0] * Pp[0][0], Pp[0][1] - K[0] * Pp[0][1]],
        [Pp[1][0] - K[1] * Pp[0][0], Pp[1][1] - K[1] * Pp[0][1]],
      ]

      // 数值保护：对称化 + 保持非负
      for (let i = 0; i < STATE_DIM; i++) {
        for (let j = i + 1; j < STATE_DIM; j++) {
          const m = (P[i][j] + P[j][i]) / 2
          P[i][j] = m
          P[j][i] = m
        }
      }
      for (let i = 0; i < STATE_DIM; i++) if (!Number.isFinite(P[i][i]) || P[i][i] < 0) P[i][i] = 1e-9

      // 变化检测：归一化新息（按 S 归一）
      const z = innov / Math.sqrt(Math.max(1e-9, S))
      innovEma = innovEma * (1 - INNOV_EMA_ALPHA) + z * INNOV_EMA_ALPHA
      innovEmaVar = innovEmaVar * (1 - INNOV_EMA_ALPHA) + z * z * INNOV_EMA_ALPHA

      last = { rate: Math.max(0, x[1]), variance: P[1][1] }
      return last
    },

    reset() {
      // 幂等：反复重置等价于一次重置
      P = [
        [PRIOR_VARIANCE, 0],
        [0, PRIOR_VARIANCE],
      ]
      // 累计 token 与观测噪声保留（观测尺度未变，只有速率先验作废）
      innovEma = 0
      innovEmaVar = 0
      if (last) last = { rate: last.rate, variance: PRIOR_VARIANCE }
    },

    driftDetected() {
      // 新息均值持续偏离 0（且方差已被自身归一）→ 模型假设失效
      // 阈值 3 对应「约 0.3% 误报」，属于心跳类健康监测阈值
      return Math.abs(innovEma) > 3
    },

    estimate() {
      return last
    },
  }
}
