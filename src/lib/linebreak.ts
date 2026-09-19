/**
 * 智能断行：基于 Unicode 字素簇的宽度计量 + 动态规划选点。
 *
 * 宽度规则：按字素簇（grapheme cluster）计数，East Asian Wide/Fullwidth 及常见
 * emoji / 几何符号等全角字符计 2，其余半角计 1；HTML（<…>）与 ASS（{…}）标签
 * 原样保留但宽度计 0，行首尾空白不计宽（排版时裁掉，标签保留）。
 *
 * 断点只选在空白或标点边界（标点之后、开括号之前）。已有手工换行可“锁定”为不可
 * 跨越的硬边界（每个物理行独立成段）；解锁时原换行降级为空白，允许跨行合并。
 *
 * 动态规划在“最多行数”内按字典序最小化：
 *   1) 超限宽度总量 Σmax(0, 行宽 − 上限)；
 *   2) 行宽差（各行距满宽的缺口平方和 Σmax(0, 上限 − 行宽)²；同一行数下等价于
 *      最小化行宽方差，跨行数比较时则优先填满、避免无谓多拆行）；
 *   3) 行首禁则（，。！？；：、）】》…）与行尾禁则（（【《…）出现次数；
 *   4) 行数（以上全部相同则越少越好，保证结果确定）。
 */

export interface BreakOptions {
  /** 每行最大显示宽度（全角 = 2，半角 = 1，标签不计） */
  maxWidth: number;
  /** 最多允许的行数 */
  maxLines: number;
  /** 锁定已有手工换行：换行符两侧不可合并，各自独立分行 */
  lockManual: boolean;
}

export type FailReason = 'overflow' | 'too-many-lines';

export interface BreakLine {
  text: string;
  width: number;
}

export interface BreakResult {
  /** 是否能在限制内完成（false 时 text/lines 为尽力而为的结果，不应用） */
  ok: boolean;
  text: string;
  lines: BreakLine[];
  reason?: FailReason;
  /** 无法在任何断点处分担的超宽量（最大不可断片段宽度 − 上限） */
  unavoidableOverflow: number;
  /** 最宽不可断片段宽度 */
  widestRun: number;
  /** 不限制行数时的最少可行行数（含锁定的手工分段） */
  minLines: number;
}

/* ---------------- 字素簇切分（优先 Intl.Segmenter，缺失时简易回退） ---------------- */

interface GraphemeSegment {
  segment: string;
  index: number;
}
interface GraphemeSegmenter {
  segment(input: string): Iterable<GraphemeSegment>;
}
interface GraphemeSegmenterCtor {
  new (locales?: string | string[], opts?: { granularity?: string }): GraphemeSegmenter;
}
const SegmenterCtor: GraphemeSegmenterCtor | undefined = (
  Intl as unknown as { Segmenter?: GraphemeSegmenterCtor }
).Segmenter;
const segmenter: GraphemeSegmenter | null = SegmenterCtor
  ? new SegmenterCtor(['zh', 'en'], { granularity: 'grapheme' })
  : null;

/** 简易字素簇回退：合并组合记号、变体选择符、肤色修饰、ZWJ 序列与区域指示符对。 */
function* fallbackClusters(s: string): Generator<GraphemeSegment> {
  const cps = Array.from(s);
  const offsets: number[] = [];
  let pos = 0;
  for (const cp of cps) {
    offsets.push(pos);
    pos += cp.length;
  }
  const isMark = (cp: string) => {
    const c = cp.codePointAt(0) ?? 0;
    return (
      (c >= 0x0300 && c <= 0x036f) ||
      (c >= 0xfe00 && c <= 0xfe0f) ||
      (c >= 0x1f3fb && c <= 0x1f3ff)
    );
  };
  const isRI = (cp: string) => {
    const c = cp.codePointAt(0) ?? 0;
    return c >= 0x1f1e6 && c <= 0x1f1ff;
  };
  for (let i = 0; i < cps.length; ) {
    const start = offsets[i];
    let j = i + 1;
    if (isRI(cps[i]) && j < cps.length && isRI(cps[j])) j++; // 🇨🇳 等旗帜对
    while (j < cps.length) {
      const prev = cps[j - 1].codePointAt(0);
      if (prev === 0x200d) {
        j++; // ZWJ 后的基字符并入本簇，其后续记号继续合并
        while (j < cps.length && isMark(cps[j])) j++;
        continue;
      }
      if (isMark(cps[j])) {
        j++;
        continue;
      }
      break;
    }
    yield { segment: cps.slice(i, j).join(''), index: start };
    i = j;
  }
}

