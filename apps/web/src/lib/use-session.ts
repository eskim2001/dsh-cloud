import { useQuery } from '@tanstack/react-query'
import { getSession } from './api.js'

export const sessionKey = ['session'] as const

/** 会话是控制台的根状态：登录页与实例页都靠它决定渲染什么。 */
export function useSession() {
  return useQuery({
    queryKey: sessionKey,
    queryFn: getSession,
    staleTime: 30_000,
  })
}
