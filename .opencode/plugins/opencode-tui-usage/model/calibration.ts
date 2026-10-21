// ─── 模型层：token 估算系数的在线学习（纯逻辑，可单测） ───
// 口径见 docs/design-performance-footer.md §7：
//   真实token ≈ Σ cᵢ·字符数ᵢ + c_tool·工具调用次数
// 系数按 providerID/modelID 分桶在线学习（卡尔曼 Q=0，等价于递归最小二乘），
// R = ĉ·ŷ（γ=1：方差随预测量线性增长，计数型失配的默认假设），ĉ 用 MAD 在线估。
// 全部状态只存内存，不读写磁盘。

import {
  PRIOR_COEFFICIENTS,
  PRIOR_COVARIANCE,
} from "./prior.ts"

export { PRIOR_COEFFICIENTS }

// 五个特征：英文字母、数字、标点、CJK（汉字+全角）、工具调用次数。
// 汉字与全角合并：实测两者相关系数 0.98（中文内容里全角标点总跟着汉字出现），
// 数学上无法分别识别，学习会在「汉字↑全角↓」的方向上乱跑。
export const FEATURE_NAMES = ["letter", "digit", "punct", "cjk", "tool"] as const

export type CharCounts = {
  letter: number
  digit: number
  punct: number
  // 汉字 + 假名/全角/谚文（合并为一个共线组，见 FEATURE_NAMES 注释）
  cjk: number
}

export type Coefficients = readonly number[]

// 空白不计入：BPE 把空格并入相邻 token，实测拟合系数为负（无贡献）。
export function classifyChars(text: string): CharCounts {
  const out: CharCounts = { letter: 0, digit: 0, punct: 0, cjk: 0 }
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c >= 0x4e00 && c <= 0x9fff) out.cjk++
    else if (
      (c >= 0x3040 && c <= 0x30ff) ||
      (c >= 0x3000 && c <= 0x303f) ||
      (c >= 0xff00 && c <= 0xffef) ||
      (c >= 0xac00 && c <= 0xd7af)
    )
      out.cjk++
    else if (c === 0x20 || c === 0x0a || c === 0x09 || c === 0x0d) continue
    else if (c >= 0x30 && c <= 0x39) out.digit++
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) out.letter++
    else out.punct++
  }
  return out
}

// 一步的估算特征（供学习与预测共用）
export type StepFeatures = { counts: CharCounts; tools: number }

export function addFeatures(a: StepFeatures, counts: CharCounts, tools = 0): StepFeatures {
  return {
    counts: {
      letter: a.counts.letter + counts.letter,
      digit: a.counts.digit + counts.digit,
      punct: a.counts.punct + counts.punct,
      cjk: a.counts.cjk + counts.cjk,
    },
    tools: a.tools + tools,
  }
}

export function featuresVector(f: StepFeatures): number[] {
  return [f.counts.letter, f.counts.digit, f.counts.punct, f.counts.cjk, f.tools]
}

export function predictTokens(coef: Coefficients, f: StepFeatures): number {
  const v = featuresVector(f)
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * (coef[i] ?? 0)
  return sum
}

// ── 在线估计器 ──

const N = FEATURE_NAMES.length
// 观测噪声标量的下限：防止 ĉ 塌成 0 使 gate 失效
const C_FLOOR = 1e-8
// ĉ 的平滑系数：约 100 条观测的时间常数
const C_EMA_ALPHA = 0.01
// ĉ 估计窗口：MAD 需要一簇样本才有意义
const C_WINDOW = 100
// 冷启动步数：此期间观测噪声取固定权重，避免 ĉ 与 θ 互相依赖导致震荡
const WARMUP = 100
// gate 阈值：归一化新息超过 3 倍 σ 视为野值（重尾，实测 p99/p50=4.1）
const GATE_SIGMA = 3
// 后验偏离哨兵的告警线：偏离先验超过「膨胀上限」个标准误即异常
// （见 PRIOR_INFLATION 注释：超出它说明该部署的真实不确定度大于假设）
const DRIFT_ALERT_INFLATION = 8

export type Sentinel = {
  // gate 拒绝率：结构性变化（如供应商静默换分词器）会使其飙升
  rejectRate: number
  // 当前观测噪声标量
  c: number
  // 已学习的观测条数
  samples: number
  // 各系数后验相对先验的偏离，单位为「先验的 1 个标准误」。
  // 正常应停在个位数；持续超过 PRIOR_INFLATION 说明该部署漂移超出先验假设。
  driftInSe: number[]
  // driftInSe 的最大值（便于只上报一个数）
  maxDriftInSe: number
}

export type CoefficientFilter = {
  readonly key: string
  coefficient(): Coefficients
  sentinel(): Sentinel
  // 喂入一条「真实 token 已知」的观测；返回是否被 gate 接受
  observe(f: StepFeatures, actualTokens: number): boolean
  // 与批量最小二乘对拍用（样本 ≥ 特征数才有意义）
  stats(): { theta: number[]; samples: number }
}