interface Cluster {
  text: string;
  start: number;
}

function segmentClusters(s: string): Cluster[] {
  const segs = segmenter ? [...segmenter.segment(s)] : [...fallbackClusters(s)];
  return segs.map((g) => ({ text: g.segment, start: g.index }));
}

/* ---------------- 全角 / 半角宽度 ---------------- */

/** 全角码位区间（按起点排序，含常见 East Asian Ambiguous 符号与 emoji）。 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23f3],
  [0x23f8, 0x23fa],
  [0x2500, 0x259f], // 制表符 / 区块元素
  [0x25a0, 0x25ff], // 几何图形
  [0x2600, 0x27bf], // 杂项符号 / Dingbats
  [0x2934, 0x2935],
  [0x2b00, 0x2bff],
  [0x2e80, 0x303e], // CJK 部首 / 康熙 / CJK 符号
  [0x3041, 0x33ff], // 假名 / CJK 符号 / 带圈字符
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xa000, 0xa4cf], // 彝文
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3], // 韩文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f], // CJK 兼容形式 / 小字号标点
  [0xff01, 0xff60], // 全角 ASCII
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff], // emoji / 麻将牌 / 补充符号
  [0x20000, 0x3fffd], // CJK 扩展 B+
];

const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);

function isWideCodePoint(cp: number): boolean {
  let lo = 0;
  let hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = WIDE_RANGES[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/** 单个字素簇的显示宽度：以首个可见码位的全/半角为准，零宽连接符等不计。 */
function clusterWidth(cluster: string): number {
  for (const ch of cluster) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      ZERO_WIDTH.has(c) ||
      (c >= 0xfe00 && c <= 0xfe0f) || // 变体选择符
      (c >= 0x1f3fb && c <= 0x1f3ff) // 肤色修饰
    ) {
      continue;
    }
    return isWideCodePoint(c) ? 2 : 1;
  }
  return 0;
}

/* ---------------- 词法切分：标签 / 空白 / 字素 ---------------- */

interface Token {
  text: string;
  /** 显示宽度（标签为 0） */
  w: number;
  ws: boolean;
  tag: boolean;
}

const RE_TAG = /<[^>\n]{0,200}>|\{[^}\n]{0,200}\}/y;

function tokenize(section: string): Token[] {
  const clusters = segmentClusters(section);
  const at = new Map<number, Cluster>();
  for (const c of clusters) at.set(c.start, c);

  const tokens: Token[] = [];
  let pos = 0;
  while (pos < section.length) {
    RE_TAG.lastIndex = pos;
    const m = RE_TAG.exec(section);
    if (m && m.index === pos) {
      tokens.push({ text: m[0], w: 0, ws: false, tag: true });
      pos = RE_TAG.lastIndex;
      continue;
    }
    const cl = at.get(pos);
    if (!cl) {
      // 理论上不可达：回退为原始单字符
      tokens.push({ text: section[pos], w: 1, ws: /\s/.test(section[pos]), tag: false });
      pos++;
      continue;
    }
    tokens.push({ text: cl.text, w: clusterWidth(cl.text), ws: /^\s$/u.test(cl.text), tag: false });
    pos += cl.text.length;
  }
  return tokens;
}

const PUNCT_RE = /^\p{P}$/u;
const isPunctuation = (t: Token) => !t.tag && !t.ws && PUNCT_RE.test(t.text);

/** 行首禁则：闭合类标点不应出现在行首（含对应半角变体）。 */
const LINE_START_BAN = new Set(Array.from('，。！？；：、）】》”’』」〉.,!?;:)]}'));
/** 行尾禁则：开合类括号不应出现在行尾（含对应半角变体）。 */
const LINE_END_BAN = new Set(Array.from('（【《‘“『「〈([{'));

/** 计算纯文本行的显示宽度（标签按 0 计，首尾空白不计）。 */
export function displayWidth(line: string): number {
  const tokens = tokenize(line);
  let a = 0;
  let b = tokens.length;
  while (a < b && tokens[a].ws) a++;
  while (b > a && tokens[b - 1].ws) b--;
  let w = 0;
  for (let i = a; i < b; i++) w += tokens[i].w;
  return w;
}

/** 把已含换行的文本逐行量宽（用于预览已应用结果）。 */
export function measureLines(text: string): BreakLine[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => ({ text: line, width: displayWidth(line) }));
}

/* ---------------- 分段 ---------------- */

