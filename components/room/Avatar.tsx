import { hueOf, initialsOf } from '@/lib/utils'

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const hue = hueOf(name)
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-[9px] font-[family-name:var(--font-mono)] font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.34,
        color: `hsl(${hue} 70% 76%)`,
        background: `hsl(${hue} 55% 16%)`,
        border: `1px solid hsl(${hue} 55% 26%)`,
      }}
    >
      {initialsOf(name)}
    </span>
  )
}
