// ─── calibration.ts 单元测试：在线系数学习（业务行为） ───
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  bucketKey,
  classifyChars,
  createCoefficientBook,
  createCoefficientFilter,
  driftAlarmed,
  featuresVector,
  predictTokens,
  PRIOR_COEFFICIENTS,
  type StepFeatures,
} from "../.opencode/plugins/opencode-tui-usage/model/calibration.ts"
import { PRIOR_COVARIANCE, PRIOR_INFLATION } from "../.opencode/plugins/opencode-tui-usage/model/prior.ts"

const feat = (over: Partial<{ letter: number; digit: number; punct: number; cjk: number; tool: number }> = {}): StepFeatures => ({
  counts: { letter: 0, digit: 0, punct: 0, cjk: 0, ...over },
  tools: over.tool ?? 0,
})

// ─── 字符分类 ───
test("classifyChars：字母/数字/标点分类，汉字与全角并入 cjk，空白不计", () => {
  const c = classifyChars("ab 12,你好ア　")
  assert.equal(c.letter, 2)
  assert.equal(c.digit, 2)
  assert.equal(c.cjk, 4) // 你好 + ア + 全角空格
  assert.ok(c.punct >= 1) // 逗号
})

test("classifyChars：换行与制表不计入任何类别（BPE 并入相邻 token）", () => {
  const c = classifyChars("\n\t\r ")
  assert.deepEqual(c, { letter: 0, digit: 0, punct: 0, cjk: 0 })
})

// ─── 预测 ───
test("predictTokens：按特征加权求和", () => {
  const coef = [1, 2, 3, 4, 10]
  assert.equal(predictTokens(coef, feat({ letter: 10, digit: 3, tool: 2 })), 10 * 1 + 3 * 2 + 2 * 10)
})

test("featuresVector：五个特征，工具调用次数单列一位", () => {
  assert.deepEqual(featuresVector(feat({ letter: 1, cjk: 5, tool: 3 })), [1, 0, 0, 5, 3])
})

// ─── 先验结构 ───
test("先验：点估计与协方差成对且维度一致", () => {
  assert.equal(PRIOR_COEFFICIENTS.length, 5)
  assert.equal(PRIOR_COVARIANCE.length, 5)
  for (const row of PRIOR_COVARIANCE) assert.equal(row.length, 5)
  // 对称
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      assert.ok(Math.abs(PRIOR_COVARIANCE[i][j] - PRIOR_COVARIANCE[j][i]) < 1e-12, `协方差应关于 (${i},${j}) 对称`)
    }
  }
})

test("先验：字母与标点保留负相关（此消彼长的耦合不得被对角化）", () => {
  const cov = (i: number, j: number) => PRIOR_COVARIANCE[i][j]
  const corr = cov(0, 2) / Math.sqrt(cov(0, 0) * cov(2, 2))
  assert.ok(corr < -0.8, `字母/标点相关系数 ${corr.toFixed(2)} 应保持强负相关`)
})

test("先验：膨胀系数落在实测安全区间的几何中点附近", () => {
  // 实测安全区间 [×4, ×16]，中点 8；×16 已出界
  assert.equal(PRIOR_INFLATION, 8)
})

// ─── 学习行为 ───
test("学习：合成数据下系数收敛到真实值", () => {
  const truth = [0.25, 1, 0.5, 0.75, 30]
  const f = createCoefficientFilter("test/model")
  for (let i = 0; i < 400; i++) {
    const step = feat({
      letter: 20 + (i % 17) * 3,
      digit: 2 + (i % 7),
      punct: 5 + (i % 5),
      cjk: i % 11,
      tool: i % 4,
    })
    const y = featuresVector(step).reduce((s, v, k) => s + v * truth[k], 0)
    f.observe(step, y)
  }
  let errSum = 0
  for (let i = 0; i < 50; i++) {
    const step = feat({ letter: 30 + i, digit: 3 + (i % 5), punct: 6, cjk: i % 7, tool: i % 3 })
    const truthY = featuresVector(step).reduce((s, v, k) => s + v * truth[k], 0)
    errSum += Math.abs(predictTokens(f.coefficient(), step) / truthY - 1)
  }
  assert.ok(errSum / 50 < 0.05, `平均相对误差 ${(errSum / 50 * 100).toFixed(1)}% 应 < 5%`)
})