interface Section {
  tokens: Token[];
  /** 可作行首/行尾的 token 下标（含 0 与 T） */
  edges: number[];
  /** 相邻边界之间各不可断片段的行宽（trim 后） */
  runWidths: number[];
  /** 无可见字素（仅标签 / 空白），固定输出单行 */
  empty: boolean;
}

function buildSection(tokens: Token[]): Section {
  const T = tokens.length;
  const prefW = new Int32Array(T + 1);
  for (let i = 0; i < T; i++) prefW[i + 1] = prefW[i] + tokens[i].w;
  const isContent = (i: number) => i >= 0 && i < T && !tokens[i].tag && !tokens[i].ws;
  const nextContent = new Int32Array(T + 1);
  const prevContent = new Int32Array(T + 1);
  let nx = T;
  for (let i = T; i >= 0; i--) {
    if (isContent(i)) nx = i;
    nextContent[i] = nx;
  }
  let pv = -1;
  for (let i = 0; i <= T; i++) {
    prevContent[i] = pv;
    if (isContent(i)) pv = i;
  }

  const boundary = new Uint8Array(T + 1);
  boundary[0] = 1;
  boundary[T] = 1;
  for (let i = 1; i < T; i++) {
    let pi = i - 1;
    while (pi >= 0 && tokens[pi].tag) pi--; // 标签贴在行尾，不影响判断
    let ni = i;
    while (ni < T && tokens[ni].tag) ni++; // 标签贴在行首
    if (pi < 0 || ni >= T) continue;
    const prev = tokens[pi];
    const next = tokens[ni];
    // 空白边界（任一侧为空白）或标点边界（前为标点可断 / 后为开括号可断）
    if (prev.ws || next.ws || isPunctuation(prev) || LINE_END_BAN.has(next.text)) boundary[i] = 1;
  }
  const edges: number[] = [];
  for (let i = 0; i <= T; i++) if (boundary[i]) edges.push(i);

  const runWidths: number[] = [];
  for (let e = 0; e < edges.length - 1; e++) {
    const lc = nextContent[edges[e]];
    const rc = prevContent[edges[e + 1]];
    if (lc < edges[e + 1] && rc >= lc) runWidths.push(prefW[rc + 1] - prefW[lc]);
  }
  return { tokens, edges, runWidths, empty: runWidths.length === 0 };
}

/* ---------------- 段内动态规划 ---------------- */

interface Cost {
  ov: number;
  sq: number;
  pen: number;
  k: number;
}
const ZERO_COST: Cost = { ov: 0, sq: 0, pen: 0, k: 0 };
const betterCost = (a: Cost, b: Cost): boolean =>
  a.ov !== b.ov
    ? a.ov < b.ov
    : a.sq !== b.sq
      ? a.sq < b.sq
      : a.pen !== b.pen
        ? a.pen < b.pen
        : a.k < b.k;
const withLine = (a: Cost, w: number, pen: number, maxWidth: number, k: number): Cost => {
  const slack = Math.max(0, maxWidth - w);
  return {
    ov: a.ov + Math.max(0, w - maxWidth),
    sq: a.sq + slack * slack,
    pen: a.pen + pen,
    k,
  };
};

interface CellState {
  cost: Cost;
  /** 上一行起始 token 下标（边），首行为 -1 */
  prev: number;
}

interface SectionPlan {
  section: Section;
  /** 各可行行数 k 对应的最优段代价 */
  options: Map<number, Cost>;
  /** dp[边界位置]：各行数 k → 状态 */
  dp: Map<number, CellState>[];
  edgePos: Map<number, number>;
  /** 贪心（每行尽量多装）的行边界 token 下标 */
  greedyEdges: number[];
  /** 贪心行数（可行时即最少行数） */
  minLines: number;
}

/** 单段边界数量上限：超出后放弃 O(E²·行数) 的 DP，直接用贪心结果（防御异常超长条目）。 */
const MAX_EDGES = 400;

