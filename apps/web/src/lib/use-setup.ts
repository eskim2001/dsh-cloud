import { useQuery } from '@tanstack/react-query'
import { getSetupState } from './api.js'
import { keys } from './query-keys.js'

/**
 * 平台配好域名没有 —— 控制台靠它决定显示 setup 页还是正常界面。
 *
 * `staleTime: Infinity`：这个值在进程活着的期间不会变（配完域名平台自己会重启），
 * 轮询没有意义。`retry: 1`：探针失败时不要把 `App` 卡在加载态太久 ——
 * 拿不到就按"已配置"渲染（见 `App.tsx`），别因为一次网络抖动把整个控制台变成白屏。
 */
export function useSetupState() {
  return useQuery({
    queryKey: keys.setup,
    queryFn: getSetupState,
    staleTime: Infinity,
    retry: 1,
  })
}