test("学习：分桶互不污染——A 桶的学习不影响 B 桶", () => {
  const book = createCoefficientBook()
  const a = "providerA/modelX"
  const b = "providerB/modelY"
  const step = feat({ letter: 100, digit: 10, tool: 1 })
  for (let i = 0; i < 200; i++) book.observe(a, step, 500)
  for (let i = 0; i < 200; i++) book.observe(b, step, 50)
  const pa = predictTokens(book.coefficient(a), step)
  const pb = predictTokens(book.coefficient(b), step)
  assert.ok(pa > 300, `A 桶预测 ${pa.toFixed(0)} 应接近 500`)
  assert.ok(pb < 120, `B 桶预测 ${pb.toFixed(0)} 应接近 50`)
})

test("学习：切回用过的桶即时恢复，不重新学", () => {
  const book = createCoefficientBook()
  const key = "p/m"
  const step = feat({ letter: 50, tool: 1 })
  for (let i = 0; i < 150; i++) book.observe(key, step, 300)
  const learned = predictTokens(book.coefficient(key), step)
  for (let i = 0; i < 50; i++) book.observe("other/m2", step, 10)
  assert.equal(predictTokens(book.coefficient(key), step), learned, "切回后系数应完全一致")
})

test("学习：新桶从先验起步（未学习时等于先验预测）", () => {
  const book = createCoefficientBook()
  const step = feat({ letter: 100, digit: 10 })
  assert.equal(predictTokens(book.coefficient("brand/new"), step), predictTokens(PRIOR_COEFFICIENTS, step))
})

// ─── gate 与哨兵 ───
test("gate：野值被拒绝且不污染系数", () => {
  const f = createCoefficientFilter("test/gate")
  const step = feat({ letter: 200, digit: 5, tool: 1 })
  const truthY = predictTokens(f.coefficient(), step)
  for (let i = 0; i < 300; i++) f.observe(step, truthY * (1 + ((i % 5) - 2) * 0.01))
  const before = predictTokens(f.coefficient(), step)
  const accepted = f.observe(step, truthY * 10)
  assert.equal(accepted, false, "10 倍野值应被 gate 拒绝")
  assert.equal(predictTokens(f.coefficient(), step), before, "被拒绝的观测不得改变系数")
})

test("哨兵：暴露拒绝率、观测噪声与后验偏离", () => {
  const f = createCoefficientFilter("test/sentinel")
  const step = feat({ letter: 100, tool: 1 })
  for (let i = 0; i < 200; i++) f.observe(step, predictTokens(PRIOR_COEFFICIENTS, step) * (1 + ((i % 7) - 3) * 0.01))
  const s = f.sentinel()
  assert.ok(s.samples >= 200)
  assert.ok(s.rejectRate >= 0 && s.rejectRate < 0.2)
  assert.ok(Number.isFinite(s.c) && s.c > 0)
  assert.equal(s.driftInSe.length, 5)
  // 数据与先验一致 → 后验应停在膨胀上限以内（不触发告警）
  assert.equal(driftAlarmed(s), false, `后验偏离 ${s.maxDriftInSe.toFixed(1)} SE 不应告警`)
})

test("哨兵：持续偏离先验到膨胀上限以外时告警（部署漂移）", () => {
  const f = createCoefficientFilter("test/drift")
  const step = feat({ letter: 100, digit: 5, tool: 1 })
  // 真实值远高于先验预测（模拟工具开销完全不同的供应商）
  const farY = predictTokens(PRIOR_COEFFICIENTS, step) * 4
  for (let i = 0; i < 3000; i++) f.observe(step, farY)
  assert.equal(driftAlarmed(f.sentinel()), true, "持续漂移应触发后验偏离告警")
})