function planSection(section: Section, maxWidth: number, maxLines: number): SectionPlan {
  const { tokens, edges } = section;
  const T = tokens.length;
  const edgePos = new Map<number, number>(edges.map((v, i) => [v, i]));

  const prefW = new Int32Array(T + 1);
  for (let i = 0; i < T; i++) prefW[i + 1] = prefW[i] + tokens[i].w;
  const isContent = (i: number) => i >= 0 && i < T && !tokens[i].tag && !tokens[i].ws;
  const nextContent = new Int32Array(T + 1);
  const prevContent = new Int32Array(T + 1);
  let nx = T;
  for (let i = T; i >= 0; i--) {
    if (isContent(i)) nx = i;
    nextContent[i] = nx;
  }
  let pv = -1;
  for (let i = 0; i <= T; i++) {
    prevContent[i] = pv;
    if (isContent(i)) pv = i;
  }

  /** 行 [p, i) 的量宽与禁则罚分；无可见内容返回 null。 */
  const lineOf = (p: number, i: number): { w: number; pen: number } | null => {
    const lc = nextContent[p];
    const rc = prevContent[i];
    if (lc >= i || rc < lc) return null;
    const w = prefW[rc + 1] - prefW[lc];
    const pen =
      (LINE_START_BAN.has(tokens[lc].text) ? 1 : 0) + (LINE_END_BAN.has(tokens[rc].text) ? 1 : 0);
    return { w, pen };
  };

  // 贪心：从当前行首出发取最后一个不超宽边界；首个边界即超宽时被迫溢出
  const greedyEdges: number[] = [0];
  let ePos = 0;
  while (edges[ePos] < T) {
    let fitPos = -1;
    let anyPos = -1;
    for (let ei = ePos + 1; ei < edges.length; ei++) {
      const line = lineOf(edges[ePos], edges[ei]);
      if (!line) continue;
      if (anyPos < 0) anyPos = ei;
      if (line.w <= maxWidth) fitPos = ei;
      else break; // 宽度单调增，之后只会更宽
    }
    ePos = fitPos >= 0 ? fitPos : anyPos;
    if (ePos < 0) break; // 不可达（防御）
    greedyEdges.push(edges[ePos]);
  }
  const minLines = greedyEdges.length - 1;

  // 边界过多时（异常超长条目）跳过完整 DP，只提供贪心行数
  if (edges.length > MAX_EDGES) {
    let cost = ZERO_COST;
    for (let n = 0; n < greedyEdges.length - 1; n++) {
      const line = lineOf(greedyEdges[n], greedyEdges[n + 1]);
      if (line) cost = withLine(cost, line.w, line.pen, maxWidth, n + 1);
    }
    return {
      section,
      options: minLines <= maxLines ? new Map([[minLines, cost]]) : new Map(),
      dp: [],
      edgePos,
      greedyEdges,
      minLines,
    };
  }

  const dp: Map<number, CellState>[] = new Array(edges.length);
  for (let ei = 0; ei < edges.length; ei++) dp[ei] = new Map();
  dp[0].set(0, { cost: ZERO_COST, prev: -1 });

  for (let b = 1; b < edges.length; b++) {
    const end = edges[b];
    const cell = dp[b];
    for (let a = 0; a < b; a++) {
      const line = lineOf(edges[a], end);
      if (!line) continue;
      for (const [k, st] of dp[a]) {
        const nk = k + 1;
        if (nk > maxLines) continue;
        const cand: CellState = {
          cost: withLine(st.cost, line.w, line.pen, maxWidth, nk),
          prev: edges[a],
        };
        const old = cell.get(nk);
        if (!old || betterCost(cand.cost, old.cost)) cell.set(nk, cand);
      }
    }
  }

  const options = new Map<number, Cost>();
  for (const [k, st] of dp[edges.length - 1]) options.set(k, st.cost);
  return { section, options, dp, edgePos, greedyEdges, minLines };
}

function emptyPlan(section: Section): SectionPlan {
  const T = section.tokens.length;
  return {
    section,
    options: new Map([[1, ZERO_COST]]),
    dp: [],
    edgePos: new Map([
      [0, 0],
      [T, 1],
    ]),
    greedyEdges: [0, T],
    minLines: 1,
  };
}

/** 由选定行数沿 dp 回溯行边界；行数超出 dp 能力时回退贪心结果。 */
function reconstruct(plan: SectionPlan, k: number): number[] {
  const { edges } = plan.section;
  const lastPos = edges.length - 1;
  if (!plan.dp[lastPos]?.has(k)) return plan.greedyEdges;
  const out: number[] = [];
  let ePos = lastPos;
  let lines = k;
  for (;;) {
    out.push(edges[ePos]);
    const st = plan.dp[ePos].get(lines)!;
    const prevEdge = st.prev;
    lines--;
    if (prevEdge === -1) break; // 已回溯到首行起点 edges[0]=0
    ePos = plan.edgePos.get(prevEdge)!;
  }
  out.reverse();
  return out;
}

