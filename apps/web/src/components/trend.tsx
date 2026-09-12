/**
 * 手写 SVG 折线，不引图表库——数据就是一条序列，够用。
 *
 * 纵轴按**实测范围**归一化（不是 0 起），否则低负载下曲线会贴成一条直线。
 */
export function Trend({
  label,
  points,
  format,
}: {
  label: string
  points: number[]
  format: (v: number) => string
}) {
  const W = 480
  const H = 56
  const PAD = 4
  const max = points.length === 0 ? 0 : Math.max(...points)
  const min = points.length === 0 ? 0 : Math.min(...points)
  const span = max - min

  // 全平的时候放中间，不然线会贴到顶或底
  const y = (v: number) => (span === 0 ? H / 2 : H - PAD - ((v - min) / span) * (H - PAD * 2))
  const x = (i: number) =>
    points.length === 1 ? W / 2 : PAD + i * ((W - PAD * 2) / (points.length - 1))
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ')
  const last = points[points.length - 1] ?? 0

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {format(last)} · {format(max)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full text-primary" preserveAspectRatio="none">
        {points.length === 1 ? (
          <circle cx={W / 2} cy={y(points[0]!)} r={3} fill="currentColor" />
        ) : (
          <path
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  )
}