// ─── 验收回归：学习不得伤害精度，且必须能迁移 ───
test("验收：与先验一致的流量上，学习后不劣于固定先验", () => {
  // 用先验自身生成流量（模拟「当前环境就是拟合先验的环境」）
  const f = createCoefficientFilter("test/no-harm")
  let learnedErr = 0
  let fixedErr = 0
  let n = 0
  for (let i = 0; i < 120; i++) {
    const step = feat({
      letter: 40 + (i * 37) % 900,
      digit: (i * 13) % 80,
      punct: 10 + (i * 7) % 300,
      cjk: (i * 11) % 200,
      tool: i % 3,
    })
    const y = predictTokens(PRIOR_COEFFICIENTS, step)
    if (i >= 20) {
      learnedErr += Math.abs(predictTokens(f.coefficient(), step) / y - 1)
      fixedErr += Math.abs(predictTokens(PRIOR_COEFFICIENTS, step) / y - 1)
      n++
    }
    f.observe(step, y)
  }
  const learned = learnedErr / n
  const fixed = fixedErr / n
  assert.ok(learned <= fixed + 0.05, `学习后误差 ${(learned * 100).toFixed(1)}% 不应比固定先验 ${(fixed * 100).toFixed(1)}% 明显更差`)
})

test("验收：流量与先验不同时，系数会向真值迁移", () => {
  // 工具开销从先验 33.7 变成 15（不同供应商的 tool 模板）
  const truthTool = 15
  const f = createCoefficientFilter("test/migrate")
  const step = feat({ letter: 200, digit: 20, punct: 50, cjk: 30, tool: 2 })
  const trueY = 200 * PRIOR_COEFFICIENTS[0] + 20 * PRIOR_COEFFICIENTS[1] + 50 * PRIOR_COEFFICIENTS[2] + 30 * PRIOR_COEFFICIENTS[3] + 2 * truthTool
  for (let i = 0; i < 800; i++) f.observe(step, trueY)
  const learnedTool = f.coefficient()[4]
  // 必须朝真值方向移动（允许未完全收敛）
  assert.ok(learnedTool < PRIOR_COEFFICIENTS[4] - 2, `工具系数 ${learnedTool.toFixed(1)} 应从 ${PRIOR_COEFFICIENTS[4].toFixed(1)} 朝 ${truthTool} 迁移`)
  assert.ok(learnedTool > truthTool - 8, `工具系数 ${learnedTool.toFixed(1)} 不应越过真值 ${truthTool}`)
})

// ─── 与批量最小二乘对拍 ───
test("对拍：滤波终值与同批样本的批量最小二乘一致", () => {
  const rows: { step: StepFeatures; y: number }[] = []
  for (let i = 0; i < 300; i++) {
    const step = feat({ letter: 40 + ((i * 7) % 23) * 4, tool: i % 3 })
    const y = step.counts.letter * 0.25 + step.tools * 30 + ((i % 5) - 2) * 0.5
    rows.push({ step, y })
  }
  const f = createCoefficientFilter("test/ols")
  for (const r of rows) f.observe(r.step, r.y)

  const xs = rows.map((r) => [r.step.counts.letter, r.step.tools])
  const ys = rows.map((r) => r.y)
  const A = [[0, 0], [0, 0]]
  const b = [0, 0]
  for (let i = 0; i < xs.length; i++) {
    for (let p = 0; p < 2; p++) {
      for (let q = 0; q < 2; q++) A[p][q] += xs[i][p] * xs[i][q]
      b[p] += xs[i][p] * ys[i]
    }
  }
  const det = A[0][0] * A[1][1] - A[0][1] * A[1][0]
  const olsLetter = (b[0] * A[1][1] - A[0][1] * b[1]) / det

  const learned = f.coefficient()
  assert.ok(Math.abs(learned[0] - olsLetter) / olsLetter < 0.1, `字母系数 滤波 ${learned[0].toFixed(4)} vs OLS ${olsLetter.toFixed(4)}`)
})

test("bucketKey：provider/model 缺失也有稳定 key", () => {
  assert.equal(bucketKey("open-design", "deepseek-v4.1-flash"), "open-design/deepseek-v4.1-flash")
  assert.equal(bucketKey(undefined, undefined), "?/?")
})