export function createCoefficientFilter(
  key: string,
  prior: Coefficients = PRIOR_COEFFICIENTS,
  priorCovariance: readonly (readonly number[])[] = PRIOR_COVARIANCE,
): CoefficientFilter {
  let theta = [...prior]
  // 初始协方差 = 先验协方差矩阵（含系数间的负相关项）。
  // 只填对角阵会让「字母↑标点↓」这类耦合被当成两个独立误差，滤波器在正交方向横跳。
  let P: number[][] = priorCovariance.map((row) => [...row])
  let cHat: number | undefined
  let samples = 0
  let rejected = 0
  const innovations: number[] = []
  // 先验的 1-SE（用于后验偏离度量），从协方差对角线反推
  const priorSe = Array.from({ length: N }, (_, i) => Math.sqrt(Math.abs(priorCovariance[i]?.[i] ?? 1)))

  const mad = (values: number[]): number => {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const median = sorted[Math.floor((sorted.length - 1) / 2)]
    const dev = values.map((v) => Math.abs(v - median))
    dev.sort((a, b) => a - b)
    return dev[Math.floor((dev.length - 1) / 2)] * 1.4826
  }

  const driftInSe = (): number[] =>
    theta.map((t, i) => (priorSe[i] > 0 ? Math.abs(t - prior[i]) / priorSe[i] : 0))

  return {
    key,
    coefficient: () => theta,
    sentinel: () => {
      const drift = driftInSe()
      return {
        rejectRate: samples > 0 ? rejected / samples : 0,
        c: cHat ?? 1,
        samples,
        driftInSe: drift,
        maxDriftInSe: drift.reduce((a, b) => Math.max(a, b), 0),
      }
    },
    stats: () => ({ theta: [...theta], samples }),

    observe(f, actualTokens) {
      const x = featuresVector(f)
      const yhat = x.reduce((s, xi, i) => s + xi * theta[i], 0)
      const innov = actualTokens - yhat
      // 归一化新息：除以 sqrt(ŷ) 后近似同方差（γ=1）
      const scale = Math.sqrt(Math.max(1, yhat))
      const eNorm = innov / scale

      samples++
      // gate：冷启动后，野值既不更新 θ 也不污染 ĉ
      const gated = cHat !== undefined && Math.abs(eNorm) > GATE_SIGMA * Math.sqrt(Math.max(C_FLOOR, cHat))
      if (gated) {
        rejected++
        return false
      }

      innovations.push(eNorm)
      if (innovations.length > C_WINDOW) innovations.shift()

      // R = ĉ·ŷ（γ=1）；冷启动期 ĉ 未建立，取 1
      const c = cHat === undefined ? 1 : Math.max(C_FLOOR, cHat)
      const R = c * Math.max(1, yhat)

      const Px = new Array(N).fill(0)
      for (let i = 0; i < N; i++) Px[i] = P[i].reduce((s, Pij, j) => s + Pij * x[j], 0)
      let denom = R
      for (let i = 0; i < N; i++) denom += x[i] * Px[i]
      if (Math.abs(denom) > 1e-12) {
        const K = Px.map((v) => v / denom)
        for (let i = 0; i < N; i++) theta[i] += K[i] * innov
        for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) P[i][j] -= K[i] * Px[j]
        // 数值保护：对称化 + 维持半正定
        for (let i = 0; i < N; i++) {
          for (let j = i + 1; j < N; j++) {
            const m = (P[i][j] + P[j][i]) / 2
            P[i][j] = m
            P[j][i] = m
          }
        }
        for (let i = 0; i < N; i++) if (!Number.isFinite(P[i][i]) || P[i][i] < 0) P[i][i] = 1e-12
      }

      // ĉ：冷启动用固定权重，之后用窗口内归一化新息的 MAD
      if (samples >= WARMUP && innovations.length >= 20) {
        const est = mad(innovations)
        if (Number.isFinite(est) && est > 0) cHat = cHat === undefined ? est : cHat * (1 - C_EMA_ALPHA) + est * C_EMA_ALPHA
      } else if (samples === WARMUP && innovations.length > 0) {
        const est = mad(innovations)
        if (Number.isFinite(est) && est > 0) cHat = est
      }
      return true
    },
  }
}

// ── 分桶：按 providerID/modelID 隔离 ──
// 不同供应商的分词器合并表不同，系数不可混用；切回用过的模型即时恢复。
// 纯内存，重启从先验重学（实测约 100 步收敛）。
const MAX_BUCKETS = 16

export type CoefficientBook = {
  coefficient(key: string): Coefficients
  observe(key: string, f: StepFeatures, actualTokens: number): boolean
  sentinel(key: string): Sentinel
  filter(key: string): CoefficientFilter
  keys(): string[]
}

export function bucketKey(providerID: string | undefined, modelID: string | undefined): string {
  return `${providerID ?? "?"}/${modelID ?? "?"}`
}

export function createCoefficientBook(): CoefficientBook {
  const buckets = new Map<string, CoefficientFilter>()
  const filter = (key: string): CoefficientFilter => {
    const hit = buckets.get(key)
    if (hit) {
      // 重新插入以维持 LRU 顺序
      buckets.delete(key)
      buckets.set(key, hit)
      return hit
    }
    if (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value
      if (oldest !== undefined) buckets.delete(oldest)
    }
    const created = createCoefficientFilter(key)
    buckets.set(key, created)
    return created
  }
  return {
    coefficient: (key) => filter(key).coefficient(),
    observe: (key, f, actual) => filter(key).observe(f, actual),
    sentinel: (key) => filter(key).sentinel(),
    filter,
    keys: () => [...buckets.keys()],
  }
}

// 该校验：后验偏离超过膨胀上限即视为「先验假设不适用于此部署」
export function driftAlarmed(s: Sentinel): boolean {
  return s.maxDriftInSe > DRIFT_ALERT_INFLATION
}
