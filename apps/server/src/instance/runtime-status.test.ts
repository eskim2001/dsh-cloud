import { describe, expect, it } from 'vitest'
import { resolveRuntimeStatus, type ContainerStates } from './runtime-status.js'

const row = (over: Partial<{ status: string; containerId: string | null; slug: string }> = {}) => ({
  status: 'running',
  containerId: 'c-1',
  slug: 'alice',
  ...over,
})

const states = (state: string, statusText = 'Up 1 minute'): ContainerStates =>
  new Map([['dsh-instance-alice', { state, statusText }]])

describe('实例状态：DB 记意图，Docker 才是事实', () => {
  it('容器在 crash-loop → restarting，并带上 Docker 的原文', () => {
    const live = states('restarting', 'Restarting (3) 20 seconds ago')
    expect(resolveRuntimeStatus(row(), live)).toEqual({
      status: 'restarting',
      statusText: 'Restarting (3) 20 seconds ago',
    })
  })

  it('容器跑着 → running（DB 说停着也以 Docker 为准）', () => {
    expect(resolveRuntimeStatus(row({ status: 'stopped' }), states('running'))).toEqual({
      status: 'running',
      statusText: 'Up 1 minute',
    })
  })

  it('容器退出了 → stopped（DB 说跑着也以 Docker 为准）', () => {
    expect(resolveRuntimeStatus(row(), states('exited')).status).toBe('stopped')
  })

  it('容器暂停 → paused', () => {
    expect(resolveRuntimeStatus(row(), states('paused')).status).toBe('paused')
  })

  it('容器不在 Docker 里了 → stopped', () => {
    expect(resolveRuntimeStatus(row(), new Map()).status).toBe('stopped')
  })

  it('还没建出容器 → stopped', () => {
    expect(resolveRuntimeStatus(row({ containerId: null }), states('running')).status).toBe(
      'stopped',
    )
  })

  it('取不到实时状态（Docker 抖了）→ 退回 DB 快照，不谎报停止', () => {
    expect(resolveRuntimeStatus(row(), undefined)).toEqual({
      status: 'running',
      statusText: null,
    })
  })

  it('error 不被容器状态盖掉——用户要看得见失败原因', () => {
    expect(resolveRuntimeStatus(row({ status: 'error' }), states('running')).status).toBe('error')
  })

  it('编排进行中（provisioning / removing）不插嘴', () => {
    for (const status of ['provisioning', 'removing']) {
      expect(resolveRuntimeStatus(row({ status }), states('running')).status).toBe(status)
    }
  })
})
