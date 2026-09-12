import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button.js'
import {
  DialogClose,
  DialogFooter,
} from '@/components/ui/dialog.js'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field.js'
import { Input } from '@/components/ui/input.js'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.js'
import { ApiError, createInstance, listImages } from '@/lib/api.js'
import { formatMb } from '@/lib/format.js'
import { invalidateInstances, keys } from '@/lib/query-keys.js'

const MEMORY_MB_OPTIONS = [2048, 4096, 8192]
const CPU_OPTIONS = [1, 2, 4]
const DISK_MB_OPTIONS = [5120, 10_240, 20_480]

/** 服务端 create 的默认值（见 instance-routes 的 schema），在表单里摆出来当默认。 */
const DEFAULT_MEMORY_MB = 2048
const DEFAULT_CPUS = 1
const DEFAULT_DISK_MB = 10_240
const DEFAULT_PIDS_LIMIT = 512

/**
 * 自助路径的进程数下限。
 *
 * 服务端允许到 1，但**自助的护栏要比管理员紧**（同 D17 的取向：用户磁盘上限 100 GB、管理员 1 TB）——
 * 而且这个值创建后用户自己改不回来（只有管理员能改配额），填 1 等于把实例废掉。
 * 128 够跑 dsh 本身，留着"调大"这个真实需求（重型构建）。
 */
const MIN_PIDS_LIMIT = 128
const MAX_PIDS_LIMIT = 4_096

/** 版本下拉里「不指定」的哨兵值——Select 不接受空字符串。 */
const DEFAULT_IMAGE = '__default__'

/** 镜像引用里的 tag 部分（仓库前缀对所有版本都一样，摆出来只是噪音）。 */
function tagOf(ref: string): string {
  return ref.slice(ref.lastIndexOf(':') + 1)
}

/**
 * 新建实例的表单。**弹窗一关就卸载**，所以状态活在这里而不是列表页。
 *
 * 「不选版本」是一个真实选项（用平台默认版本），不是空值——所以有个 `__default__` 哨兵。
 */
export function CreateInstanceForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [slug, setSlug] = useState('')
  const [memoryMb, setMemoryMb] = useState(DEFAULT_MEMORY_MB)
  const [cpus, setCpus] = useState(DEFAULT_CPUS)
  const [diskMb, setDiskMb] = useState(DEFAULT_DISK_MB)
  const [pids, setPids] = useState(String(DEFAULT_PIDS_LIMIT))
  const [image, setImage] = useState(DEFAULT_IMAGE)

  // 只在弹窗打开时拉：版本列表平时用不上
  const images = useQuery({
    queryKey: keys.createImages,
    queryFn: listImages,
    staleTime: 60_000,
  })

  const pidsLimit = Number(pids)
  const pidsValid =
    Number.isInteger(pidsLimit) && pidsLimit >= MIN_PIDS_LIMIT && pidsLimit <= MAX_PIDS_LIMIT

  const create = useMutation({
    mutationFn: () =>
      createInstance({
        slug: slug.trim(),
        cpus,
        memoryMb,
        diskMb,
        pidsLimit,
        // 没选具体版本就不带这个键，让服务端用平台默认版本（D21）
        ...(image === DEFAULT_IMAGE ? {} : { image }),
      }),
    onSuccess: () => {
      setSlug('')
      setImage(DEFAULT_IMAGE)
      // 新实例在两个列表里都该出现（用户面 + 舰队面）
      invalidateInstances(queryClient)
      onCreated()
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (pidsValid) create.mutate()
  }

  const memoryOptions = MEMORY_MB_OPTIONS.map((mb) => ({
    label: t('instances.gigabytes', { count: mb / 1024 }),
    value: mb,
  }))
  const cpuOptions = CPU_OPTIONS.map((n) => ({
    label: t('instances.cores', { count: n }),
    value: n,
  }))
  const diskOptions = DISK_MB_OPTIONS.map((mb) => ({ label: formatMb(mb), value: mb }))

  const defaultRef = images.data?.default ?? null
  const versionOptions = [
    {
      label:
        defaultRef === null
          ? t('instances.versionDefaultPlain')
          : t('instances.versionDefault', { version: tagOf(defaultRef) }),
      value: DEFAULT_IMAGE,
    },
    // 默认版本已经单列一项，不再重复出现在下面
    ...(images.data?.published ?? [])
      .filter((ref) => ref !== defaultRef)
      .map((ref) => ({ label: tagOf(ref), value: ref })),
  ]

  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="slug">{t('instances.slug')}</FieldLabel>
          <Input
            id="slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value)
              // 输入变了，上一次的失败原因就不作数了
              if (create.isError) create.reset()
            }}
            placeholder={t('instances.slugPlaceholder')}
            pattern="[a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
            minLength={3}
            maxLength={32}
            aria-invalid={create.isError}
            required
          />
          {create.isError ? (
            <p className="text-xs text-destructive">
              {create.error instanceof ApiError
                ? create.error.message
                : t('instances.createFailed')}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">{t('instances.slugHint')}</p>
          )}
        </Field>

        <Field>
          <FieldLabel htmlFor="version">{t('instances.version')}</FieldLabel>
          <Select
            items={versionOptions}
            value={image}
            onValueChange={(value) => {
              if (typeof value === 'string') setImage(value)
            }}
          >
            <SelectTrigger id="version" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {versionOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {images.data !== undefined && images.data.published.length === 0
              ? t('instances.versionEmpty')
              : t('instances.versionHint')}
          </p>
        </Field>

        <div className="flex gap-3">
          <Field className="flex-1">
            <FieldLabel htmlFor="memory">{t('instances.memory')}</FieldLabel>
            <Select
              items={memoryOptions}
              value={memoryMb}
              onValueChange={(value) => {
                if (typeof value === 'number') setMemoryMb(value)
              }}
            >
              <SelectTrigger id="memory" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {memoryOptions.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          <Field className="flex-1">
            <FieldLabel htmlFor="cpu">{t('instances.cpu')}</FieldLabel>
            <Select
              items={cpuOptions}
              value={cpus}
              onValueChange={(value) => {
                if (typeof value === 'number') setCpus(value)
              }}
            >
              <SelectTrigger id="cpu" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {cpuOptions.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field>
          <FieldLabel htmlFor="disk">{t('instances.disk')}</FieldLabel>
          <Select
            items={diskOptions}
            value={diskMb}
            onValueChange={(value) => {
              if (typeof value === 'number') setDiskMb(value)
            }}
          >
            <SelectTrigger id="disk" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {diskOptions.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t('instances.diskHint')}</p>
        </Field>

        <Field>
          <FieldLabel htmlFor="pids">{t('instances.pidsLimit')}</FieldLabel>
          <Input
            id="pids"
            inputMode="numeric"
            value={pids}
            onChange={(e) => setPids(e.target.value)}
            aria-invalid={!pidsValid}
          />
          <p className="text-xs text-muted-foreground">
            {pidsValid
              ? t('instances.pidsHint', { min: MIN_PIDS_LIMIT, max: MAX_PIDS_LIMIT })
              : t('instances.pidsInvalid', { min: MIN_PIDS_LIMIT, max: MAX_PIDS_LIMIT })}
          </p>
        </Field>
      </FieldGroup>

      <DialogFooter className="mt-6">
        <DialogClose render={<Button type="button" variant="outline" />}>
          {t('common.cancel')}
        </DialogClose>
        <Button type="submit" disabled={create.isPending || !pidsValid}>
          {create.isPending ? t('instances.creating') : t('instances.create')}
        </Button>
      </DialogFooter>
    </form>
  )
}