/** 按行边界拼回文本：裁掉行首尾空白，行内连续空白压缩为单个空格，标签原样保留。 */
function buildLines(section: Section, lineEdges: number[]): BreakLine[] {
  const { tokens } = section;
  if (section.empty) return [{ text: tokens.map((t) => t.text).join('').trim(), width: 0 }];
  const lines: BreakLine[] = [];
  for (let n = 0; n < lineEdges.length - 1; n++) {
    let a = lineEdges[n];
    let b = lineEdges[n + 1];
    while (a < b && tokens[a].ws) a++;
    while (b > a && tokens[b - 1].ws) b--;
    // 行内空白（断点两侧被分到同一行时）压缩为一个空格，避免吞掉词间空白
    const text = tokens
      .slice(a, b)
      .map((t) => t.text)
      .join('')
      .replace(/[^\S\n]+/g, ' ');
    lines.push({ text, width: displayWidth(text) });
  }
  return lines;
}

/* ---------------- 入口 ---------------- */

const resultCache = new Map<string, BreakResult>();
const CACHE_LIMIT = 4000;

export function smartBreak(input: string, opts: BreakOptions): BreakResult {
  const maxWidth = Math.max(1, Math.floor(opts.maxWidth) || 0);
  const maxLines = Math.max(1, Math.floor(opts.maxLines) || 1);
  const text = input.replace(/\r\n?/g, '\n');
  const key = `${maxWidth}|${maxLines}|${opts.lockManual ? 1 : 0}|${text}`;
  const cached = resultCache.get(key);
  if (cached) return cached;

  // 锁定手工换行：按物理行分段；解锁：换行降级为空格，整段参与优化
  const rawSections = opts.lockManual ? text.split('\n') : [text.replace(/\n/g, ' ')];
  const plans: SectionPlan[] = rawSections.map((raw) => {
    const section = buildSection(tokenize(raw));
    return section.empty ? emptyPlan(section) : planSection(section, maxWidth, maxLines);
  });

  let widestRun = 0;
  let minLines = 0;
  for (const p of plans) {
    for (const w of p.section.runWidths) widestRun = Math.max(widestRun, w);
    minLines += p.minLines;
  }
  const unavoidableOverflow = Math.max(0, widestRun - maxWidth);

  // 跨段组合：在总 ≤ maxLines 内分配各段行数，最小化全局代价（背包 DP）
  let global = new Map<number, Cost>();
  global.set(0, ZERO_COST);
  const choices: Map<number, number>[] = []; // 每段：累计行数 → 本段选择行数
  for (const plan of plans) {
    const next = new Map<number, Cost>();
    const choice = new Map<number, number>();
    for (const [used, base] of global) {
      for (const [k, c] of plan.options) {
        const tot = used + k;
        if (tot > maxLines) continue;
        const merged: Cost = {
          ov: base.ov + c.ov,
          sq: base.sq + c.sq,
          pen: base.pen + c.pen,
          k: tot,
        };
        const old = next.get(tot);
        if (!old || betterCost(merged, old)) {
          next.set(tot, merged);
          choice.set(tot, k);
        }
      }
    }
    global = next;
    choices.push(choice);
  }

  let ok = true;
  let reason: FailReason | undefined;
  if (unavoidableOverflow > 0) {
    ok = false;
    reason = 'overflow';
  } else if (global.size === 0 || minLines > maxLines) {
    ok = false;
    reason = 'too-many-lines';
  }

  // 选定每段行数：可行时取全局最优；否则各段贪心（尽力而为，仅供界面提示，不应用）
  const perSectionK: number[] = [];
  if (ok) {
    let bestK = 0;
    let bestCost: Cost | null = null;
    for (const [k, c] of global) {
      if (!bestCost || betterCost(c, bestCost)) {
        bestCost = c;
        bestK = k;
      }
    }
    let tot = bestK;
    for (let s = plans.length - 1; s >= 0; s--) {
      const k = choices[s].get(tot)!;
      perSectionK.unshift(k);
      tot -= k;
    }
  } else {
    for (const p of plans) perSectionK.push(p.minLines);
  }

  const sectionTexts = plans.map((p, idx) =>
    buildLines(p.section, reconstruct(p, perSectionK[idx]))
      .map((l) => l.text)
      .join('\n'),
  );
  const joined = sectionTexts.join('\n');

  const result: BreakResult = {
    ok,
    text: joined,
    lines: joined.split('\n').map((t) => ({ text: t, width: displayWidth(t) })),
    reason,
    unavoidableOverflow,
    widestRun,
    minLines,
  };

  if (resultCache.size > CACHE_LIMIT) resultCache.clear();
  resultCache.set(key, result);
  return result;
}
