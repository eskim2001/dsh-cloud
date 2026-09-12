import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field.js'
import { Input } from '@/components/ui/input.js'
import type { AdminInstance } from '@/lib/api.js'

/** 一串数字输入 → 数值，只在**全部合法**时才真提交。 */
export interface InstanceQuotaValue {
  cpus: number
  memoryMb: number
  pidsLimit: number
  diskMb: number
}

/**
 * 管理员改实例的资源配额。
 *
 * 上限比用户自助创建的宽（64 核 / 256 GB / 4096 进程 / 1 TB 磁盘）——管理员是"兜底的人"，
 * 不该被自助的护栏挡住。
 *
 * **磁盘现在扩和缩都能在线改**（XFS project quota，见 `docs/storage/README.md`）：
 * 缩容不是拒绝，而是"已用超了新上限就拒绝再写"。
 */
export function InstanceQuotaForm({
  item,
  pending,
  error,
  onSubmit,
}: {
  item: AdminInstance
  pending: boolean
  error: string | null
  onSubmit: (value: InstanceQuotaValue) => void
}) {
  const { t } = useTranslation()
  const [cpus, setCpus] = useState(String(item.cpus))
  const [memoryMb, setMemoryMb] = useState(String(item.memoryMb))
  const [pidsLimit, setPidsLimit] = useState(String(item.pidsLimit))
  const [diskMb, setDiskMb] = useState(String(item.diskMb))

  const value: InstanceQuotaValue = {
    cpus: Number(cpus),
    memoryMb: Number(memoryMb),
    pidsLimit: Number(pidsLimit),
    diskMb: Number(diskMb),
  }
  const valid =
    Number.isFinite(value.cpus) &&
    value.cpus > 0 &&
    value.cpus <= 64 &&
    Number.isInteger(value.memoryMb) &&
    value.memoryMb > 0 &&
    value.memoryMb <= 262_144 &&
    Number.isInteger(value.pidsLimit) &&
    value.pidsLimit > 0 &&
    value.pidsLimit <= 4_096 &&
    Number.isInteger(value.diskMb) &&
    value.diskMb >= 128 &&
    value.diskMb <= 1_048_576
  const dirty =
    value.cpus !== item.cpus ||
    value.memoryMb !== item.memoryMb ||
    value.pidsLimit !== item.pidsLimit ||
    value.diskMb !== item.diskMb

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && dirty) onSubmit(value)
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="quota-cpus">{t('admin.instances.cpus')}</FieldLabel>
          <Input
            id="quota-cpus"
            inputMode="decimal"
            value={cpus}
            onChange={(e) => setCpus(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="quota-memory">{t('admin.instances.memoryMb')}</FieldLabel>
          <Input
            id="quota-memory"
            inputMode="numeric"
            value={memoryMb}
            onChange={(e) => setMemoryMb(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="quota-pids">{t('admin.instances.pidsLimit')}</FieldLabel>
          <Input
            id="quota-pids"
            inputMode="numeric"
            value={pidsLimit}
            onChange={(e) => setPidsLimit(e.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="quota-disk">{t('admin.instances.diskMb')}</FieldLabel>
          <Input
            id="quota-disk"
            inputMode="numeric"
            value={diskMb}
            onChange={(e) => setDiskMb(e.target.value)}
          />
        </Field>
      </FieldGroup>

      {error !== null && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button type="submit" disabled={!dirty || !valid || pending}>
          {t('admin.users.saveQuota')}
        </Button>
      </div>
    </form>
  )
}
